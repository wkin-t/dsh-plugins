/**
 * 有效工作目录解析（纯逻辑，注入 `workingDirectory` 服务桩）。
 *
 * dsh 0.2.1-rc.2 起提供 `workingDirectory` 服务：
 *
 *   ctx.get('workingDirectory')?.get(session)   // access.optional
 *
 * 它返回 Session **当前有效**的绝对目录：子代理的 cwd、`working_directory`
 * 工具切换后的目录都会反映在这里，而 `session.header.cwd` 仍停留在会话最初的目录。
 * 若只读 header.cwd，子代理会拿父工作区的 slug 去找记忆，导致本可命中的
 * `MEMORY.md` 被漏注（已在 0.2.1-rc.2 实测确认）。
 *
 * 该服务是**可选**服务（must undefined-check），不能写进 `inject` 当硬依赖，
 * 否则缺少该服务的 profile 里插件会永久 PENDING。因此解析顺序为：
 *
 *   1. `workingDirectory.get(agent.session)` 返回的非空字符串（有效目录）
 *   2. `agent.session.header.cwd`（服务缺席/返回空/抛错时的旧行为）
 *   3. `process.cwd()`（连会话目录都没有时的最终兜底）
 *
 * 服务查找、`.get` 调用本身都可能抛错（服务未注册、session 未发布等），
 * 一律按「不可用」处理，绝不向外抛。
 *
 * @module dsh-claude-memory/working-dir
 */

/**
 * 判断值是否为非空字符串（纯空白视为空）。
 * @param value - 候选值。
 * @returns 是否可直接作为目录使用。
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 从宿主 `workingDirectory` 服务读取有效目录。
 * @param workingDirectory - 服务实例；缺席时为 undefined。
 * @param session - 当前 Session。
 * @returns 有效目录，或 undefined（服务不可用/返回空/抛错）。
 */
function readFromService(workingDirectory, session) {
  if (workingDirectory === undefined || workingDirectory === null) return undefined
  if (typeof workingDirectory.get !== 'function') return undefined
  try {
    const directory = workingDirectory.get(session)
    return isNonEmptyString(directory) ? directory : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析当前操作应使用的有效工作目录。
 *
 * @param agent - 当前 agent（只读 `session`）。
 * @param options - 注入依赖。
 * @param options.workingDirectory - 取自 `ctx.get('workingDirectory')` 的服务实例；
 *   缺席时传 undefined（调用方负责 try/catch 查找）。
 * @returns 绝对工作目录：有效目录 → session header cwd → process.cwd()。
 */
export function resolveWorkingDirectory(agent, { workingDirectory } = {}) {
  const session = agent?.session
  const effective = readFromService(workingDirectory, session)
  if (effective !== undefined) return effective

  const headerCwd = session?.header?.cwd
  if (isNonEmptyString(headerCwd)) return headerCwd

  return process.cwd()
}
