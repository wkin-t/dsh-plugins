/**
 * Unix 分支差分测试：拿**真的跑在 linux/darwin 分支上的原脚本**当 oracle。
 *
 * 为什么单独一个文件：`differential.test.js` 只能喂本机平台（win32）的分支，
 * `pythonCmd` 的 Unix 分支长期只有"读代码觉得一样"这种伪验证。
 * 这里用 `--import` 预载把 `process.platform` 改写后再跑原脚本，
 * 让它真实求值 Unix 分支，再与插件 `checkForPlatform()` 逐字比对。
 *
 * 注意：这里比的是**平台分支**，不是整条链路；`check()` 自身仍由
 * `differential.test.js` 在 win32 分支上对拍。
 *
 * @module dsh-tool-guards/test/platform
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, test } from 'node:test'
import { checkForPlatform } from '../lib/guards/pythonCmd.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ORACLE = join(HERE, '..', 'oracle', 'helpers', 'python-cmd-guard.mjs')
const PRELOAD = pathToFileURL(join(HERE, 'helpers', 'fake-platform.mjs')).href

/** 被测平台。只测 Unix 侧：win32 侧已有 differential.test.js 覆盖。 */
const PLATFORMS = ['linux', 'darwin']

/**
 * fixture 设计原则：每条都尽量踩在不同规则的边界上——
 * 裸 python / 带版本号 / 子命令 / 引号内 / 串联 / 提权前缀 / 非 shell 工具。
 */
const FIXTURES = [
  { name: '裸 python', tool: 'pwsh', args: { command: 'python --version' } },
  { name: 'python -m', tool: 'pwsh', args: { command: 'python -m pytest' } },
  { name: 'python3 带版本', tool: 'pwsh', args: { command: 'python3 --version' } },
  { name: 'python3 -m', tool: 'pwsh', args: { command: 'python3 -m pytest' } },
  { name: 'python3.12', tool: 'pwsh', args: { command: 'python3.12 x.py' } },
  { name: '裸 python 单独', tool: 'pwsh', args: { command: 'python' } },
  { name: '引号内出现', tool: 'pwsh', args: { command: 'echo "python --version"' } },
  { name: '串联 && python', tool: 'pwsh', args: { command: 'cd x && python y.py' } },
  { name: 'sudo python', tool: 'pwsh', args: { command: 'sudo python setup.py' } },
  { name: '管道进 python', tool: 'pwsh', args: { command: 'cat a.py | python' } },
  { name: '无关命令', tool: 'pwsh', args: { command: 'git status' } },
  { name: '非 shell 工具', tool: 'write', args: { file_path: 'a.py', content: 'print(1)' } },
]

/**
 * 让原脚本在伪造平台上跑一次，取它的拦截理由。
 *
 * @param platform - 伪造的 `process.platform`。
 * @param toolName - 工具名。
 * @param args - 工具参数。
 * @returns 拦截理由；放行时返回 undefined。
 */
function oracleVerdict(platform, toolName, args) {
  const result = spawnSync(process.execPath, ['--import', PRELOAD, ORACLE], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: args,
    }),
    encoding: 'utf8',
    env: { ...process.env, FAKE_PLATFORM: platform },
    timeout: 30000,
  })
  // 原脚本可能先写别的输出，取最后一个以 `{` 开头的 JSON 行。
  const lines = (result.stdout ?? '').trim().split('\n').filter((line) => line.startsWith('{'))
  if (lines.length === 0) return undefined
  const parsed = JSON.parse(lines[lines.length - 1])
  return parsed.decision === 'block' ? String(parsed.reason) : undefined
}

describe('pythonCmd Unix 分支与原脚本逐字一致', () => {
  for (const platform of PLATFORMS) {
    describe(platform, () => {
      for (const fixture of FIXTURES) {
        test(fixture.name, () => {
          const expected = oracleVerdict(platform, fixture.tool, fixture.args)
          const actual = checkForPlatform(platform, fixture.tool, fixture.args)
          assert.equal(actual, expected)
        })
      }
    })
  }

  // 一条反向对照：如果伪造平台没生效，原脚本会走 win32 分支、拦 python3 而放 python，
  // 那么上面那批 Unix 断言必然大面积失败。这里把它变成显式的自检，
  // 避免"预载失效导致两边都跑 win32、于是错误地对齐"这种假绿。
  test('预载确实改变了原脚本的分支（自检）', () => {
    const onLinux = oracleVerdict('linux', 'pwsh', { command: 'python --version' })
    const onWin32 = oracleVerdict('win32', 'pwsh', { command: 'python --version' })
    assert.match(String(onLinux), /macOS\/Linux/, 'linux 分支应给出 macOS/Linux 文案')
    assert.equal(onWin32, undefined, 'win32 分支不应拦裸 python')
  })
})
