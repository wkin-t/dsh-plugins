/**
 * dsh-claude-memory —— 读取 Claude Code 的 auto memory 索引并注入 dsh 会话上下文。
 *
 * 设计目标：注入结果与 Claude Code 逐字对齐，使未来迁回 CC 只需复制目录。
 * 因此存储格式 100% 沿用 CC，本插件**只读**、不写任何 memory 文件。
 *
 * 算法与运行时契约的证据：
 * - `research/cc-verbatim-strings.md`（claude.exe 字节级还原）
 * - `research/dsh-runtime-contracts.md`（dsh 0.2.0-rc.2 实测）
 * - `research/ac1-verification.md` / `ac2-verification.md` / `ac4-verification.md` / `ac10-verification.md`
 *
 * @module dsh-claude-memory
 */
import { readFile, stat } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { memoryDirFor, projectRootFor, readMemoryIndex, slugFor } from './lib/locate.js'
import { renderMemoryBlock } from './lib/render.js'
import { SOURCE_KIND, lastInjectedPayload, planInjection } from './lib/inject.js'

/** 插件显示名。 */
export const name = 'claude-memory'

/**
 * 必需服务列表。
 *
 * **刻意留空**：`inject` 列出的服务必须全部在场，否则插件永久 PENDING。
 * 本插件只需要读文件，用 `node:fs` 即可，不需要 `fs` 服务在场，
 * 因此不声明任何依赖，从而在任何组合下都能 ACTIVE。
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
 * 解析配置：把 `memoryRoot` 展开为绝对路径，空值落到 `$DSH_HOME/projects`。
 * @param config - 原始插件配置。
 * @returns 归一化后的配置。
 */
function resolveConfig(config) {
  const raw = typeof config?.memoryRoot === 'string' ? config.memoryRoot.trim() : ''
  const memoryRoot = raw.length === 0 ? `${resolveDshHome()}/projects` : expandHomePath(raw)
  return {
    memoryRoot,
    diagnostics: config?.diagnostics !== false,
  }
}

/**
 * 解析当前操作的工作目录。
 *
 * dsh 0.2.0-rc.2 **没有** `workingDirectory` 服务（asar 字节级检索与服务目录均 0 命中），
 * 因此不写"服务存在就用它"的探测分支——那是为不可能发生的状态写的投机回退。
 * 会话 header 的 `cwd` 即权威来源。
 *
 * @param agent - 当前 agent。
 * @returns 绝对工作目录。
 */
function resolveWorkingDirectory(agent) {
  return agent?.session?.header?.cwd ?? process.cwd()
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
 * 装载插件。
 * @param ctx - cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  /** 已发出过诊断的会话，避免每次 pre-step 刷日志。 */
  const diagnosed = new WeakSet()

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
   * 组装本步应注入的消息。
   * @param agent - 当前 agent。
   * @param signal - 取消信号。
   * @returns 待注入的 UserMessage，或 undefined（无内容/已是最新）。
   */
  const compose = async (agent, signal) => {
    signal?.throwIfAborted()
    const cwd = resolveWorkingDirectory(agent)
    const projectRoot = projectRootFor(cwd)
    const { slug, truncated } = slugFor(projectRoot)
    if (truncated) {
      diagnoseOnce(
        agent,
        `slug for ${projectRoot} exceeded 200 chars and was truncated; ` +
          'CC appends a hash36 suffix that is not reproduced here, so the directory may not match',
      )
    }

    const memoryDir = memoryDirFor(resolved.memoryRoot, slug)
    const { memoryPath, text } = await readMemoryIndex(memoryDir, nodeFs, signal)
    if (text === undefined) {
      diagnoseOnce(
        agent,
        `no MEMORY.md at ${memoryPath} (memoryRoot=${resolved.memoryRoot}, slug=${slug}); ` +
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
