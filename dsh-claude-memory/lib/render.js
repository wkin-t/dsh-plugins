/**
 * Claude Code 记忆索引的截断、sanitize、标签中和与渲染。
 *
 * 全部算法来自对 claude.exe v2.1.300 的字节级还原，逐字证据见任务
 * research/cc-verbatim-strings.md。本模块是纯函数，不触碰文件系统。
 *
 * @module dsh-claude-memory/render
 */

/** 索引行数上限（CC `vH`）。 */
export const MAX_LINES = 200

/**
 * 索引长度上限（CC `eae`），单位 **UTF-16 code unit**（JS `String.prototype.length`）。
 *
 * 判别性证据（AC2 夹具 D/E 的 transcript 字节级实测）：
 * - 夹具 D：10000 中文字 = 10000 code unit 但 **30000 UTF-8 字节**，单行 → CC **未截断**
 * - 夹具 E：12299 code unit 但 **36299 字节**，300 行 → CC 只报 `300 lines (limit: 200)`，
 *   **未触发长度截断**
 *
 * 两例都证明判定口径是 **code unit 而非字节**。
 *
 * ⚠️ 不要被提示语里的 `(limit: 24.4KB)` 误导——那是 {@link formatSize} 的**显示**格式
 * （`25000/1024`），与判定单位无关。
 */
export const MAX_CODE_UNITS = 25000

/** 索引文件名。截断提示语里以它作为主语（CC 实测为 `MEMORY.md`）。 */
export const INDEX_FILE_NAME = 'MEMORY.md'

/** 注入前言（CC `Vi`，逐字）。 */
export const PREAMBLE =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. ' +
  'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'

/** AutoMem 通道的后缀（CC `Gi("AutoMem")`，逐字）。 */
export const AUTOMEM_SUFFIX = " (user's auto-memory, persists across conversations)"

/** 包裹标签（CC `Li` / `ds`）。 */
const WRAP_OPEN = '<system-reminder>'
const WRAP_CLOSE = '</system-reminder>'

/**
 * 统计换行符数量（对应 CC 的 `Ft(text, "\n")`）。
 * @param text - 输入文本。
 * @returns 换行符出现次数。
 */
function newlineCount(text) {
  let count = 0
  for (const ch of text) if (ch === '\n') count += 1
  return count
}


/**
 * 计算行数与长度（对应 CC 的 `xft`）。
 *
 * ⚠️ CC 内部把该计数值命名为 `byteCount`，但判别性夹具 D/E 证明它实际是
 * **code unit 数**（`String.prototype.length`）。此处按真实语义命名。
 *
 * @param raw - 原始文本。
 * @returns `{ trimmed, lineCount, codeUnits }`。
 */
export function analyzeIndex(raw) {
  const trimmed = String(raw).trim()
  return {
    trimmed,
    lineCount: trimmed.length === 0 ? 0 : newlineCount(trimmed) + 1,
    codeUnits: trimmed.length,
  }
}

/**
 * 尺寸格式化（对应 CC 的 `Zt`）。
 *
 * AC2 实测：`29999 → "29.3KB"`、`25000 → "24.4KB"`、`58989 → "57.6KB"`，
 * 即 `(n / 1024).toFixed(1) + "KB"`。
 *
 * ⚠️ 输入是 **code unit 数**（与判定口径一致），CC 却按 1024 折算并标 `KB`——
 * 对 ASCII 内容恰好等于字节数，对中文内容则不等。这是 CC 自身的行为，照搬。
 * 该输入单位待夹具 F（30000 中文字）最终确认：若 CC 显示 `87.9KB`（= 90000/1024）
 * 则说明输入其实是字节，需改为传 `Buffer.byteLength`。
 *
 * ⚠️ 截断只在 `> 25000` 时触发，故本函数实际只会收到 ≥ 25000 的输入；
 * 更小量级下 CC 是否切换单位（如 `B`）**未验证**。
 *
 * @param n - code unit 数。
 * @returns 文本形式。
 */
function formatSize(n) {
  return `${(n / 1024).toFixed(1)}KB`
}

/**
 * 截断提示中引用的下一行片段（对应 CC 的 `WM(text, 80)`）。
 *
 * ⚠️ `WM` 的确切省略策略尚未还原，此处按「超长则截断并加省略号」实现。
 * @param text - 片段。
 * @param max - 上限。
 * @returns 可能被省略的片段。
 */
function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * 按 CC 的 `j1n` 截断索引，超限时追加逐字提示。
 *
 * 阈值取先到者：**200 行** 或 **25000 code unit**。
 * 提示以 markdown 引用块追加，**其前空一行**：`\n\n> WARNING: <正文>`。
 *
 * 提示语三条分支全部来自 AC2 夹具 transcript 的字节级实测：
 * - 仅行超限：`MEMORY.md is 250 lines (limit: 200). Only part of it was loaded: …`
 * - 仅长度超限：`MEMORY.md is 29.3KB (limit: 24.4KB) — index entries are too long. Only part of it was loaded: …`
 * - 两者超限：`MEMORY.md is 300 lines and 57.6KB. Only part of it was loaded: …`
 *
 * @param raw - `MEMORY.md` 原文。
 * @returns `{ content, lineCount, codeUnits, wasLineTruncated, wasSizeTruncated }`。
 */
export function truncateIndex(raw) {
  const { trimmed, lineCount, codeUnits } = analyzeIndex(raw)
  const overLines = lineCount > MAX_LINES
  const overSize = codeUnits > MAX_CODE_UNITS
  if (!overLines && !overSize) {
    return {
      content: trimmed,
      lineCount,
      codeUnits,
      wasLineTruncated: false,
      wasSizeTruncated: false,
    }
  }

  let w = overLines ? trimmed.split('\n').slice(0, MAX_LINES).join('\n') : trimmed
  if (w.length > MAX_CODE_UNITS) {
    const breakAt = w.lastIndexOf('\n', MAX_CODE_UNITS)
    w = w.slice(0, breakAt > 0 ? breakAt : MAX_CODE_UNITS)
  }

  const consumedLines = trimmed[w.length] === '\n' ? newlineCount(w) + 1 : 0
  const nextLineStart = w.length + 1
  const nextLineEnd = trimmed.indexOf('\n', nextLineStart)
  const nextLine = trimmed.slice(nextLineStart, nextLineEnd < 0 ? undefined : nextLineEnd).trim()

  const cutDetail =
    consumedLines === 0
      ? `everything after the first ${w.length} characters of line 1 was cut off`
      : `${lineCount - consumedLines} of ${lineCount} lines were cut off, starting at line ${consumedLines + 1}` +
        (nextLine.length > 0 ? ` ("${clip(nextLine, 80)}")` : '')

  const measured =
    overSize && !overLines
      ? `${formatSize(codeUnits)} (limit: ${formatSize(MAX_CODE_UNITS)}) \u2014 index entries are too long`
      : overLines && !overSize
        ? `${lineCount} lines (limit: ${MAX_LINES})`
        : `${lineCount} lines and ${formatSize(codeUnits)}`

  const warning =
    `${INDEX_FILE_NAME} is ${measured}. Only part of it was loaded: ${cutDetail}. ` +
    'Keep index entries to one line under ~200 chars; move detail into topic files.'

  return {
    content: `${w}\n\n> WARNING: ${warning}`,
    lineCount,
    codeUnits,
    wasLineTruncated: overLines,
    wasSizeTruncated: overSize,
  }
}

/**
 * 转义字面 `</system-reminder>`（对应 CC 的 `inn`）。
 *
 * 用 HTML 实体（`&lt;` / `&gt;`），**不是**反斜杠——CC 里存在两套互不相同的转义机制，
 * 反斜杠那套（`Aae`，插在 `<` 之后）经 98 个样本验证**不在 AutoMem 路径上**，故未实现。
 *
 * ⚠️ 本转义本身也**未经样本验证**（98 个样本与全部截断夹具的内容都不含该字面量），
 * 保留它是为防止注入块被内容里的字面闭合标签提前截断；对已知样本均为空操作。
 *
 * @param text - 输入文本。
 * @returns 转义后的文本。
 */
export function escapeClosingReminderTag(text) {
  return String(text).replace(/<\s*\/\s*system-reminder\s*>/gi, '&lt;/system-reminder&gt;')
}

/**
 * 用 `<system-reminder>` 包裹正文。
 *
 * 模板：`<system-reminder>\n` + 正文 + `\n</system-reminder>`。
 * 该形态由 CC transcript 的 `$.rendered[0].content` 字节级确认。
 *
 * ⚠️ 注意 `claude.exe` 里同形态的 `Two()` 是**后台任务通知**的包裹器
 * （`Tut()` 会前置 `[SYSTEM NOTIFICATION - NOT USER INPUT]`），**不是**指令块包裹器。
 * 指令块的真实包裹函数尚未定位；此处以观测字节为准。
 *
 * @param body - 正文。
 * @returns 包裹后的文本。
 */
export function wrapSystemReminder(body) {
  return `${WRAP_OPEN}\n${escapeClosingReminderTag(body)}\n${WRAP_CLOSE}`
}

/**
 * 渲染最终注入文本。
 *
 * 管线：`truncateIndex`（含 `.trim()`）→ 前言 + `\n\n` + `Contents of …:` + `\n\n` + 内容
 *      → `<system-reminder>` 包裹。
 *
 * ⚠️ **不对内容做 sanitize 或标签中和。** 这是对 CC 全部 98 个 transcript 注入样本
 * 逐字验证的结论：`表头 + "\n\n" + 原文.trim()` 与 CC 真实注入 **98/98 完全相等**，
 * 其中包含带 `\r\n` 的文件——任何 CRLF 归一化都会让这 98 个样本全部失配。
 *
 * `claude.exe` 里确实还原出过 `s()`（CRLF 归一化 + 控制字符丢弃）与 `Aae()`（标签中和），
 * 但**它们不在 AutoMem 这条注入路径上**，故本模块不实现它们。
 * 逐字源码见任务文档 `research/cc-verbatim-strings.md` §2 与 §5。
 *
 * ⚠️ 前言有**三种变体**（实测）：初次注入用 {@link PREAMBLE}；另有
 * 「会话启动重读」与「压缩后重读」两种变体，只发送发生变化的文件并声明前言已在上文生效。
 * 本插件只实现**初次注入**形态，重读变体未实现（见 README「已知偏差」）。
 *
 * @param memoryPath - `MEMORY.md` 绝对路径（写入 `Contents of` 行）。
 * @param raw - `MEMORY.md` 原文。
 * @returns 注入文本；内容为空时返回 undefined（调用方应注入 0 字节）。
 */
export function renderMemoryBlock(memoryPath, raw) {
  const { content } = truncateIndex(raw)
  if (content.length === 0) return undefined
  const withPreamble = `${PREAMBLE}\n\nContents of ${memoryPath}${AUTOMEM_SUFFIX}:\n\n${content}`
  return wrapSystemReminder(withPreamble)
}
