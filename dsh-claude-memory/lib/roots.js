/**
 * Claude Code 记忆根目录（memoryRoot）的解析策略。
 *
 * 背景：本插件最初按 Windows 工作流把默认根定为 `$DSH_HOME/projects`，并在迁移后
 * 把 `~/.claude/projects` 的内容整体搬过去。macOS 上 DSH 与 Claude Code 并存，
 * `$DSH_HOME/projects` 通常**不存在**，而 CC 的真实 auto-memory 仓库
 * `~/.claude/projects` 已经存在且有数据。为了让插件开箱即用、同时不破坏
 * 「迁移到 $DSH_HOME/projects」的既定方向，解析顺序定为：
 *
 * 1. **显式配置的 `memoryRoot`**（最高优先级；即使目录不存在也尊重用户选择，
 *    因为用户可能是在等目录稍后出现，或指向网络盘）
 * 2. `$DSH_HOME/projects`（若存在）——迁移完成后的首选位置
 * 3. `~/.claude/projects`（若存在）——macOS 上 CC 的真实 store，只读复用
 * 4. `$DSH_HOME/projects`（兜底，与旧行为一致；由调用方发既有诊断）
 *
 * 本模块**只决定根目录**，不改变 slug 定位算法：
 * 「严格使用算法 slug、不做归一化回退」的规则仍由 `lib/locate.js` 独立负责。
 *
 * 纯逻辑 + 注入 `exists` 谓词，因此不依赖 dsh 运行时、也不直接碰文件系统，
 * 可在 `node --test` 下逐个分支验证。
 *
 * @module dsh-claude-memory/roots
 */
import { join } from 'node:path'

/** memoryRoot 的来源，供诊断与单测使用。 */
export const ROOT_SOURCE = Object.freeze({
  /** 用户显式配置。 */
  CONFIGURED: 'configured',
  /** `$DSH_HOME/projects` 存在。 */
  DSH_PROJECTS: 'dsh-projects',
  /** `$DSH_HOME/projects` 不存在，回退到 `~/.claude/projects`。 */
  CLAUDE_PROJECTS: 'claude-projects',
  /** 两者都不存在，兜底到 `$DSH_HOME/projects`。 */
  DSH_PROJECTS_FALLBACK: 'dsh-projects-fallback',
})

/**
 * `$DSH_HOME/projects` 的绝对路径。
 * @param dshHome - 已解析的 `$DSH_HOME` 绝对路径。
 * @returns 绝对路径。
 */
export function dshProjectsRoot(dshHome) {
  return join(dshHome, 'projects')
}

/**
 * `~/.claude/projects` 的绝对路径。
 * @param homeDir - 操作系统用户主目录绝对路径。
 * @returns 绝对路径。
 */
export function claudeProjectsRoot(homeDir) {
  return join(homeDir, '.claude', 'projects')
}

/**
 * 调用注入的 `exists` 谓词；任何异常都按「不存在」处理。
 *
 * 根目录探测发生在会话路径上，让一个权限错误或符号链接异常把整块记忆注入
 * 打挂不值得——探测失败退化为旧默认根，行为可预期。
 *
 * @param exists - 注入的存在性谓词。
 * @param path - 待探测路径。
 * @returns 是否存在（含异步）。
 */
async function existsQuietly(exists, path) {
  try {
    return Boolean(await exists(path))
  } catch {
    return false
  }
}

/**
 * 按文档化的顺序解析 memoryRoot。
 *
 * @param input - 解析输入。
 * @param input.configured - 显式配置的根（已展开 `~`；空串/空白表示未配置）。
 * @param input.dshHome - `$DSH_HOME` 绝对路径。
 * @param input.homeDir - 用户主目录绝对路径。
 * @param input.exists - 注入的存在性谓词，接收绝对路径，返回 boolean 或 Promise<boolean>。
 * @returns `{ memoryRoot, source, candidates }`：
 *   `memoryRoot` 为选中根；`source` 取自 {@link ROOT_SOURCE}；
 *   `candidates` 保留两个默认候选路径，便于调用方诊断。
 */
export async function resolveMemoryRoot({ configured, dshHome, homeDir, exists }) {
  const dshProjects = dshProjectsRoot(dshHome)
  const claudeProjects = claudeProjectsRoot(homeDir)
  const candidates = { dshProjects, claudeProjects }
  const explicit = typeof configured === 'string' ? configured.trim() : ''

  if (explicit.length > 0) {
    return { memoryRoot: explicit, source: ROOT_SOURCE.CONFIGURED, candidates }
  }
  if (await existsQuietly(exists, dshProjects)) {
    return { memoryRoot: dshProjects, source: ROOT_SOURCE.DSH_PROJECTS, candidates }
  }
  if (await existsQuietly(exists, claudeProjects)) {
    return { memoryRoot: claudeProjects, source: ROOT_SOURCE.CLAUDE_PROJECTS, candidates }
  }
  return { memoryRoot: dshProjects, source: ROOT_SOURCE.DSH_PROJECTS_FALLBACK, candidates }
}
