/**
 * hooks.json 解析的单元测试。
 *
 * 这里守的是**启用边界**：哪个文件在、matcher 怎么写、出错时退化成什么。
 * 判定逻辑不在这里测（那在各自的 guard 测试与差分测试里）。
 *
 * @module dsh-tool-guards/test/hooks-config
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  describeEnabled,
  guardAppliesTo,
  parseHooksConfig,
  readHooksConfig,
  scriptNameOfCommand,
} from '../lib/hooks-config.js'
import * as deprecatedGuard from '../lib/guards/deprecated.js'
import * as gitSafetyGuard from '../lib/guards/gitSafety.js'
import * as npmGuard from '../lib/guards/npm.js'
import * as pythonCmdGuard from '../lib/guards/pythonCmd.js'
import * as truncationGuard from '../lib/guards/truncation.js'

/** 与 index.js 相同的目录形状。 */
const CATALOG = [deprecatedGuard, gitSafetyGuard, npmGuard, pythonCmdGuard, truncationGuard]
  .map(({ id, script }) => ({ id, script }))

/** 造一份最小 hooks.json 文本。 */
function config(hooks, matcher) {
  const group = { hooks }
  if (matcher !== undefined) group.matcher = matcher
  return JSON.stringify({ hooks: { PreToolUse: [group] } })
}

/** 造一条指向某脚本的 command hook。 */
function commandFor(script) {
  return { type: 'command', command: `node "C:/Users/DELL/.dsh/claude-hooks/helpers/${script}"`, timeout: 10 }
}

/** 从解析结果里取某条 guard。 */
function entryOf(enabled, id) {
  return enabled.find((entry) => entry.id === id)
}

test('命令里的脚本名解析：带引号、不带引号、带空格路径、大写', () => {
  assert.equal(scriptNameOfCommand('node "C:/a/b/npm-guard.mjs"'), 'npm-guard.mjs')
  assert.equal(scriptNameOfCommand('node C:/a/b/npm-guard.mjs --flag'), 'npm-guard.mjs')
  assert.equal(scriptNameOfCommand('node "C:/My Tools/npm-guard.mjs"'), 'npm-guard.mjs')
  assert.equal(scriptNameOfCommand('node "C:\\a\\b\\NPM-Guard.MJS"'), 'npm-guard.mjs')
  assert.equal(scriptNameOfCommand('node "C:/a/b/unknown.mjs"'), 'unknown.mjs')
  assert.equal(scriptNameOfCommand(''), '')
  assert.equal(scriptNameOfCommand(undefined), '')
})

test('matcher 缺省 = 匹配所有工具', () => {
  const { enabled, diagnostics } = parseHooksConfig(config([commandFor('npm-guard.mjs')]), CATALOG)
  assert.deepEqual(diagnostics, [])
  const entry = entryOf(enabled, 'npm')
  assert.equal(entry.matchAll, true)
  assert.equal(guardAppliesTo(entry, 'pwsh'), true)
  assert.equal(guardAppliesTo(entry, 'write'), true)
  assert.equal(guardAppliesTo(entry, ''), true)
})

test('matcher 是 | 分隔的正则分支，大小写不敏感', () => {
  const { enabled } = parseHooksConfig(config([commandFor('truncation-guard.mjs')], 'edit|write'), CATALOG)
  const entry = entryOf(enabled, 'truncation')
  assert.equal(entry.matchAll, false)
  assert.deepEqual(entry.patterns, ['edit', 'write'])
  assert.equal(guardAppliesTo(entry, 'edit'), true)
  assert.equal(guardAppliesTo(entry, 'Write'), true)
  assert.equal(guardAppliesTo(entry, 'read'), false)
  // 部分匹配（不是全串锚定）：这是 CC matcher 的语义，`multi_edit` 因此也算写入。
  assert.equal(guardAppliesTo(entry, 'multi_edit'), true)
})

test('matcher 为空串等价于缺省', () => {
  const { enabled } = parseHooksConfig(config([commandFor('npm-guard.mjs')], '   '), CATALOG)
  assert.equal(entryOf(enabled, 'npm').matchAll, true)
})

test('非 command 类型跳过并留 info 诊断', () => {
  const { enabled, diagnostics } = parseHooksConfig(
    config([{ type: 'prompt', command: 'node "x/npm-guard.mjs"' }]),
    CATALOG,
  )
  assert.equal(enabled.length, 0)
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].level, 'info')
  assert.match(diagnostics[0].message, /非 command/)
})

test('未移植的脚本跳过并留 info 诊断', () => {
  const { enabled, diagnostics } = parseHooksConfig(config([commandFor('check-python-syntax.py')]), CATALOG)
  assert.equal(enabled.length, 0)
  assert.equal(diagnostics[0].level, 'info')
  assert.match(diagnostics[0].message, /未移植/)
})

test('启用顺序跟随 hooks.json 出现顺序（= CC 串行执行顺序）', () => {
  const { enabled } = parseHooksConfig(
    config([
      commandFor('deprecated-guard.mjs'),
      commandFor('git-safety-guard.mjs'),
      commandFor('truncation-guard.mjs'),
      commandFor('python-cmd-guard.mjs'),
      commandFor('npm-guard.mjs'),
    ]),
    CATALOG,
  )
  assert.deepEqual(enabled.map((entry) => entry.id), ['deprecated', 'gitSafety', 'truncation', 'pythonCmd', 'npm'])
})

test('同一 guard 出现在多个分组：matcher 取并集', () => {
  const text = JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'pwsh', hooks: [commandFor('npm-guard.mjs')] },
        { matcher: 'bash', hooks: [commandFor('npm-guard.mjs')] },
      ],
    },
  })
  const { enabled } = parseHooksConfig(text, CATALOG)
  const entry = entryOf(enabled, 'npm')
  assert.equal(enabled.length, 1)
  assert.equal(entry.matchAll, false)
  assert.equal(guardAppliesTo(entry, 'pwsh'), true)
  assert.equal(guardAppliesTo(entry, 'bash'), true)
  assert.equal(guardAppliesTo(entry, 'write'), false)
})

test('同一 guard 有一组没写 matcher 时吸收为「全部工具」', () => {
  const text = JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'pwsh', hooks: [commandFor('npm-guard.mjs')] },
        { hooks: [commandFor('npm-guard.mjs')] },
      ],
    },
  })
  const entry = entryOf(parseHooksConfig(text, CATALOG).enabled, 'npm')
  assert.equal(entry.matchAll, true)
})

test('非法 matcher 分支：丢弃该分支，绝不退化成「匹配所有」', () => {
  const { enabled, diagnostics } = parseHooksConfig(config([commandFor('npm-guard.mjs')], 'pwsh|['), CATALOG)
  const entry = entryOf(enabled, 'npm')
  assert.equal(entry.matchAll, false)
  assert.equal(guardAppliesTo(entry, 'pwsh'), true)
  assert.equal(guardAppliesTo(entry, 'write'), false, '坏分支不能把 guard 放到全部工具上')
  assert.ok(diagnostics.some((d) => d.level === 'warn' && /不是合法正则/.test(d.message)))
})

test('JSON 解析失败 → fail-open + warn', () => {
  const { enabled, diagnostics } = parseHooksConfig('{ "hooks": ', CATALOG)
  assert.deepEqual(enabled, [])
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].level, 'warn')
  assert.match(diagnostics[0].message, /解析失败/)
})

test('缺 PreToolUse 段 → fail-open + warn', () => {
  const { enabled, diagnostics } = parseHooksConfig(JSON.stringify({ hooks: { PostToolUse: [] } }), CATALOG)
  assert.deepEqual(enabled, [])
  assert.equal(diagnostics[0].level, 'warn')
  assert.match(diagnostics[0].message, /PreToolUse/)
})

test('PreToolUse 不是数组 → fail-open + warn', () => {
  const { enabled, diagnostics } = parseHooksConfig(JSON.stringify({ hooks: { PreToolUse: {} } }), CATALOG)
  assert.deepEqual(enabled, [])
  assert.equal(diagnostics[0].level, 'warn')
})

test('PostToolUse 完全不影响启用清单（本期不做语法检查器）', () => {
  const text = JSON.stringify({
    hooks: {
      PreToolUse: [{ hooks: [commandFor('npm-guard.mjs')] }],
      PostToolUse: [{ matcher: 'edit|write', hooks: [commandFor('check-ts-syntax.mjs')] }],
    },
  })
  const { enabled } = parseHooksConfig(text, CATALOG)
  assert.deepEqual(enabled.map((entry) => entry.id), ['npm'])
})

test('readHooksConfig：文件不存在 → fail-open + 带路径的 warn', () => {
  const missing = join(tmpdir(), 'dsh-tool-guards-definitely-missing', 'hooks.json')
  const { enabled, diagnostics } = readHooksConfig(missing, CATALOG)
  assert.deepEqual(enabled, [])
  assert.equal(diagnostics[0].level, 'warn')
  assert.ok(diagnostics[0].message.includes(missing))
  assert.match(diagnostics[0].message, /ENOENT|读取 hooks.json 失败/)
})

test('readHooksConfig：正常文件解析成功，诊断里带路径前缀', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-guards-'))
  const path = join(dir, 'hooks.json')
  writeFileSync(path, config([commandFor('npm-guard.mjs')]), 'utf8')
  const { enabled } = readHooksConfig(path, CATALOG)
  assert.deepEqual(enabled.map((entry) => entry.id), ['npm'])
})

test('describeEnabled 渲染启用清单', () => {
  const { enabled } = parseHooksConfig(config([commandFor('npm-guard.mjs')]), CATALOG)
  assert.equal(describeEnabled(enabled), 'npm(matcher=*)')
  assert.equal(describeEnabled([]), '(无)')
})
