/**
 * npm guard 的单元测试：规则分支逐条覆盖。
 *
 * 差分测试已经用原脚本当 oracle 证明「这边和 CC 一致」；这里的价值是把每条分支
 * 的**意图**固定下来（断言的 `更稳做法` 尾行即 pnpm 等价命令），
 * 让后来改正则的人知道哪一条是给谁用的。
 *
 * @module dsh-tool-guards/test/npm
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { check } from '../lib/guards/npm.js'

/** 跑一次，返回去掉首行的完整理由（便于断言「更稳做法」这一行）。 */
function reasonFor(command, tool = 'pwsh') {
  return check(tool, { command })
}

/** 断言被拦，并断言最后一行给出的 pnpm 等价命令。 */
function assertBlocked(command, expectedTail) {
  const reason = reasonFor(command)
  assert.equal(typeof reason, 'string', `期望拦截：${command}`)
  assert.ok(
    reason.endsWith(`更稳做法: ${expectedTail}`),
    `等价命令不符：\n期望尾部: ${expectedTail}\n实际尾部: ${reason.split('\n').pop()}`,
  )
}

test('安装类命令全部拦下并给出 pnpm 等价', () => {
  assertBlocked('npm install lodash', 'pnpm install')
  assertBlocked('npm i', 'pnpm install')
  assertBlocked('npm ci', 'pnpm install')
  assertBlocked('npm install', 'pnpm install')
})

test('脚本类命令保留子命令', () => {
  assertBlocked('npm run build', 'pnpm run')
  assertBlocked('npm start', 'pnpm start')
  assertBlocked('npm test', 'pnpm test')
  assertBlocked('npm build', 'pnpm build')
})

test('查询类命令也拦（原注释写明了理由：防止习惯性回退）', () => {
  assertBlocked('npm root -g', 'pnpm root')
  assertBlocked('npm list', 'pnpm list')
  assertBlocked('npm ls --depth=0', 'pnpm list')
  assertBlocked('npm view react version', 'pnpm view')
})

test('卸载类命令映射到 pnpm remove', () => {
  assertBlocked('npm uninstall lodash', 'pnpm remove')
  assertBlocked('npm remove lodash', 'pnpm remove')
  assertBlocked('npm rm lodash', 'pnpm remove')
})

test('exec 映射到 pnpm exec', () => {
  assertBlocked('npm exec -- foo', 'pnpm exec')
})

test('无子命令时给出 pnpm --help', () => {
  assertBlocked('npm', 'pnpm --help')
})

test('未知子命令原样带过去', () => {
  assertBlocked('npm audit', 'pnpm audit')
})

test('npx 提示改用 pnpm dlx', () => {
  assertBlocked('npx create-react-app app', 'pnpm dlx <package-or-command>')
})

test('工具名大小写归一：NPM 也按 npm 处理', () => {
  const reason = reasonFor('NPM install lodash')
  assert.match(reason, /已拦下 npm 命令/)
})

test('npx.cmd / npm.cmd / npm.ps1 后缀同样命中', () => {
  assert.ok(reasonFor('npm.cmd install'))
  assert.ok(reasonFor('npm.ps1 install'))
  assert.match(reasonFor('npx.cmd foo'), /已拦下 npx 命令/)
})

test('命令边界：; && || 之后都算命令位', () => {
  assert.ok(reasonFor('git status; npm install'))
  assert.ok(reasonFor('git status && npm install'))
  assert.ok(reasonFor('false || npm install'))
})

test('powershell -Command 的嵌套命令会被剥引号后检查', () => {
  assert.ok(reasonFor('powershell -Command "npm run build"'))
})

test('powershell -EncodedCommand 不尝试解码（原脚本同样放弃）', () => {
  assert.equal(reasonFor('powershell -EncodedCommand bnBtIGluc3RhbGw='), undefined)
})

test('Start-Process -FilePath 形态命中', () => {
  assertBlocked('Start-Process -FilePath npm -ArgumentList install', 'pnpm install')
})

test('pnpm 命令放行', () => {
  assert.equal(reasonFor('pnpm install'), undefined)
  assert.equal(reasonFor('pnpm dlx create-react-app app'), undefined)
})

test('字符串字面量里的 npm 不算命令（引号被剥离后失配）', () => {
  assert.equal(reasonFor('git commit -m "npm install"'), undefined)
  assert.equal(reasonFor('echo "npm install"'), undefined)
})

test('非命令位的裸词不拦', () => {
  assert.equal(reasonFor('echo npm install'), undefined)
  assert.equal(reasonFor('cmd /c npm install'), undefined)
})

test('非 shell 工具一律放行', () => {
  assert.equal(check('write', { file_path: 'C:\\a.js', content: 'const npm = 1' }), undefined)
  assert.equal(check('read', { file_path: 'C:\\npm' }), undefined)
})

test('缺 command 参数时放行（交给工具自身的 schema 报错）', () => {
  assert.equal(check('pwsh', {}), undefined)
  assert.equal(check('pwsh', { command: '' }), undefined)
})

test('拦截文案包含原始命令，且截断到 150 个字符', () => {
  const long = `npm install ${'a'.repeat(300)}`
  const reason = reasonFor(long)
  const commandLine = reason.split('\n')[1]
  assert.equal(commandLine, `   命令: ${long.substring(0, 150)}`)
})
