/**
 * 注入决策逻辑（纯函数，不依赖 dsh 运行时）。
 *
 * 独立成模块有两个理由：
 *
 * 1. **可测**：`index.js` 依赖 `@deepseek-ai/schemastery` / `dsh-llm` / `dsh-home-paths`，
 *    这些只在 dsh 运行时内可解析，脱离 dsh 无法 import。本模块只用 `node:util`，
 *    因此能在 `node --test` 下直接验证。
 * 2. **这几条路径无法在真实会话里按需触发**：压缩后重注入、A→B→A 内容变更、
 *    首步空批次，都只能构造 surface / decision 来验证。
 *
 * @module dsh-claude-memory/lib/inject
 */
import { isDeepStrictEqual } from 'node:util'

/** 消息来源标识，用于在会话可见面中认出自己注入过的消息。 */
export const SOURCE_KIND = 'claude-memory'

/**
 * 判断一条消息是否由本插件注入。
 * @param message - 候选消息。
 * @returns 是否为本插件产出。
 */
export function isMemoryMessage(message) {
  return message?.source?.kind === SOURCE_KIND
}

/**
 * 找出会话中**最后一条**本插件注入的消息。
 *
 * 搜索顺序：先看本步进入批次（`decisionMessages`，比可见面更新），再从可见面反向扫。
 *
 * 评审 H2：不能"扫到任意历史相同 payload 就跳过"。A→B→A 序列下，旧 A 仍留在可见面里，
 * 若按"存在即跳过"处理，模型实际停留在 B 而插件以为已是 A，造成漏更新。
 * 因此只取**最新**一条做比较。
 *
 * **压缩后的行为就落在这里**：compaction 会把旧节点从 `session.surface.nodes` 摘掉，
 * 于是这里返回 undefined，调用方据此重新注入。
 *
 * @param agent - 当前 agent（只读 `session.surface.nodes` 与 `session.eventAt`）。
 * @param decisionMessages - 本步进入批次的消息。
 * @returns 最后一条 payload（`{ content, source }`），或 undefined。
 */
export function lastInjectedPayload(agent, decisionMessages) {
  for (let i = decisionMessages.length - 1; i >= 0; i -= 1) {
    const message = decisionMessages[i]
    if (isMemoryMessage(message)) return { content: message.content, source: message.source }
  }

  const nodes = agent?.session?.surface?.nodes
  if (!Array.isArray(nodes)) return undefined
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const event = agent.session.eventAt?.(nodes[i])
    if (event?.type === 'user/message' && isMemoryMessage(event.data)) {
      return { content: event.data.content, source: event.data.source }
    }
  }
  return undefined
}

/**
 * 决定本步是否注入、以及注入后进入批次的消息序列。
 *
 * 各分支的理由：
 * - `desired === undefined`：项目没有 auto memory，或内容渲染后为空 → 什么都不做。
 * - `reject`：下游已决定不发请求，注入没有意义。
 * - `step === 1 && messages.length === 0`：保留官方的"首步空批次"限定（评审 H1）。
 *   去掉它会把后续续步的空批次也误判为不发请求，导致当前 turn 内持续漏注入。
 * - `latest` 与 `desired` 深度相等：可见面里最新那条记忆就是本次要注入的内容 → 跳过。
 * - 否则插入。压缩后可见面里已无记忆消息，`latest` 为 undefined，自然走到这里 → 重注入。
 *
 * @param input.decision - 下游决策。
 * @param input.step - 当前步号。
 * @param input.claimedMessages - 本步已领取的消息（`agent/pre-step` 的 `messages`）。
 * @param input.desired - 本次要注入的消息；undefined 表示无内容。
 * @param input.latest - 可见面中最后一条已注入的记忆消息；undefined 表示没有。
 * @returns 应当返回给下游的决策。
 */
export function planInjection({ decision, step, claimedMessages, desired, latest }) {
  if (desired === undefined) return decision
  if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
  if (
    latest !== undefined &&
    isDeepStrictEqual(latest.content, desired.content) &&
    isDeepStrictEqual(latest.source, desired.source)
  ) {
    return decision
  }

  // `findLastIndex` 可能返回 -1（本步没有已领取消息）。此时 toSpliced(0, 0, …)
  // 会把 baseline 插到批次最前——这正是它该在的位置，故不特殊处理。
  const lastClaimedIndex = decision.messages.findLastIndex((message) => claimedMessages.includes(message))
  return { ...decision, messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired) }
}
