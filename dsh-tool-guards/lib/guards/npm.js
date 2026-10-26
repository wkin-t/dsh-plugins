/**
 * npm guard：拦下 npm/npx 调用，统一要求走 pnpm。
 *
 * 移植自 `helpers/npm-guard.mjs`，正则、白名单与文案逐字保留。
 * 原文案与判定的每一处措辞都是用户已经习惯的，改动会引起措辞漂移，
 * 因此差分测试把 `reason` 的完全相等作为硬断言。
 *
 * @module dsh-tool-guards/guards/npm
 */
import { commandOf, isShellInvocation } from '../shared.js'

/** 与 hooks.json 里这条 guard 的命令对应的脚本文件名。 */
export const script = 'npm-guard.mjs'

/** 本 guard 的稳定标识。 */
export const id = 'npm'

function extractSubcommand(raw) {
  const cleaned = raw.trim()
  if (!cleaned) return ''
  const argListMatch = cleaned.match(/^["']?([\w:-]+)["']?/)
  return argListMatch?.[1] || ''
}

function stripQuotedStrings(value) {
  return value.replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, '""')
}

function unquote(value) {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function extractPowerShellCommand(value) {
  const match = value.match(/(?:^|\s)-(?:Command|EncodedCommand|c)\s+(?<script>"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^\r\n]+)/i)
  if (!match?.groups?.script) return ''
  if (/(?:^|\s)-EncodedCommand\s+/i.test(match[0])) return ''
  return unquote(match.groups.script)
}

function findDirectInvocation(value) {
  const commandWithoutQuotedStrings = stripQuotedStrings(value)
  return commandWithoutQuotedStrings.match(/(?:^|[;&|]\s*|&&\s*|\|\|\s*)\b(?<tool>npx|npm)(?:\.cmd|\.ps1)?(?:\s+(?<subcommand>[\w:-]+))?/i)
}

function findBlockedInvocation(value) {
  const direct = findDirectInvocation(value)
  if (direct) return direct

  // PowerShell 把真正的命令藏在 -Command 的引号里，先剥引号再查一次。
  const powerShellScript = extractPowerShellCommand(value)
  if (powerShellScript) {
    const nested = findDirectInvocation(powerShellScript)
    if (nested) return nested
  }

  return (
    value.match(/(?:^|\s)-FilePath\s+["']?(?<tool>npx|npm)(?:\.cmd|\.ps1)?["']?(?:\s+-ArgumentList\s+(?<subcommand>[\s\S]*))?/i) ||
    value.match(/(?:^|\s)-ArgumentList\s+[\s\S]*?["'](?:\/c\s+)?(?<tool>npx|npm)(?:\.cmd|\.ps1)?(?:\s+(?<subcommand>[\w:-]+))?/i)
  )
}

function pnpmEquivalent(toolName, verb) {
  if (toolName === 'npx') return 'pnpm dlx <package-or-command>'
  if (!verb) return 'pnpm --help'
  if (verb === 'i' || verb === 'ci') return 'pnpm install'
  if (verb === 'install') return 'pnpm install'
  if (verb === 'exec') return 'pnpm exec'
  if (verb === 'uninstall' || verb === 'remove' || verb === 'rm') return 'pnpm remove'
  if (verb === 'list' || verb === 'ls') return 'pnpm list'
  if (verb === 'root') return 'pnpm root'
  if (verb === 'run' || verb === 'start' || verb === 'test' || verb === 'build') return `pnpm ${verb}`
  return `pnpm ${verb}`
}

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

  const blocked = findBlockedInvocation(cmd)
  if (!blocked) return undefined

  const tool = blocked.groups?.tool?.toLowerCase() || 'npm'
  const subcommand = extractSubcommand(blocked.groups?.subcommand || '')
  const pnpmEquiv = pnpmEquivalent(tool, subcommand)

  // 这里不做 trim：原脚本的 reportBlock() 会 trim，而这些文案首尾都没有空白，
  // 两边因此逐字相等。真出现首尾空白时宁可让差分测试报错，也不要悄悄吃掉差异。
  return (
    `🚫 [npm Guard] 已拦下 ${tool} 命令，请改用 pnpm\n` +
    `   命令: ${cmd.substring(0, 150)}\n` +
    `   为什么：npm 历史上多次出现供应链与安装链路安全问题；统一禁用 npm 可以减少被恶意包、生命周期脚本、锁文件漂移和错误 registry 配置影响的风险。\n` +
    `   为什么连查询类 npm 命令也拦：agent 很容易从 npm root/list/view 过渡到 npm install/run，统一拦在入口能减少习惯性回退到 npm 的概率。\n` +
    `   为什么不用混用：npm 会生成 package-lock.json，和 pnpm-lock.yaml 的依赖解析模型不同，容易让本地、CI、部署环境安装出不一致的依赖树。\n` +
    `   为什么用 pnpm：pnpm 的内容寻址存储和严格依赖隔离更利于复现，也能减少幽灵依赖造成的安全与调试成本。\n` +
    `   更稳做法: ${pnpmEquiv}`
  )
}
