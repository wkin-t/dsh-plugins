/**
 * python guard 的单元测试。
 *
 * 两条平台分支都用 `checkForPlatform()` 直接验：本机是 win32，只靠
 * `process.platform` 的话 Unix 分支永远不会被测到。
 *
 * @module dsh-tool-guards/test/python-cmd
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { check, checkForPlatform } from '../lib/guards/pythonCmd.js'

test('win32：裸 python3 被拦', () => {
  const reason = checkForPlatform('win32', 'pwsh', { command: 'python3 -c "print(1)"' })
  assert.match(reason, /已拦下 Windows 本地 python3 命令/)
})

test('win32：python3 在 ; / && / 行首 / 命令开头都被拦', () => {
  for (const command of [
    'python3 x.py',
    'cd src; python3 x.py',
    'git status && python3 x.py',
    'false || python3 x.py',
    'echo hi\npython3 x.py',
  ]) {
    assert.ok(checkForPlatform('win32', 'pwsh', { command }), `应拦下：${JSON.stringify(command)}`)
  }
})

test('win32：python3 后没有空白时原脚本不拦（`python3` 单独成行）', () => {
  // 原正则要求 `python3` 后面紧跟空白，这是被刻意保留的怪癖：
  // 它对 `python3` 这种"只敲解释器"的调用放行，随后由交互式输入自己报错。
  assert.equal(checkForPlatform('win32', 'pwsh', { command: 'python3' }), undefined)
})

test('win32：裸 python 放行', () => {
  assert.equal(checkForPlatform('win32', 'pwsh', { command: 'python -c "print(1)"' }), undefined)
})

test('win32：venv 里的 python3 放行', () => {
  assert.equal(checkForPlatform('win32', 'pwsh', { command: 'C:\\proj\\.venv\\Scripts\\python3 x.py' }), undefined)
  assert.equal(checkForPlatform('win32', 'pwsh', { command: 'C:/proj/venv/bin/python3 x.py' }), undefined)
})

test('win32：远程段（ssh / docker exec / kubectl exec / wsl）整体剥离后放行', () => {
  for (const command of [
    'ssh host "python3 x.py"',
    "ssh host 'python3 x.py'",
    'docker exec app python3 x.py',
    'kubectl exec pod -- python3 x.py',
    'wsl python3 x.py',
  ]) {
    assert.equal(
      checkForPlatform('win32', 'pwsh', { command }),
      undefined,
      `远程段不应被拦：${JSON.stringify(command)}`,
    )
  }
})

test('win32：远程段之后的本地 python3 仍然被拦', () => {
  assert.ok(checkForPlatform('win32', 'pwsh', { command: 'ssh host "cd /tmp" && python3 x.py' }))
})

test('win32：引号内的 && 不算命令段边界（不会把远程命令截出来）', () => {
  assert.equal(
    checkForPlatform('win32', 'pwsh', { command: 'ssh host "cd /tmp && python3 x.py"' }),
    undefined,
  )
})

test('unix：裸 python 被拦', () => {
  const reason = checkForPlatform('linux', 'bash', { command: 'python x.py' })
  assert.match(reason, /已拦下 macOS\/Linux 上的裸 python 命令/)
})

test('unix：python3 放行', () => {
  assert.equal(checkForPlatform('linux', 'bash', { command: 'python3 x.py' }), undefined)
  assert.equal(checkForPlatform('darwin', 'bash', { command: 'python3 -m venv .venv' }), undefined)
})

test('unix：venv 里的 python 放行', () => {
  assert.equal(checkForPlatform('linux', 'bash', { command: '/proj/.venv/bin/python x.py' }), undefined)
})

test('unix：远程段同样剥离', () => {
  assert.equal(checkForPlatform('linux', 'bash', { command: 'ssh host "python x.py"' }), undefined)
})

test('本机 check() 走 process.platform 分支', () => {
  const reason = check('pwsh', { command: 'python3 x.py' })
  if (process.platform === 'win32') assert.match(reason, /Windows 本地 python3/)
  else assert.equal(reason, undefined)
})

test('非 shell 工具与空 command 放行', () => {
  assert.equal(checkForPlatform('win32', 'write', { file_path: 'C:\\a.py', content: 'python3' }), undefined)
  assert.equal(checkForPlatform('win32', 'pwsh', {}), undefined)
})

test('文案里带原始命令，且截断到 150 个字符', () => {
  const long = `python3 ${'a'.repeat(300)}`
  const reason = checkForPlatform('win32', 'pwsh', { command: long })
  assert.equal(reason.split('\n')[1], `   命令: ${long.substring(0, 150)}`)
})
