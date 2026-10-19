/**
 * `hooks.example.json` 的可移植性契约。
 *
 * 这份文件是用户复制到 `$DSH_HOME/tool-guards/hooks.json` 的默认开关表，
 * 因此三件事必须一直被锁住：
 *   1. 是合法 JSON（不是 YAML、不带注释）；
 *   2. 不包含 Windows 绝对路径 / 反斜杠路径——它要能在 macOS、Linux 上直接 cp；
 *   3. 五条 guard 全部启用且覆盖所有工具（与 README 宣称的启用清单一致）。
 *
 * @module dsh-tool-guards/test/hooksExample
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseHooksConfig, scriptNameOfCommand } from '../lib/hooks-config.js'
import * as deprecatedGuard from '../lib/guards/deprecated.js'
import * as gitSafetyGuard from '../lib/guards/gitSafety.js'
import * as npmGuard from '../lib/guards/npm.js'
import * as pythonCmdGuard from '../lib/guards/pythonCmd.js'
import * as truncationGuard from '../lib/guards/truncation.js'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXAMPLE_PATH = join(PLUGIN_ROOT, 'hooks.example.json')
const EXAMPLE = readFileSync(EXAMPLE_PATH, 'utf8')

/** 与 index.js 相同的目录形状。 */
const CATALOG = [deprecatedGuard, gitSafetyGuard, npmGuard, pythonCmdGuard, truncationGuard]
  .map(({ id, script }) => ({ id, script }))

test('hooks.example.json 是合法 JSON', () => {
  assert.doesNotThrow(() => JSON.parse(EXAMPLE))
})

test('hooks.example.json 不含 Windows 绝对路径或反斜杠路径', () => {
  // 这条文件会被 macOS / Linux 用户直接复制，`C:\...` 之类会让命令解析不到脚本。
  assert.doesNotMatch(EXAMPLE, /[A-Za-z]:[\\/]/, '不应出现盘符绝对路径')
  assert.doesNotMatch(EXAMPLE, /\\\\/, '不应出现反斜杠路径')
})

test('hooks.example.json 五条 guard 全部启用且覆盖所有工具', () => {
  const { enabled, diagnostics } = parseHooksConfig(EXAMPLE, CATALOG)
  assert.deepEqual(diagnostics, [])
  assert.deepEqual(enabled.map((entry) => entry.id), ['deprecated', 'gitSafety', 'truncation', 'pythonCmd', 'npm'])
  for (const entry of enabled) {
    assert.equal(entry.matchAll, true, `${entry.id} 应覆盖所有工具（示例配置不写 matcher）`)
  }
})

test('每条 command 都是可移植的 `node <basename>.mjs`', () => {
  const parsed = JSON.parse(EXAMPLE)
  const hooks = parsed.hooks.PreToolUse.flatMap((group) => group.hooks)
  assert.equal(hooks.length, 5)
  for (const hook of hooks) {
    assert.equal(hook.type, 'command')
    assert.match(hook.command, /^node [\w.-]+\.mjs$/, `命令应为裸脚本名，实际：${hook.command}`)
    const script = scriptNameOfCommand(hook.command)
    assert.ok(
      CATALOG.some((entry) => entry.script === script),
      `命令 ${hook.command} 没对应任何已移植 guard`,
    )
  }
})
