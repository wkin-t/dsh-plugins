import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { test } from 'node:test'
import { resolveWorkingDirectory } from '../lib/working-dir.js'

/** 构造带 header.cwd 的假 agent。 */
const agentWithHeader = (cwd) => ({ session: { header: { cwd } } })

/** 构造带 `get` 的服务桩；`fn` 可返回目录、抛错或返回空。 */
const serviceWithGet = (fn) => ({ get: fn })

test('workingDirectory: 服务返回的有效目录优先于 session header.cwd（子代理场景）', () => {
  const session = { header: { cwd: '/workspace/parent' } }
  const seen = []
  const workingDirectory = serviceWithGet((received) => {
    seen.push(received)
    return '/workspace/effective'
  })
  assert.equal(resolveWorkingDirectory({ session }, { workingDirectory }), '/workspace/effective')
  assert.equal(seen.length, 1)
  assert.equal(seen[0], session, '必须把 agent.session 传给服务')
})

test('workingDirectory: 服务返回 undefined 时回退 session header.cwd', () => {
  const agent = agentWithHeader('/workspace/header')
  assert.equal(
    resolveWorkingDirectory(agent, { workingDirectory: serviceWithGet(() => undefined) }),
    '/workspace/header',
  )
})

test('workingDirectory: 服务返回空串/纯空白时回退 session header.cwd', () => {
  const agent = agentWithHeader('/workspace/header')
  assert.equal(
    resolveWorkingDirectory(agent, { workingDirectory: serviceWithGet(() => '') }),
    '/workspace/header',
  )
  assert.equal(
    resolveWorkingDirectory(agent, { workingDirectory: serviceWithGet(() => '   ') }),
    '/workspace/header',
  )
})

test('workingDirectory: 服务返回非字符串时回退 session header.cwd', () => {
  const agent = agentWithHeader('/workspace/header')
  assert.equal(
    resolveWorkingDirectory(agent, { workingDirectory: serviceWithGet(() => 42) }),
    '/workspace/header',
  )
})

test('workingDirectory: 服务 .get 抛错时吞掉并回退 session header.cwd', () => {
  const agent = agentWithHeader('/workspace/header')
  const workingDirectory = serviceWithGet(() => {
    throw new Error('service exploded')
  })
  assert.equal(resolveWorkingDirectory(agent, { workingDirectory }), '/workspace/header')
})

test('workingDirectory: 服务缺席时回退 session header.cwd', () => {
  const agent = agentWithHeader('/workspace/header')
  assert.equal(resolveWorkingDirectory(agent, { workingDirectory: undefined }), '/workspace/header')
  assert.equal(resolveWorkingDirectory(agent, {}), '/workspace/header')
})

test('workingDirectory: 服务对象没有 get 方法时视为不可用', () => {
  const agent = agentWithHeader('/workspace/header')
  assert.equal(resolveWorkingDirectory(agent, { workingDirectory: {} }), '/workspace/header')
})

test('workingDirectory: header.cwd 缺失时回落到 process.cwd()', () => {
  assert.equal(resolveWorkingDirectory({ session: { header: {} } }, {}), process.cwd())
  assert.equal(resolveWorkingDirectory({ session: {} }, {}), process.cwd())
  assert.equal(resolveWorkingDirectory(undefined, {}), process.cwd())
  assert.equal(isAbsolute(resolveWorkingDirectory(undefined, {})), true)
})

test('workingDirectory: header.cwd 为空白字符串时回落到 process.cwd()', () => {
  assert.equal(resolveWorkingDirectory(agentWithHeader('   '), {}), process.cwd())
})
