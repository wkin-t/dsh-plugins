/**
 * git safety guard 的单元测试：11 条危险模式逐条覆盖，外加不误拦的反例。
 *
 * @module dsh-tool-guards/test/git-safety
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { check } from '../lib/guards/gitSafety.js'

/** 断言被拦并返回理由。 */
function assertBlocked(command, expectedName) {
  const reason = check('pwsh', { command })
  assert.equal(typeof reason, 'string', `期望拦截：${command}`)
  assert.ok(
    reason.includes(`已拦下高风险命令：${expectedName}`),
    `模式名不符：期望 ${expectedName}\n实际首行: ${reason.split('\n')[0]}`,
  )
  return reason
}

test('git push --force（各种位置）', () => {
  assertBlocked('git push --force origin main', 'git push --force')
  assertBlocked('git push origin main --force', 'git push --force')
})

test('--force-with-lease 放行（唯一安全的强推形式）', () => {
  assert.equal(check('pwsh', { command: 'git push --force-with-lease origin main' }), undefined)
  assert.equal(check('pwsh', { command: 'git push origin main --force-with-lease' }), undefined)
})

test('git push -f', () => {
  assertBlocked('git push -f origin main', 'git push -f')
})

test('git reset --hard', () => {
  assertBlocked('git reset --hard HEAD~1', 'git reset --hard')
})

test('git clean 带 f 的任意短选项组合', () => {
  assertBlocked('git clean -fd', 'git clean -f')
  assertBlocked('git clean -xdf', 'git clean -f')
})

test('git clean -n（只预览）放行', () => {
  assert.equal(check('pwsh', { command: 'git clean -n' }), undefined)
})

test('git branch -D 拦、-d 放行', () => {
  assertBlocked('git branch -D feature', 'git branch -D')
  assert.equal(check('pwsh', { command: 'git branch -d feature' }), undefined)
})

test('rm -rf 根路径', () => {
  assertBlocked('rm -rf /', 'rm -rf /')
  assertBlocked('rm -rf /var/lib', 'rm -rf /')
})

test('Remove-Item -Recurse -Force C:\\', () => {
  assertBlocked('Remove-Item -Recurse -Force C:\\Windows', 'Remove-Item -Recurse -Force C:\\')
})

test('Format-Volume / mkfs', () => {
  assertBlocked('Format-Volume -DriveLetter D', 'Format-Volume')
  assertBlocked('mkfs.ext4 /dev/sdb1', 'mkfs')
})

test('chmod -R 777 / icacls Everyone:F', () => {
  assertBlocked('chmod -R 777 ./data', 'chmod -R 777')
  assertBlocked('icacls C:\\x /grant Everyone:F', 'icacls Everyone:F')
})

test('安全操作放行', () => {
  for (const command of [
    'git status',
    'git stash push -m wip',
    'git push origin main',
    'git log --oneline -5',
    'rm -rf ./dist',
    'chmod 644 ./file',
  ]) {
    assert.equal(check('pwsh', { command }), undefined, `不应拦截：${command}`)
  }
})

test('命令边界：说明文字里的危险词不误拦', () => {
  assert.equal(check('pwsh', { command: 'git commit -m "never git reset --hard here"' }), undefined)
  assert.equal(check('pwsh', { command: 'echo "git push --force"' }), undefined)
})

test('命令边界：; 之后的危险命令照样拦', () => {
  assertBlocked('git status; git reset --hard', 'git reset --hard')
})

test('首条命中的模式决定文案（--force 优先于 -f）', () => {
  const reason = assertBlocked('git push --force -f', 'git push --force')
  assert.ok(reason.includes('更稳做法: 使用 --force-with-lease 更安全'))
})

test('非 shell 工具与空 command 放行', () => {
  assert.equal(check('write', { file_path: 'C:\\a.sh', content: 'git reset --hard' }), undefined)
  assert.equal(check('pwsh', {}), undefined)
})

test('文案带完整命令，且截断到 200 个字符', () => {
  const long = `git reset --hard ${'a'.repeat(400)}`
  const reason = check('pwsh', { command: long })
  assert.equal(reason.split('\n')[1], `   完整命令: ${long.substring(0, 200)}`)
})
