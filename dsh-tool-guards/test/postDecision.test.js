/**
 * `tools/post-execute` block 决策的形状契约。
 *
 * 为什么单独一个文件：这个形状踩过坑。harness 的 `postExecute` 拿到 block 决策后
 * 直接把 `decision.feedback` 当 content 用，并用
 * `failureMessageFromContent(decision.feedback)` 推错误消息——而后者内部是
 * `content.map(...)`。所以 `feedback` **必须是内容块数组**；
 * 传字符串会抛 `content.map is not a function`，整次工具调用失败
 * （2026-10-19 端到端验证时真实踩到，不是推测）。
 *
 * 这里把形状锁死，避免以后"顺手改成字符串"再崩一次。
 *
 * @module dsh-tool-guards/test/postDecision
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildBlockDecision } from '../lib/post/syntax.js'

describe('post-execute block 决策形状', () => {
  test('accept -> block：feedback 是内容块数组，不是字符串', () => {
    const decision = buildBlockDecision({ kind: 'accept' }, '语法错误', {})
    assert.equal(decision.kind, 'block')
    assert.ok(Array.isArray(decision.feedback), 'feedback 必须是数组')
    assert.deepEqual(decision.feedback, [{ type: 'text', text: '语法错误' }])
  })

  test('feedback 的每个元素都是 harness 认得的 text 块', () => {
    const { feedback } = buildBlockDecision({ kind: 'accept' }, 'x', {})
    for (const block of feedback) {
      assert.equal(typeof block, 'object')
      assert.equal(block.type, 'text')
      assert.equal(typeof block.text, 'string')
    }
  })

  test('模拟 harness 的 content.map：不抛异常', () => {
    const { feedback } = buildBlockDecision({ kind: 'accept' }, '语法错误', {})
    // 复刻 harness 的 failureMessageFromContent 实现
    const message = feedback.map((block) => (block.type === 'text' ? block.text : `[${block.type} content]`)).join('\n')
    assert.equal(message, '语法错误')
  })

  test('下游已是 block：追加理由，不覆盖对方反馈', () => {
    const downstream = { kind: 'block', feedback: [{ type: 'text', text: '别的插件先拒了' }] }
    const decision = buildBlockDecision(downstream, '语法错误', {})
    assert.equal(decision.feedback.length, 2)
    assert.deepEqual(decision.feedback[0], { type: 'text', text: '别的插件先拒了' })
    assert.deepEqual(decision.feedback[1], { type: 'text', text: '语法错误' })
  })

  test('下游 block 的 feedback 不是数组时也不炸', () => {
    const decision = buildBlockDecision({ kind: 'block', feedback: 'old-shape' }, '新的', {})
    assert.ok(Array.isArray(decision.feedback))
    assert.deepEqual(decision.feedback, [{ type: 'text', text: '新的' }])
  })

  test('合并 result 与 decision 两边的 additionalContexts', () => {
    const result = { additionalContexts: [{ from: 'result' }] }
    const downstream = { kind: 'accept', additionalContexts: [{ from: 'decision' }] }
    const decision = buildBlockDecision(downstream, 'x', result)
    assert.deepEqual(decision.additionalContexts, [{ from: 'result' }, { from: 'decision' }])
  })

  test('没有 additionalContexts 时不写这个键（避免无意义空数组）', () => {
    const decision = buildBlockDecision({ kind: 'accept' }, 'x', {})
    assert.equal(Object.hasOwn(decision, 'additionalContexts'), false)
  })
})
