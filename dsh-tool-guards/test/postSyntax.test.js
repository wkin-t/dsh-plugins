/**
 * 写后语法自检：路由正确 + Python 检查器真的能用。
 *
 * 为什么必须用真文件：检查器读的是**磁盘上的文件**，不是 payload 里的 content。
 * 用假路径或内存内容测出来的"通过"是假绿。
 *
 * TypeScript 那半在这里只断言"不抛异常、找不到 typescript 时按原设计跳过"——
 * 它从被检查文件的目录往上找 `node_modules/typescript`，测试工程没有本地
 * typescript，所以在这里它本来就该是 pass。要真正验证 TS 分支需要造一个
 * 带 typescript 的工程，成本远高于收益，故不覆盖，并在 README 里写明。
 *
 * @module dsh-tool-guards/test/postSyntax
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { CHECKERS, checkerFor, planCheck, pythonRunnerFor, runChecker } from '../lib/post/syntax.js'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('Python 解释器按平台选择', () => {
  test('darwin / linux 用 python3', () => {
    assert.equal(pythonRunnerFor('darwin'), 'python3')
    assert.equal(pythonRunnerFor('linux'), 'python3')
  })

  test('win32 用 python', () => {
    assert.equal(pythonRunnerFor('win32'), 'python')
  })

  test('其他类 Unix 平台也回落到 python3（不是 win32 就用 python3）', () => {
    assert.equal(pythonRunnerFor('freebsd'), 'python3')
    assert.equal(pythonRunnerFor('openbsd'), 'python3')
  })

  test('CHECKERS 在模块加载时按本机平台定下 runner', () => {
    assert.equal(CHECKERS.python.runner, pythonRunnerFor(process.platform))
    // TypeScript 那半跑在 node 上，与平台无关——保持原行为不变。
    assert.equal(CHECKERS.typescript.runner, 'node')
  })

  test('检查器脚本路径可用 node:path join 解析到真实文件', () => {
    for (const spec of Object.values(CHECKERS)) {
      assert.ok(
        existsSync(join(PLUGIN_ROOT, spec.script)),
        `检查器脚本不存在：${join(PLUGIN_ROOT, spec.script)}`,
      )
    }
  })
})

describe('写后检查的路由', () => {
  test('按扩展名选检查器', () => {
    assert.equal(checkerFor('a.py'), 'python')
    assert.equal(checkerFor('a.ts'), 'typescript')
    assert.equal(checkerFor('a.tsx'), 'typescript')
    assert.equal(checkerFor('a.mts'), 'typescript')
    assert.equal(checkerFor('a.md'), undefined)
    assert.equal(checkerFor('a'), undefined)
  })

  test('扩展名大小写不敏感', () => {
    assert.equal(checkerFor('A.PY'), 'python')
    assert.equal(checkerFor('A.Ts'), 'typescript')
  })

  test('只有写入类工具才触发', () => {
    assert.deepEqual(planCheck({ name: 'write', arguments: { file_path: 'a.py' } }), { kind: 'python', filePath: 'a.py' })
    assert.deepEqual(planCheck({ name: 'edit', arguments: { file_path: 'a.py' } }), { kind: 'python', filePath: 'a.py' })
    assert.equal(planCheck({ name: 'pwsh', arguments: { command: 'x' } }), undefined)
    assert.equal(planCheck({ name: 'write', arguments: {} }), undefined)
    assert.equal(planCheck({ name: 'write', arguments: { file_path: 'a.md' } }), undefined)
  })
})

describe('Python 检查器真实可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-post-'))
  const bad = join(dir, 'bad.py')
  const good = join(dir, 'good.py')
  writeFileSync(bad, 'def f(:\n')
  writeFileSync(good, 'def f() -> int:\n    return 1\n')

  test('语法错误 -> 给出与原脚本一致的中文反馈', async () => {
    const reason = await runChecker({
      kind: 'python',
      pluginRoot: PLUGIN_ROOT,
      exec: { name: 'write', arguments: { file_path: bad } },
      timeoutMs: 20000,
    })
    assert.match(String(reason), /^Python 语法错误 in /)
    assert.match(String(reason), /为什么必须先修/)
  })

  test('语法正确 -> 放行', async () => {
    const reason = await runChecker({
      kind: 'python',
      pluginRoot: PLUGIN_ROOT,
      exec: { name: 'write', arguments: { file_path: good } },
      timeoutMs: 20000,
    })
    assert.equal(reason, undefined)
  })

  test('超时不会挂住（极小超时 -> 放行）', async () => {
    const reason = await runChecker({
      kind: 'python',
      pluginRoot: PLUGIN_ROOT,
      exec: { name: 'write', arguments: { file_path: bad } },
      timeoutMs: 1,
    })
    assert.equal(reason, undefined)
  })

  test('TypeScript 无本地 typescript 时按原设计跳过', async () => {
    const tsFile = join(dir, 'bad.ts')
    writeFileSync(tsFile, 'const x: number = {;')
    const reason = await runChecker({
      kind: 'typescript',
      pluginRoot: PLUGIN_ROOT,
      exec: { name: 'write', arguments: { file_path: tsFile } },
      timeoutMs: 20000,
    })
    assert.equal(reason, undefined)
  })
})
