/**
 * SSH 远程写代码软提醒：与原脚本的**行为一致性**测试。
 *
 * 这条规则特殊在它是「提醒而非拦截」：原脚本命中后只往 stderr 写一行，
 * `exit 0` 放行。移植时必须同时守住两件事：
 *   1) 命中范围与原正则完全一致（用 oracle 对拍）；
 *   2) **绝不**把提醒变成拒绝理由——否则远程运维命令会被一起挡掉，
 *      那是语义升级，不是移植。
 *
 * @module dsh-tool-guards/test/sshWarning
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { check, sshRemoteWriteWarning } from '../lib/guards/gitSafety.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ORACLE = join(HERE, '..', 'oracle', 'helpers', 'git-safety-guard.mjs')

/** 覆盖：真该提醒的写操作、不该提醒的运维/读取操作、非 shell 工具。 */
const FIXTURES = [
  { name: 'cat 重定向写文件', command: 'ssh host "cat > /app/main.py"' },
  { name: 'sed -i 原地改', command: 'ssh host "sed -i s/a/b/ x.conf"' },
  { name: 'vim 编辑', command: 'ssh host "vim /etc/nginx.conf"' },
  { name: 'echo 追加写', command: 'ssh host "echo hi > /tmp/a.txt"' },
  { name: 'tee 写', command: 'ssh user@10.0.0.1 "tee /etc/x.py"' },
  { name: 'scp 不算（正则只认 ssh）', command: 'scp a.py host:/app/a.py' },
  { name: '纯运维 compose', command: 'ssh host "docker compose up -d"' },
  { name: '纯运维 systemctl', command: 'ssh host "systemctl restart nginx"' },
  { name: '只读日志', command: 'ssh host "cat /var/log/syslog"' },
  { name: '无关命令', command: 'git status' },
]

/**
 * 问原脚本：这条命令会不会触发 SSH 提醒。
 *
 * @param command - 待测命令。
 * @returns 是否提醒。
 */
function oracleWarned(command) {
  const result = spawnSync(process.execPath, [ORACLE], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'pwsh',
      tool_input: { command },
    }),
    encoding: 'utf8',
    timeout: 30000,
  })
  return /SSH 远程写代码操作/.test(result.stderr ?? '')
}

describe('SSH 远程写代码软提醒', () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.name}：命中范围与原脚本一致`, () => {
      assert.equal(sshRemoteWriteWarning('pwsh', { command: fixture.command }) !== undefined, oracleWarned(fixture.command))
    })
  }

  test('提醒文案逐字照搬原脚本', () => {
    const warning = sshRemoteWriteWarning('pwsh', { command: 'ssh host "cat > /app/main.py"' })
    assert.match(warning, /^⚠️ \[Git Safety Guard\] 检测到 SSH 远程写代码操作/)
    assert.match(warning, /为什么提醒：远程直接写代码会绕开本地测试、diff 和 git 审计/)
    assert.match(warning, /如果这是运维操作（非代码修改），可忽略此提醒/)
  })

  test('提醒绝不等于拦截：命中提醒的命令仍然放行', () => {
    for (const fixture of FIXTURES) {
      assert.equal(check('pwsh', { command: fixture.command }), undefined)
    }
  })

  test('非 shell 工具不提醒', () => {
    assert.equal(sshRemoteWriteWarning('write', { file_path: 'a.py', content: 'ssh host "cat > b.py"' }), undefined)
  })
})
