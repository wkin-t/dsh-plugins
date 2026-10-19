import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SOURCE_KIND, isMemoryMessage, lastInjectedPayload, planInjection } from '../lib/inject.js'

/** 构造一条本插件注入的记忆消息。 */
const mem = (text) => ({
  content: [{ type: 'text', text }],
  source: { kind: SOURCE_KIND, form: 'instructions' },
})

/** 构造一条普通用户消息。 */
const user = (text) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/**
 * 构造假 agent。
 * @param seqs - 可见面节点序号（顺序即 `surface.nodes` 的顺序）。
 * @param events - 序号 → 事件。
 */
const agentWith = (seqs, events) => ({
  session: {
    surface: { nodes: seqs },
    eventAt: (seq) => events[seq],
  },
})

const userMessageEvent = (data) => ({ type: 'user/message', data })

// ---------------------------------------------------------------- isMemoryMessage

test('isMemoryMessage: 只认本插件注入的消息', () => {
  assert.equal(isMemoryMessage(mem('a')), true)
  assert.equal(isMemoryMessage(user('a')), false)
  assert.equal(isMemoryMessage({ source: { kind: 'claude-memory' } }), true)
  assert.equal(isMemoryMessage({}), false)
  assert.equal(isMemoryMessage(undefined), false)
})

// ------------------------------------------------------------- lastInjectedPayload

test('lastInjectedPayload: 取批次里最后一条记忆消息', () => {
  const found = lastInjectedPayload(undefined, [mem('旧'), user('x'), mem('新')])
  assert.equal(found.content[0].text, '新')
  assert.deepEqual(found.source, { kind: SOURCE_KIND, form: 'instructions' })
})

test('lastInjectedPayload: 批次优先于可见面', () => {
  const agent = agentWith([1], { 1: userMessageEvent(mem('可见面')) })
  assert.equal(lastInjectedPayload(agent, [mem('批次')]).content[0].text, '批次')
})

test('lastInjectedPayload: 批次无命中时回退可见面', () => {
  const agent = agentWith([1, 2], {
    1: userMessageEvent(mem('可见面旧')),
    2: userMessageEvent(mem('可见面新')),
  })
  assert.equal(lastInjectedPayload(agent, [user('x')]).content[0].text, '可见面新')
})

test('lastInjectedPayload: 可见面里有多条时取最新一条（H2：不能取任意旧条）', () => {
  // A→B→A 序列：旧 A 在前、B 在后。必须取到 B，否则会误判"已是 A"而漏更新。
  const agent = agentWith([1, 2], {
    1: userMessageEvent(mem('A')),
    2: userMessageEvent(mem('B')),
  })
  assert.equal(lastInjectedPayload(agent, []).content[0].text, 'B')
})

test('lastInjectedPayload: 忽略可见面里的非记忆消息', () => {
  const agent = agentWith([1, 2], { 1: userMessageEvent(user('普通')), 2: { type: 'assistant/message' } })
  assert.equal(lastInjectedPayload(agent, []), undefined)
})

test('lastInjectedPayload: 压缩后可见面已无记忆消息 → undefined', () => {
  // compaction 把旧节点从 surface.nodes 摘掉后，可见面只剩摘要与后续对话。
  const agent = agentWith([900, 901], {
    900: userMessageEvent(user('压缩摘要')),
    901: { type: 'assistant/message' },
  })
  assert.equal(lastInjectedPayload(agent, []), undefined)
})

test('lastInjectedPayload: 无 surface 时返回 undefined', () => {
  assert.equal(lastInjectedPayload(undefined, []), undefined)
  assert.equal(lastInjectedPayload({}, []), undefined)
  assert.equal(lastInjectedPayload({ session: {} }, []), undefined)
  assert.equal(lastInjectedPayload({ session: { surface: { nodes: 'nope' } } }, []), undefined)
})

// ------------------------------------------------------------------- planInjection

test('planInjection: 无内容时不注入', () => {
  const decision = { kind: 'enter', messages: [user('a')] }
  assert.equal(planInjection({ decision, step: 2, claimedMessages: [], desired: undefined, latest: undefined }), decision)
})

test('planInjection: reject 时原样透传', () => {
  const decision = { kind: 'reject' }
  assert.equal(
    planInjection({ decision, step: 2, claimedMessages: [], desired: mem('m'), latest: undefined }),
    decision,
  )
})

test('planInjection: 首步空批次不注入（保留官方首步限定，H1）', () => {
  const decision = { kind: 'enter', messages: [] }
  assert.equal(
    planInjection({ decision, step: 1, claimedMessages: [], desired: mem('m'), latest: undefined }),
    decision,
  )
})

test('planInjection: 首步但批次非空 → 注入（压缩后重注入就是这个形态）', () => {
  const claimed = user('摘要')
  const decision = { kind: 'enter', messages: [claimed] }
  const desired = mem('m')
  const out = planInjection({ decision, step: 1, claimedMessages: [claimed], desired, latest: undefined })
  assert.notEqual(out, decision)
  assert.deepEqual(out.messages, [claimed, desired])
})

test('planInjection: 内容未变 → 不重复注入', () => {
  const desired = mem('同样内容')
  const decision = { kind: 'enter', messages: [user('a')] }
  const latest = { content: desired.content, source: desired.source }
  assert.equal(planInjection({ decision, step: 2, claimedMessages: [], desired, latest }), decision)
})

test('planInjection: 只有 source 不同也算变化 → 重新注入', () => {
  const desired = mem('同样内容')
  const decision = { kind: 'enter', messages: [user('a')] }
  const latest = { content: desired.content, source: { kind: SOURCE_KIND, form: 'other' } }
  assert.notEqual(planInjection({ decision, step: 2, claimedMessages: [], desired, latest }), decision)
})

test('planInjection: 内容变了 → 重新注入（A→B→A 的第二个 A）', () => {
  // 可见面最新是 B，本次要注入 A：不能因为"历史上出现过 A"就跳过。
  const desired = mem('A')
  const decision = { kind: 'enter', messages: [user('a')] }
  const latest = { content: [{ type: 'text', text: 'B' }], source: desired.source }
  const out = planInjection({ decision, step: 2, claimedMessages: [], desired, latest })
  assert.notEqual(out, decision)
  // claimedMessages 为空 → findLastIndex 返回 -1 → 插到最前
  assert.equal(out.messages[0], desired)
})

test('planInjection: 压缩后可见面无记忆消息 → 重新注入', () => {
  const claimed = user('压缩摘要')
  const decision = { kind: 'enter', messages: [claimed] }
  const desired = mem('m')
  // latest === undefined 正是 lastInjectedPayload 在压缩后返回的值
  const out = planInjection({ decision, step: 5, claimedMessages: [claimed], desired, latest: undefined })
  assert.notEqual(out, decision)
  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[1], desired)
})

test('planInjection: 插在最后一条已领取消息之后', () => {
  const first = user('1')
  const second = user('2')
  const tail = user('3')
  const decision = { kind: 'enter', messages: [first, second, tail] }
  const desired = mem('m')
  const out = planInjection({ decision, step: 3, claimedMessages: [first, second], desired, latest: undefined })
  assert.deepEqual(out.messages, [first, second, desired, tail])
})

test('planInjection: 无已领取消息时插到最前', () => {
  const a = user('1')
  const b = user('2')
  const decision = { kind: 'enter', messages: [a, b] }
  const desired = mem('m')
  const out = planInjection({ decision, step: 3, claimedMessages: [], desired, latest: undefined })
  assert.deepEqual(out.messages, [desired, a, b])
})

test('planInjection: 不修改原 decision（返回新对象）', () => {
  const claimed = user('1')
  const decision = { kind: 'enter', messages: [claimed] }
  const before = decision.messages.slice()
  planInjection({ decision, step: 3, claimedMessages: [claimed], desired: mem('m'), latest: undefined })
  assert.deepEqual(decision.messages, before)
  assert.equal(decision.messages.length, 1)
})

test('planInjection: 保留 decision 的其余字段', () => {
  const claimed = user('1')
  const decision = { kind: 'enter', messages: [claimed], startsRequestSeries: true }
  const out = planInjection({ decision, step: 3, claimedMessages: [claimed], desired: mem('m'), latest: undefined })
  assert.equal(out.startsRequestSeries, true)
  assert.equal(out.kind, 'enter')
})
