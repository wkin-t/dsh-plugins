/**
 * truncation guard：拦下含「代码截断占位符」的写入。
 *
 * 移植自 `helpers/truncation-guard.mjs`。占位符会把真实逻辑写丢，
 * 而且往往要到用户复制或运行时才暴露，定位成本远高于当场拒绝。
 *
 * @module dsh-tool-guards/guards/truncation
 */
import { filePathOf, isWriteTool, textToCheck } from '../shared.js'

/** 与 hooks.json 里这条 guard 的命令对应的脚本文件名。 */
export const script = 'truncation-guard.mjs'

/** 本 guard 的稳定标识。 */
export const id = 'truncation'

/**
 * agent 配置目录（hook/skill/helper 自身）里，截断字符串常常是**测试数据**，
 * 拦它属于误伤，所以整条规则跳过这些路径。
 */
const CONFIG_DIR = /[/\\]\.(claude|dsh|codex|github)[/\\]/i

/**
 * 截断标记：注释风格（//、#、/*、--、<!--）+ 省略号 + 省略语义词。
 * 四条正则是原脚本的原文，覆盖英文、括号形式、中文与方括号形式。
 */
const TRUNCATION_PATTERNS = [
  /(?:\/\/|#|\/\*|--|<!--)\s*\.{2,}\s*(?:rest|remaining|unchanged|existing|same|previous|keep|omit|snip|truncat)/i,
  /(?:\/\/|#|\/\*|--|<!--)\s*\(?\s*(?:rest|remaining|code)\s+(?:unchanged|omitted|remains|stays|same|here)\s*\)?/i,
  /(?:\/\/|#|\/\*|--|<!--)\s*\.{2,}\s*(?:其余|剩余|省略|保持不变|其他代码)/,
  /(?:\/\/|#|\/\*|--|<!--)\s*\[.*(?:rest|remaining|implementation|omitted).*\]/i,
]

/**
 * 检查一次工具调用。
 * @param toolName - dsh 的工具名。
 * @param args - 工具参数。
 * @returns 拦截原因；放行时返回 undefined。
 */
export function check(toolName, args) {
  const content = textToCheck(args)

  // 原脚本是 `!isWriteTool && !content` 才放行：既认工具名，也认「拿到了内容」。
  // 后者是为 apply_patch 之类只带 patch 文本的调用留的后门。
  if (!isWriteTool(toolName) && !content) return undefined

  const filePath = filePathOf(args)
  if (CONFIG_DIR.test(filePath)) return undefined

  // 太短的内容几乎不可能是截断，加这条门槛可以避免把「真的只写一行注释」拦掉。
  if (content.length < 20) return undefined

  for (const pattern of TRUNCATION_PATTERNS) {
    const match = content.match(pattern)
    if (!match) continue
    const lines = content.split('\n')
    const matchLine = lines.find((line) => pattern.test(line)) || match[0]
    return (
      `🚫 [Truncation Guard] 已拦下疑似不完整代码写入\n` +
      `   匹配内容: ${matchLine.trim().substring(0, 100)}\n` +
      `   为什么：占位符会把真实逻辑写丢，用户复制或后续运行时才暴露问题，定位成本很高。\n` +
      `   更稳做法：写入完整代码；文件很长时分多次小范围编辑。`
    )
  }
  return undefined
}
