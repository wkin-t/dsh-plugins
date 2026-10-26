/**
 * deprecated guard：拦下对「废弃目录」的写入。
 *
 * 移植自 `helpers/deprecated-guard.mjs`。`_deprecated/`、`deprecated/`、`legacy/`
 * 通常只剩历史实现，改那里等于改一段不再运行的代码，白花时间还可能误导排查。
 *
 * @module dsh-tool-guards/guards/deprecated
 */
import { filePathOf, isWriteTool } from '../shared.js'

/** 与 hooks.json 里这条 guard 的命令对应的脚本文件名。 */
export const script = 'deprecated-guard.mjs'

/** 本 guard 的稳定标识。 */
export const id = 'deprecated'

const DEPRECATED_PATTERN = /[/\\]_deprecated[/\\]|[/\\]deprecated[/\\]|[/\\]legacy[/\\]/i

/**
 * agent 自己的配置目录里也可能有叫 legacy 的目录，那不是项目的废弃实现。
 * node_modules 同理：第三方包里的旧目录不该由本项目规则管。
 */
const EXCLUDED_PATHS = /[/\\]\.(?:agents?|claude|dsh|codex|github)[/\\]|[/\\]node_modules[/\\]/i

/**
 * 检查一次工具调用。
 * @param toolName - dsh 的工具名。
 * @param args - 工具参数。
 * @returns 拦截原因；放行时返回 undefined。
 */
export function check(toolName, args) {
  if (!isWriteTool(toolName)) return undefined

  const filePath = filePathOf(args)
  if (!DEPRECATED_PATTERN.test(filePath)) return undefined
  if (EXCLUDED_PATHS.test(filePath)) return undefined

  return (
    `🚫 [Deprecated Guard] 已拦下对废弃目录的写入\n` +
    `   文件: ${filePath}\n` +
    `   为什么：_deprecated/、legacy/ 通常只保留历史实现；继续改这里容易修到不再运行的代码。\n` +
    `   更稳做法：先找到当前生效的实现位置，再在那里修改。\n` +
    `   如果不确定现役路径，先说明查到的候选位置再确认。`
  )
}
