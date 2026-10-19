/**
 * git safety guard：拦下危险的 git 操作与系统破坏性命令。
 *
 * 移植自 `helpers/git-safety-guard.mjs`：正则数组、描述与建议逐字保留。
 * 每条的 `CMD` 前缀把匹配锚定到命令边界，防止把字符串字面量里的同名词
 * （`git commit -m "git reset --hard"`）当命令拦下。
 *
 * @module dsh-tool-guards/guards/gitSafety
 */
import { commandOf, isShellInvocation } from '../shared.js'

/** 与 hooks.json 里这条 guard 的命令对应的脚本文件名。 */
export const script = 'git-safety-guard.mjs'

/** 本 guard 的稳定标识。 */
export const id = 'gitSafety'

/** 命令边界前缀：行首、`;`、`&&`、`||` 之后。 */
const CMD = '(?:^|[;&|]\\s*|&&\\s*|\\|\\|\\s*)'

/** 危险模式：[正则, 人类可读描述, 建议替代]。顺序即报告优先级。 */
const DANGEROUS_PATTERNS = [
  [new RegExp(`${CMD}git\\s+push\\s+.*--force(?!-with-lease)`, 'im'), 'git push --force', '使用 --force-with-lease 更安全'],
  [new RegExp(`${CMD}git\\s+push\\s+-f\\b`, 'im'), 'git push -f', '使用 --force-with-lease 更安全'],
  [new RegExp(`${CMD}git\\s+reset\\s+--hard`, 'im'), 'git reset --hard', '考虑 git stash 或 git reset --soft'],
  [new RegExp(`${CMD}git\\s+clean\\s+-[a-z]*f`, 'im'), 'git clean -f', '先用 git clean -n 预览'],
  [new RegExp(`${CMD}rm\\s+-rf\\s+[/\\\\]`, 'im'), 'rm -rf /', '请指定具体路径'],
  [new RegExp(`${CMD}Remove-Item\\s+.*-Recurse.*-Force\\s+C:\\\\`, 'im'), 'Remove-Item -Recurse -Force C:\\', '请指定具体路径'],
  [new RegExp(`${CMD}Format-Volume`, 'im'), 'Format-Volume', '磁盘格式化不可逆'],
  [new RegExp(`${CMD}mkfs`, 'im'), 'mkfs', '磁盘格式化不可逆'],
  [new RegExp(`${CMD}chmod\\s+-R\\s+777`, 'im'), 'chmod -R 777', '权限过于宽松，使用更精确的权限'],
  [new RegExp(`${CMD}icacls\\s+.*\\/grant\\s+Everyone:F`, 'im'), 'icacls Everyone:F', '权限过于宽松'],
  [new RegExp(`${CMD}git\\s+branch\\s+-D\\b`, 'm'), 'git branch -D', '使用 -d（小写）更安全，已合并才删'],
]

/**
 * 检查一次工具调用。
 * @param toolName - dsh 的工具名。
 * @param args - 工具参数。
 * @returns 拦截原因；放行时返回 undefined。
 */
export function check(toolName, args) {
  if (!isShellInvocation(toolName, args)) return undefined

  const cmd = commandOf(args)
  if (!cmd) return undefined

  for (const [pattern, name, suggestion] of DANGEROUS_PATTERNS) {
    if (!pattern.test(cmd)) continue
    return (
      `🚫 [Git Safety Guard] 已拦下高风险命令：${name}\n` +
      `   完整命令: ${cmd.substring(0, 200)}\n` +
      `   为什么：这类操作可能删除本地工作、改写远端历史或扩大系统权限，失败后很难完整恢复。\n` +
      `   更稳做法: ${suggestion}\n` +
      `   如果用户确实要执行，需要说明具体目标、影响范围和回退方案，再请求授权。`
    )
  }
  return undefined
}

/**
 * SSH 远程写代码的检测正则，逐字移植自原脚本。
 *
 * 为什么单独一条：原脚本对命中的命令**不拦截**，只往 stderr 写一条提醒。
 * 因为远程运维命令（往配置文件里写、改 systemd unit）多数是合法的，
 * 一律拦下来会把正常运维一起挡掉；而"通过 ssh 往远端写代码"又确实该被点一下。
 */
const SSH_WRITE_PATTERN =
  /\bssh\s+\S+.*(?:cat\s*>|tee\s|echo\s.*>|sed\s+-i|vim\s|nano\s|>\s*\S+\.(py|ts|tsx|js|java|cpp|go|rs|sh))/i

/**
 * 「SSH 远程写代码」软提醒。
 *
 * 与原脚本的差异（无法避免）：原机制把提醒写到 stderr，用户当场能看到；
 * dsh 的 guard 只有「拒绝 / 放行」两态，没有"告警但不拦"的通道，所以这里
 * 改成由调用方写日志。**可见性弱于原机制**，这是移植的固有损失，不是实现偷懒。
 *
 * @param toolName - dsh 的工具名。
 * @param args - 工具参数。
 * @returns 提醒文案；不适用时返回 undefined。
 */
export function sshRemoteWriteWarning(toolName, args) {
  if (!isShellInvocation(toolName, args)) return undefined

  const cmd = commandOf(args)
  if (!cmd) return undefined
  if (!SSH_WRITE_PATTERN.test(cmd)) return undefined

  return (
    `⚠️ [Git Safety Guard] 检测到 SSH 远程写代码操作\n` +
    `   命令: ${cmd.substring(0, 200)}\n` +
    `   → 为什么提醒：远程直接写代码会绕开本地测试、diff 和 git 审计，建议本地编辑验证后通过部署流程推送\n` +
    `   → 如果这是运维操作（非代码修改），可忽略此提醒`
  )
}
