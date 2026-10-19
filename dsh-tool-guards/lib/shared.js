/**
 * dsh 的 (toolName, args) → Claude Code hook 脚本看到的 (tool_name, tool_input) 归一。
 *
 * 这些函数逐条移植自 `~/.dsh/claude-hooks/helpers/hook-input.mjs`：差分测试把原脚本
 * 当 oracle 逐字比对，任何"顺手简化"都会立刻表现为判定或文案不一致。
 *
 * 刻意删掉的部分：原文件里为「整个 hook 输入对象」服务的多键猜测
 * （`tool_name`/`toolName`/`tool`/`name`、`tool_input`/`toolInput`/`input`/…）。
 * dsh 直接给 `exec.name` 与 `exec.arguments`，不存在需要猜测的层级；
 * 保留它们只会引入永不执行的死分支。
 *
 * @module dsh-tool-guards/shared
 */

/** 原 hook-input.mjs 的 `asObject`：只接受对象，字符串按 JSON 再试一次，其余归空。 */
export function asObject(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value))
    } catch {
      return {}
    }
  }
  return {}
}

/** 原 hook-input.mjs 的 `firstString`：取第一个非空字符串（数字/布尔按字面转串）。 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return ''
}

/** 原 hook-input.mjs 的 `commandArrayToString`：数组形态的命令拼成一行。 */
function commandArrayToString(value) {
  if (!Array.isArray(value) || value.length === 0) return ''
  return value.map((item) => firstString(item)).filter(Boolean).join(' ')
}

/** 原 hook-input.mjs 的 `firstParsedCommand`：从 parsedCmd/commandActions 取第一条命令。 */
function firstParsedCommand(...values) {
  for (const value of values) {
    if (!Array.isArray(value)) continue
    for (const item of value) {
      const cmd = firstString(asObject(item).cmd, asObject(item).command)
      if (cmd) return cmd
    }
  }
  return ''
}

/**
 * 从工具参数里取命令行，等价于原 `getCommand()` 中作用于 `tool_input` 的那段。
 *
 * 后面的 `argv` / `parsedCmd` / `commandActions` 分支在其他 agent CLI
 * （Codex 的 `shell_command`、Gemini 的 `run_shell_command`）里才出现，对 dsh 的
 * `pwsh`（只有 `command`）是惰性的。保留它们是为了让差分测试能覆盖同一批形状，
 * 也为了让以后接入别的 shell 工具时不必重做归一。
 *
 * @param args - 工具参数对象。
 * @returns 命令行原文；取不到时为空串。
 */
export function commandOf(args) {
  const input = asObject(args)
  const action = asObject(input.action)
  const argv = Array.isArray(input.argv) ? input.argv : []
  const argvCommand = argv.length > 0 ? [input.program, ...argv].filter(Boolean).join(' ') : ''
  return firstString(
    input.command,
    input.cmd,
    input.shellCommand,
    input.script,
    action.command,
    action.cmd,
    commandArrayToString(input.command),
    firstParsedCommand(input.parsedCmd, input.parsed_cmd, input.commandActions, input.command_actions),
    argvCommand,
  )
}

/** 原 hook-input.mjs 的 shell 工具名白名单（`pwsh`/`bash` 是 dsh 的迁移适配）。 */
const SHELL_TOOL_NAME = /^(Bash|PowerShell|Shell|exec|exec_command|shell_command|unified_exec|command\/exec|pwsh|bash|cmd)$/i

/**
 * 判断这次调用是不是 shell 调用。
 *
 * 原实现的第二半是「拿得到命令行就算 shell」——它让 Codex/Claude 的各种命名都能命中。
 * 这里保留同一条兜底，因为 dsh 未来也可能加别的 shell 工具。
 *
 * @param toolName - dsh 的工具名。
 * @param args - 工具参数对象。
 * @returns 是否按 shell 调用处理。
 */
export function isShellInvocation(toolName, args) {
  if (SHELL_TOOL_NAME.test(String(toolName ?? ''))) return true
  return Boolean(commandOf(args))
}

/** 原 hook-input.mjs 的 `isWriteTool`：写文件类工具名（全小写比较）。 */
export function isWriteTool(toolName) {
  return ['write', 'edit', 'multiedit', 'multi_edit', 'apply_patch', 'apply_patch_streaming_events']
    .includes(String(toolName ?? '').toLowerCase())
}

/** 原 hook-input.mjs 的 `pushPath`：空白与 `/dev/null` 不算候选路径。 */
function pushPath(paths, value) {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/dev/null') return
  paths.push(trimmed)
}

/** 原 hook-input.mjs 的 `collectFromPatch`：从 unified diff 文本里抠出目标路径。 */
function collectFromPatch(paths, patch) {
  if (typeof patch !== 'string' || !patch.includes('\n')) return
  const patterns = [
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
    /^\*\*\* Move to: (.+)$/gm,
    /^--- (?:a\/)?(.+)$/gm,
    /^\+\+\+ (?:b\/)?(.+)$/gm,
  ]
  for (const pattern of patterns) {
    for (const match of patch.matchAll(pattern)) pushPath(paths, match[1])
  }
}

/**
 * 取候选文件路径列表（去重、保持出现顺序），等价于原 `getCandidatePaths()`。
 *
 * 顺序即优先级：`file_path` 先于 `path`，所以 dsh 的 `write`/`edit`
 * （只有 `file_path`）与 CC 的 `Write`（`file_path`）落到同一条。
 *
 * @param args - 工具参数对象。
 * @returns 候选路径数组。
 */
export function candidatePaths(args) {
  const input = asObject(args)
  const paths = []
  const scalarKeys = ['file_path', 'filePath', 'relative_path', 'relativePath', 'path', 'filename', 'target_file', 'targetFile']
  const arrayKeys = ['file_paths', 'filePaths', 'files', 'paths']

  for (const key of scalarKeys) pushPath(paths, input[key])
  for (const key of arrayKeys) {
    const value = input[key]
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (typeof item === 'string') pushPath(paths, item)
      else if (item && typeof item === 'object') {
        for (const scalarKey of scalarKeys) pushPath(paths, item[scalarKey])
      }
    }
  }
  collectFromPatch(paths, input.patch ?? input.diff ?? '')
  return [...new Set(paths)]
}

/** 原 hook-input.mjs 的 `getFilePath()`：第一个候选路径。 */
export function filePathOf(args) {
  return candidatePaths(args)[0] ?? ''
}

/**
 * 原 hook-input.mjs 的 `getTextToCheck()`：待检查的「写入内容」。
 *
 * 顺序（new_string → content → text → patch → diff）是照搬的，不是随手排的：
 * `edit` 的 `old_string` 故意不在列表里——检查旧内容毫无意义，而且会误拦
 * 「把截断占位符替换成完整代码」这种正确修复。
 *
 * @param args - 工具参数对象。
 * @returns 待检查文本；没有时为空串。
 */
export function textToCheck(args) {
  const input = asObject(args)
  return firstString(input.new_string, input.content, input.text, input.patch, input.diff)
}
