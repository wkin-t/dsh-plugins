/**
 * python guard：win32 拦裸 `python3`，其他平台拦裸 `python`。
 *
 * 移植自 `helpers/python-cmd-guard.mjs`。远程上下文（ssh / docker exec /
 * kubectl exec / wsl）里的 python 不检查——那些解释器由远端决定，
 * 拿本机规则去管只会误拦运维命令。
 *
 * @module dsh-tool-guards/guards/pythonCmd
 */
import { commandOf, isShellInvocation } from '../shared.js'

/** 与 hooks.json 里这条 guard 的命令对应的脚本文件名。 */
export const script = 'python-cmd-guard.mjs'

/** 本 guard 的稳定标识。 */
export const id = 'pythonCmd'

/**
 * 从命令里剥离远程命令段，把每段替换成占位符 `REMOTE`。
 *
 * 逐字移植原实现（逐字符状态机）：引号内的 `&&`/`;` 不算命令段边界，
 * 否则 `ssh host "a && python3 x"` 会被误判成本地 python3。
 *
 * @param input - 命令行原文。
 * @returns 剥离远程段后的命令。
 */
function stripRemoteCommands(input) {
  let result = ''
  let i = 0
  while (i < input.length) {
    const remaining = input.substring(i)
    const remoteMatch = remaining.match(/^(ssh|docker\s+exec|kubectl\s+exec|wsl)\s/i)
    if (remoteMatch) {
      let j = i + remoteMatch[0].length
      let inDouble = false
      let inSingle = false
      let escaped = false
      while (j < input.length) {
        const ch = input[j]
        if (escaped) { escaped = false; j++; continue }
        if (ch === '\\') { escaped = true; j++; continue }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; j++; continue }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; j++; continue }
        if (!inDouble && !inSingle) {
          if ((ch === '&' && input[j + 1] === '&') || (ch === '|' && input[j + 1] === '|')) break
          if (ch === ';') break
        }
        j++
      }
      result += 'REMOTE'
      i = j
    } else {
      result += input[i]
      i++
    }
  }
  return result
}

/** venv 里的 python3 是项目自己的解释器，拦它没有意义。 */
const VENV_PATH = /[/\\]\.?venv[/\\]/i

/**
 * 按给定平台判定，供测试直接验另一条平台分支。
 * @param platform - `process.platform` 的取值。
 * @param toolName - dsh 的工具名。
 * @param args - 工具参数。
 * @returns 拦截原因；放行时返回 undefined。
 */
export function checkForPlatform(platform, toolName, args) {
  if (!isShellInvocation(toolName, args)) return undefined

  const cmd = commandOf(args)
  if (!cmd) return undefined

  const localCmd = stripRemoteCommands(cmd)

  if (platform === 'win32') {
    if (/(?:^|[;&|]\s*|&&\s*|\|\|\s*)python3\s/m.test(localCmd) && !VENV_PATH.test(localCmd)) {
      return (
        `🚫 [Python Cmd Guard] 已拦下 Windows 本地 python3 命令\n` +
        `   命令: ${cmd.substring(0, 150)}\n` +
        `   为什么：这台 Windows 环境通常只有 python 启动器；python3 容易找不到命令，或者误打到 WSL/远程语义。\n` +
        `   更稳做法：本地命令用 python；远程/WSL 命令已在检测前剥离，不会误拦。`
      )
    }
    return undefined
  }

  if (/(?:^|[;&|]\s*|&&\s*|\|\|\s*)python\s(?!3)/m.test(localCmd) && !VENV_PATH.test(localCmd)) {
    return (
      `🚫 [Python Cmd Guard] 已拦下 macOS/Linux 上的裸 python 命令\n` +
      `   命令: ${cmd.substring(0, 150)}\n` +
      `   为什么：python 在 Unix 环境可能指向 Python 2、缺失，或和项目 venv 预期不一致。\n` +
      `   更稳做法：用 python3；如果已在 venv 中可按 venv 约定执行。`
    )
  }
  return undefined
}

/**
 * 检查一次工具调用。
 * @param toolName - dsh 的工具名。
 * @param args - 工具参数。
 * @returns 拦截原因；放行时返回 undefined。
 */
export function check(toolName, args) {
  return checkForPlatform(process.platform, toolName, args)
}
