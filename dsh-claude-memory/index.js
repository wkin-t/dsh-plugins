/**
 * dsh-claude-memory —— 读取 Claude Code 的 auto memory 索引并注入 dsh 会话上下文。
 *
 * 设计目标：注入结果与 Claude Code 逐字对齐，使未来迁回 CC 只需复制目录。
 * 因此存储格式 100% 沿用 CC，本插件**只读**、不写任何 memory 文件。
 *
 * 算法与运行时契约的证据：
 * - `research/cc-verbatim-strings.md`（claude.exe 字节级还原）
 * - `research/dsh-runtime-contracts.md`（dsh 0.2.0-rc.2 实测；0.2.1-rc.2 起
 *   新增可选的 `workingDirectory` 服务，见 `lib/working-dir.js`）
 * - `research/ac1-verification.md` / `ac2-verification.md` / `ac4-verification.md` / `ac10-verification.md`
 *
 * @module dsh-claude-memory
 */
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { memoryDirFor, projectRootFor, readMemoryIndex, slugFor } from './lib/locate.js'
import { renderMemoryBlock } from './lib/render.js'
import { SOURCE_KIND, lastInjectedPayload, planInjection } from './lib/inject.js'
import {
  ROOT_SOURCE,
  dshProjectsRoot,
  resolveMemoryRoot,
} from './lib/roots.js'
import { resolveWorkingDirectory } from './lib/working-dir.js'

/** 插件显示名。 */
export const name = 'claude-memory'

/**
 * 必需服务列表。
 *
 * **刻意留空**：`inject` 列出的服务必须全部在场，否则插件永久 PENDING。
 * 本插件只需要读文件，用 `node:fs` 即可，不需要 `fs` 服务在场。
 * 0.2.1-rc.2 的 `workingDirectory` 也是**可选**服务（`ctx.get` + 判空），
 * 缺席时回退 session header `cwd`，因此同样声明为硬依赖会破坏「任何组合都 ACTIVE」。
 */
export const inject = []


/** 单次读取的大小上限，避免异常大文件拖垮 pre-step（评审 M6）。 */
const MAX_INDEX_BYTES = 8 * 1024 * 1024

/** 插件配置 schema。 */
export const Config = z.object({
  memoryRoot: z.string().default(''),
  diagnostics: z.boolean().default(true),
})

/**
 * 解析配置：展开 `memoryRoot` 里的 `~`，空值表示「未配置」。
 *
 * 空值不在这里落到 `$DSH_HOME/projects`——具体根目录由
 * {@link resolveMemoryRoot} 在运行时按「配置 → `$DSH_HOME/projects` →
 * `~/.claude/projects` → `$DSH_HOME/projects`」的顺序探测。
 *
 * @param config - 原始插件配置。
 * @returns 归一化后的配置。
 */
function resolveConfig(config) {
  const raw = typeof config?.memoryRoot === 'string' ? config.memoryRoot.trim() : ''
  return {
    configuredMemoryRoot: raw.length === 0 ? '' : expandHomePath(raw),
    diagnostics: config?.diagnostics !== false,
  }
}

/**
 * 只读文件系统适配器。
 *
 * 刻意使用 `node:fs` 而非 `ctx.fs`：读取不受沙箱限制（`fs-sandbox` 只栅栏写入），
 * 而 `ctx.fs` 的 `stat` 返回结构（`FsInfo`）在本次调研中未能确证，
 * 猜错会让定位逻辑静默失效。`node:fs` 的 `Stats` 语义确定，不会产生这类风险。
 */
const nodeFs = {
  async stat(path) {
    try {
      const info = await stat(path)
      if (info.isDirectory()) return { kind: 'directory' }
      if (info.isFile()) return { kind: 'file', size: info.size }
      return { kind: 'other' }
    } catch {
      return undefined
    }
  },
  async readText(path) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  },
}

/**
 * 目录存在性谓词，注入给 {@link resolveMemoryRoot}。
 *
 * 任何异常（权限不足、断链、父目录不是目录等）一律视为「不存在」：
 * 根目录探测发生在会话路径上，不值得让它把整块记忆注入打挂。
 *
 * @param path - 待探测路径。
 * @returns 是否为已存在的目录。
 */
async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 装载插件。
 * @param ctx - cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  /** 已发出过诊断的会话，避免每次 pre-step 刷日志。 */
  const diagnosed = new WeakSet()

  /**
   * 根目录不是默认位置时提示一次（每个插件实例一次，不按会话刷屏）。
   * @param root - {@link resolveMemoryRoot} 的结果。
   */
  const logRootSource = (root) => {
    if (root.source === ROOT_SOURCE.CLAUDE_PROJECTS) {
      ctx.logger?.info?.(
        `claude-memory: $DSH_HOME/projects not found; using Claude Code store at ${root.memoryRoot} ` +
          '(set memoryRoot to override)',
      )
    } else if (root.source === ROOT_SOURCE.DSH_PROJECTS_FALLBACK) {
      ctx.logger?.info?.(
        'claude-memory: neither $DSH_HOME/projects nor ~/.claude/projects exists; ' +
          `defaulting to ${root.memoryRoot}`,
      )
    }
  }

  /** 解析后的 memoryRoot 只算一次（需要探测两处目录是否存在）。 */
  let memoryRootPromise

  /**
   * 解析并缓存 memoryRoot；探测本身已容错，这里再兜一层，确保插件永不因此失效。
   * @returns {@link resolveMemoryRoot} 的结果。
   */
  const resolveRootOnce = () => {
    if (memoryRootPromise !== undefined) return memoryRootPromise
    memoryRootPromise = resolveMemoryRoot({
      configured: resolved.configuredMemoryRoot,
      dshHome: resolveDshHome(),
      homeDir: homedir(),
      exists: directoryExists,
    })
      .then((root) => {
        if (resolved.diagnostics) logRootSource(root)
        return root
      })
      .catch((error) => {
        // 极端情况（如 resolveDshHome 内部异常）：退回旧默认根，交给既有诊断说明 0 字节。
        ctx.logger?.warn?.('claude-memory: memoryRoot resolution failed: %o', error)
        return {
          memoryRoot: dshProjectsRoot(resolveDshHome()),
          source: ROOT_SOURCE.DSH_PROJECTS_FALLBACK,
          candidates: {},
        }
      })
    return memoryRootPromise
  }

  /**
   * 每个会话只记一次诊断，使"0 字节注入"与"插件 bug"可区分（R10）。
   * @param agent - 当前 agent。
   * @param message - 诊断内容。
   */
  const diagnoseOnce = (agent, message) => {
    if (!resolved.diagnostics) return
    const key = agent?.session ?? agent
    if (key === undefined || diagnosed.has(key)) return
    diagnosed.add(key)
    ctx.logger?.info?.(`claude-memory: ${message}`)
  }

  /**
   * 查找宿主**可选**的 `workingDirectory` 服务。
   *
   * 0.2.1-rc.2 里它的 access 是 optional（`ctx.get("workingDirectory")` 后需判空），
   * 且服务未注册时 `ctx.get` 本身也可能抛错；两种情况都按「不可用」处理，
   * 由 {@link resolveWorkingDirectory} 回退到 session header cwd / process.cwd()。
   * 不写进 `inject`，插件才能在任何 profile 下保持 ACTIVE。
   *
   * @returns 服务实例，或 undefined。
   */
  const lookupWorkingDirectory = () => {
    try {
      return ctx.get?.('workingDirectory')
    } catch {
      return undefined
    }
  }

  /**
   * 组装本步应注入的消息。
   * @param agent - 当前 agent。
   * @param signal - 取消信号。
   * @returns 待注入的 UserMessage，或 undefined（无内容/已是最新）。
   */
  const compose = async (agent, signal) => {
    signal?.throwIfAborted()
    // memoryRoot 只解析一次；解析结果决定后续所有步骤读取哪个根。
    const root = await resolveRootOnce()
    signal?.throwIfAborted()
    // 用宿主报告的有效目录：子代理 / working_directory 工具切换后，它可能与
    // session header 的 cwd 不同；只读 header 会按错误 slug 查找而漏注入。
    const cwd = resolveWorkingDirectory(agent, { workingDirectory: lookupWorkingDirectory() })
    const projectRoot = projectRootFor(cwd)
    const { slug, truncated } = slugFor(projectRoot)
    if (truncated) {
      diagnoseOnce(
        agent,
        `slug for ${projectRoot} exceeded 200 chars and was truncated; ` +
          'CC appends a hash36 suffix that is not reproduced here, so the directory may not match',
      )
    }

    const memoryDir = memoryDirFor(root.memoryRoot, slug)
    const { memoryPath, text } = await readMemoryIndex(memoryDir, nodeFs, signal)
    if (text === undefined) {
      diagnoseOnce(
        agent,
        `no MEMORY.md at ${memoryPath} ` +
          `(memoryRoot=${root.memoryRoot}, rootSource=${root.source}, slug=${slug}); ` +
          'injecting nothing — this is expected when the project has no auto memory',
      )
      return undefined
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_INDEX_BYTES) {
      diagnoseOnce(agent, `MEMORY.md at ${memoryPath} exceeds ${MAX_INDEX_BYTES} bytes; skipped`)
      return undefined
    }

    const rendered = renderMemoryBlock(memoryPath, text)
    if (rendered === undefined) {
      diagnoseOnce(agent, `MEMORY.md at ${memoryPath} is empty after trim; injecting nothing`)
      return undefined
    }
    return createUserMessage({
      content: [{ type: 'text', text: rendered }],
      source: { kind: SOURCE_KIND, form: 'instructions' },
    })
  }

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    try {
      signal?.throwIfAborted()
      const desired = await compose(agent, signal)
      return planInjection({
        decision,
        step,
        claimedMessages: messages,
        desired,
        latest: lastInjectedPayload(agent, decision.messages),
      })
    } catch (error) {
      // pre-step 抛异常会让当前 turn 失败，且输入已被 claim，代价高于"少一块记忆"。
      // 因此这里吞掉并原样返回下游决策。
      ctx.logger?.warn?.('claude-memory: injection failed: %o', error)
      return decision
    }
  })
}
