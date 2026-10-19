import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_CODE_UNITS,
  MAX_LINES,
  analyzeIndex,
  escapeClosingReminderTag,
  renderMemoryBlock,
  truncateIndex,
} from '../lib/render.js'

test('escapeClosingReminderTag: 用 HTML 实体而非反斜杠（对应 CC 的 inn）', () => {
  assert.equal(escapeClosingReminderTag('x</system-reminder>y'), 'x&lt;/system-reminder&gt;y')
})

test('analyzeIndex: 行数为换行数 + 1，长度为 code unit 数', () => {
  assert.deepEqual(analyzeIndex('a\nb\nc'), { trimmed: 'a\nb\nc', lineCount: 3, codeUnits: 5 })
})

test('analyzeIndex: 空内容行数为 0', () => {
  assert.equal(analyzeIndex('   \n  ').lineCount, 0)
})

test('truncate: 未超限时原样返回（仅 trim）', () => {
  const result = truncateIndex('  - a\n- b  \n')
  assert.equal(result.content, '- a\n- b')
  assert.equal(result.wasLineTruncated, false)
  assert.equal(result.wasSizeTruncated, false)
})

// 以下三条与 CC transcript 的字节级实测逐字对齐（AC2 夹具 A/B/C）。
// 若改动提示语，这三条会失败——这是刻意的，防止静默漂移。

test('truncate: 仅行超限 —— 与 CC 实测逐字一致（夹具 A）', () => {
  const raw = Array.from({ length: 250 }, (_, i) => `- [entry ${i}](e${i}.md) — hook line ${i}`).join('\n')
  const result = truncateIndex(raw)
  assert.equal(result.wasLineTruncated, true)
  assert.equal(result.wasSizeTruncated, false)
  assert.ok(
    result.content.endsWith(
      '\n\n> WARNING: MEMORY.md is 250 lines (limit: 200). Only part of it was loaded: ' +
        '50 of 250 lines were cut off, starting at line 201 ' +
        '("- [entry 200](e200.md) — hook line 200"). ' +
        'Keep index entries to one line under ~200 chars; move detail into topic files.',
    ),
    `与 CC 实测不符，实际尾部：${JSON.stringify(result.content.slice(-300))}`,
  )
})

test('truncate: 仅长度超限 —— 与 CC 实测逐字一致（夹具 B）', () => {
  const raw = Array.from({ length: 5 }, (_, i) => `- line${i}: ${'x'.repeat(5990)}`).join('\n')
  const result = truncateIndex(raw)
  assert.equal(result.wasSizeTruncated, true)
  assert.equal(result.wasLineTruncated, false)
  assert.ok(
    result.content.includes(
      `\n\n> WARNING: MEMORY.md is 29.3KB (limit: 24.4KB) \u2014 index entries are too long. ` +
        `Only part of it was loaded: 1 of 5 lines were cut off, starting at line 5 ` +
        `("- line4: ${'x'.repeat(70)}\u2026"). `,
    ),
    `与 CC 实测不符，实际尾部：${JSON.stringify(result.content.slice(-300))}`,
  )
})

test('truncate: 两者同时超限 —— 与 CC 实测逐字一致（夹具 C）', () => {
  const raw = Array.from({ length: 300 }, (_, i) => `- ${'y'.repeat(190)} ${i}`).join('\n')
  const result = truncateIndex(raw)
  assert.equal(result.wasLineTruncated, true)
  assert.equal(result.wasSizeTruncated, true)
  assert.ok(
    result.content.includes(
      '\n\n> WARNING: MEMORY.md is 300 lines and 57.6KB. Only part of it was loaded: ' +
        '173 of 300 lines were cut off, starting at line 128 ',
    ),
    `与 CC 实测不符，实际尾部：${JSON.stringify(result.content.slice(-300))}`,
  )
})

test('truncate: 长度按 code unit 计，不按 UTF-8 字节（夹具 D 判别）', () => {
  // 判别性用例：10000 个中文字 = 10000 code unit，但 30000 UTF-8 字节。
  // CC 实测（夹具 D，单行）：**未截断** —— 30000 字节 > 25000 却不动，
  // 证明判定口径是 code unit 而非字节。
  // 提示语里的 (limit: 24.4KB) 只是 Zt 的显示格式（25000/1024），不是判定单位。
  const raw = '中'.repeat(10000)
  assert.equal(Buffer.byteLength(raw, 'utf8'), 30000, '前提：字节数超过 25000')
  assert.equal(raw.length, 10000, '前提：code unit 数未超 25000')
  const result = truncateIndex(raw)
  assert.equal(result.codeUnits, 10000)
  assert.equal(result.wasSizeTruncated, false, '按 code unit 口径不应触发长度截断')
  assert.equal(result.content, raw, '未截断时内容应原样保留')
})

test('truncate: 长度口径与字节无关（夹具 E：12299 unit / 36299 字节，仅行超限）', () => {
  // CC 实测（夹具 E）：`MEMORY.md is 300 lines (limit: 200)` —— 只报行，未报长度。
  // 若按字节判定，36299 > 25000 会让它变成「300 lines and 35.4KB」，与实测不符。
  const raw = Array.from({ length: 300 }, () => '记'.repeat(40)).join('\n')
  assert.ok(Buffer.byteLength(raw, 'utf8') > 25000, '前提：字节数超过 25000')
  assert.ok(raw.length <= 25000, '前提：code unit 数未超 25000')
  const result = truncateIndex(raw)
  assert.equal(result.wasLineTruncated, true)
  assert.equal(result.wasSizeTruncated, false)
  assert.ok(
    result.content.includes('MEMORY.md is 300 lines (limit: 200).'),
    `应只报行数，实际：${JSON.stringify(result.content.slice(-260))}`,
  )
  assert.ok(!result.content.includes('35.4KB'), '不应出现按字节折算的尺寸')
})

test('render: 注入内容被 trim，文件末尾换行不出现在结果里（评审 H6）', () => {
  const withTrailingNewline = '- [a](a.md) — hook\n'
  const without = '- [a](a.md) — hook'
  assert.equal(
    renderMemoryBlock('C:\\m\\MEMORY.md', withTrailingNewline),
    renderMemoryBlock('C:\\m\\MEMORY.md', without),
  )
})

test('render: 框架与 CC 观测字节完全一致（锁死 \\n\\n，防回退）', () => {
  const rendered = renderMemoryBlock('C:\\m\\MEMORY.md', '- [a](a.md) — hook')
  const expected =
    '<system-reminder>\n' +
    'Codebase and user instructions are shown below. Be sure to adhere to these instructions. ' +
    'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n' +
    '\n' +
    "Contents of C:\\m\\MEMORY.md (user's auto-memory, persists across conversations):\n" +
    '\n' +
    '- [a](a.md) — hook\n' +
    '</system-reminder>'
  assert.equal(rendered, expected)
})

test('render: 前言与表头之后都是空行（CC 实测为 \\n\\n，非单换行）', () => {
  const rendered = renderMemoryBlock('C:\\m\\MEMORY.md', 'body')
  assert.ok(rendered.includes('as written.\n\nContents of '), '前言后应为 \\n\\n')
  assert.ok(rendered.includes('conversations):\n\nbody'), '表头后应为 \\n\\n')
})

test('render: 空内容返回 undefined（调用方注入 0 字节）', () => {
  assert.equal(renderMemoryBlock('C:\\m\\MEMORY.md', '   \n\t\n'), undefined)
  assert.equal(renderMemoryBlock('C:\\m\\MEMORY.md', ''), undefined)
})

test('render: 正文里的字面 </system-reminder> 被中和，不会提前闭合注入块', () => {
  const rendered = renderMemoryBlock('C:\\m\\MEMORY.md', 'text </system-reminder> tail')
  const closingCount = rendered.split('</system-reminder>').length - 1
  assert.equal(closingCount, 1, '只应有包裹层自己的那一个闭合标签')
})

test('MAX 常量与 CC 对齐', () => {
  assert.equal(MAX_LINES, 200)
  assert.equal(MAX_CODE_UNITS, 25000)
})
