/**
 * 插件装配测试：注册/回收、matcher 门控、fail-open。
 *
 * 用一个最小的假 ctx 代替宿主：这里要验的是「apply 做了什么」，
 * 而不是 cordis 本身的行为。
 *
 * @module dsh-tool-guards/test/apply
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// dsh 运行时包（`@deepseek-ai/dsh-home-paths` / `schemastery`）只在 dsh profile 内可解析。
// 这个文件是唯一需要它们的测试——其余 14 个测试文件只依赖 Node 内置模块，克隆下来就能跑。
// 为了「仓库脱离 profile 也全绿」，缺包时整组跳过并说明原因，而不是让整个文件报错。
// 用动态 import：静态 import 失败会直接杀死模块，连跳过都做不到。
let apply
let resolveDshHome
let skipReason
try {
  ;({ resolveDshHome } = await import('@deepseek-ai/dsh-home-paths'))
  ;({ apply } = await import('../index.js'))
} catch (error) {
  skipReason = `需要 dsh 运行时包，请在 dsh profile 内跑本文件：${error?.code ?? error?.message ?? error}`
}

/** 缺 dsh 包时跳过，而不是失败。 */
const testCase = skipReason
  ? (name) => test(name, { skip: skipReason }, () => {})
  : test

/**
 * 最小假 ctx：记录注册的 guard、effect 标签与日志，并能在「卸载」时回收。
 * 之所以要模拟 `effect`：插件把注册包在 ctx.effect 里，回收路径必须被真的走一遍，
 * 否则 HMR/unload 后残留一条旧 guard 的问题不会被发现。
 */
function createHarness() {
  const guards = []
  const disposers = []
  const logs = []
  return {
    guards,
    logs,
    ctx: {
      logger: {
        info: (message) => logs.push({ level: 'info', message }),
        warn: (message) => logs.push({ level: 'warn', message }),
      },
      tools: {
        guard(fn) {
          guards.push(fn)
          return () => {
            const index = guards.indexOf(fn)
            if (index !== -1) guards.splice(index, 1)
          }
        },
      },
      effect(execute, label) {
        this._labels ??= []
        this._labels.push(label)
        const dispose = execute()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
    },
    /** 模拟插件卸载。 */
    unload() {
      while (disposers.length > 0) disposers.pop()()
    },
    labels() {
      return this.ctx._labels ?? []
    },
  }
}

/** 写一份临时 hooks.json 并返回路径。 */
function writeConfig(text) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-guards-apply-'))
  const path = join(dir, 'hooks.json')
  writeFileSync(path, text, 'utf8')
  return path
}

/** 只有 npm guard 一份的最小配置。 */
function npmOnly(matcher) {
  const group = { hooks: [{ type: 'command', command: 'node "C:/h/npm-guard.mjs"', timeout: 10 }] }
  if (matcher !== undefined) group.matcher = matcher
  return JSON.stringify({ hooks: { PreToolUse: [group] } })
}

testCase('真实 hooks.json：注册一条组合 guard，npm 被拦、pnpm 放行', (t) => {
  // 路径随插件默认值一起演进。2026-10-18 配置从 ~/.dsh/claude-hooks/ 迁到
  // ~/.dsh/tool-guards/，这条测试当时漏改，于是一直在静默 skip——
  // 等于「真实配置」这一层从来没被验证过。别再让它静默失效。
  const hooksPath = `${resolveDshHome()}/tool-guards/hooks.json`
  if (!existsSync(hooksPath)) {
    t.skip(`本机没有 ${hooksPath}`)
    return
  }
  // 换台机器时配置可能不含 npm guard；断言的是「npm 被拦」，
  // 前提不成立就该跳过，而不是给出一个看起来像 bug 的红。
  if (!readFileSync(hooksPath, 'utf8').includes('npm-guard.mjs')) {
    t.skip(`${hooksPath} 未启用 npm-guard`)
    return
  }
  const harness = createHarness()
  apply(harness.ctx, { hooksPath, diagnostics: false })

  assert.equal(harness.guards.length, 1, '每次 apply 只应注册一条组合 guard')
  assert.deepEqual(harness.labels(), ['tool-guards'])

  const guard = harness.guards[0]
  assert.equal(typeof guard({ name: 'pwsh', arguments: { command: 'npm install lodash' } }), 'string')
  assert.equal(guard({ name: 'pwsh', arguments: { command: 'pnpm install' } }), undefined)
  assert.equal(guard({ name: 'write', arguments: { file_path: 'C:\\a\\b.js', content: 'const a = 1\n' } }), undefined)
})

testCase('matcher 门控：只覆盖 pwsh 时 bash 不受影响', () => {
  const harness = createHarness()
  apply(harness.ctx, { hooksPath: writeConfig(npmOnly('pwsh')), diagnostics: false })
  const guard = harness.guards[0]
  assert.equal(typeof guard({ name: 'pwsh', arguments: { command: 'npm i' } }), 'string')
  assert.equal(guard({ name: 'bash', arguments: { command: 'npm i' } }), undefined)
})

testCase('matcher 缺省时覆盖所有工具名', () => {
  const harness = createHarness()
  apply(harness.ctx, { hooksPath: writeConfig(npmOnly()), diagnostics: false })
  const guard = harness.guards[0]
  assert.equal(typeof guard({ name: 'bash', arguments: { command: 'npm i' } }), 'string')
  assert.equal(typeof guard({ name: 'pwsh', arguments: { command: 'npm i' } }), 'string')
})

testCase('hooks.json 缺失：fail-open，不注册 guard，但 warn 一定留痕', () => {
  const harness = createHarness()
  apply(harness.ctx, {
    hooksPath: join(tmpdir(), 'dsh-tool-guards-missing', 'hooks.json'),
    diagnostics: false,
  })
  assert.equal(harness.guards.length, 0)
  assert.ok(harness.logs.some((log) => log.level === 'warn' && /没有启用任何 guard/.test(log.message)))
  assert.ok(harness.logs.some((log) => log.level === 'warn' && /读取 hooks.json 失败/.test(log.message)))
})

testCase('hooks.json 是坏 JSON：不抛异常（绝不能拖垮启动）', () => {
  const harness = createHarness()
  assert.doesNotThrow(() => apply(harness.ctx, { hooksPath: writeConfig('{ oops'), diagnostics: false }))
  assert.equal(harness.guards.length, 0)
  assert.ok(harness.logs.some((log) => log.level === 'warn' && /解析失败/.test(log.message)))
})

testCase('diagnostics: false 时一条 info 都不输出', () => {
  const harness = createHarness()
  apply(harness.ctx, { hooksPath: writeConfig(npmOnly()), diagnostics: false })
  assert.equal(harness.logs.length, 0)
})

testCase('diagnostics: true 时输出启用清单', () => {
  const harness = createHarness()
  apply(harness.ctx, { hooksPath: writeConfig(npmOnly()), diagnostics: true })
  assert.ok(harness.logs.some((log) => log.level === 'info' && /已启用 guard: npm\(matcher=\*\)/.test(log.message)))
})

testCase('卸载后 guard 被回收（effect disposer 真的生效）', () => {
  const harness = createHarness()
  apply(harness.ctx, { hooksPath: writeConfig(npmOnly()), diagnostics: false })
  assert.equal(harness.guards.length, 1)
  harness.unload()
  assert.equal(harness.guards.length, 0)
})

testCase('exec 形状异常时不抛：缺 arguments、空 name', () => {
  const harness = createHarness()
  apply(harness.ctx, { hooksPath: writeConfig(npmOnly()), diagnostics: false })
  const guard = harness.guards[0]
  assert.equal(guard({ name: 'pwsh' }), undefined)
  assert.equal(guard({}), undefined)
  // 工具名为空但拿得到命令行时仍按 shell 处理——这与 hook-input.mjs 的
  // 「Boolean(getCommand())」兜底一致，不是本次移植新加的行为。
  assert.equal(typeof guard({ name: '', arguments: { command: 'npm i' } }), 'string')
})

testCase('一条 guard 抛异常时降级为放行，并只记一次 warn', () => {
  const harness = createHarness()
  apply(harness.ctx, { hooksPath: writeConfig(npmOnly()), diagnostics: false })
  const guard = harness.guards[0]
  // 用会抛的 getter 模拟 guard 内部 bug：a.command 读取即抛。
  const hostile = { get command() { throw new Error('boom') } }
  assert.equal(guard({ name: 'pwsh', arguments: hostile }), undefined)
  assert.equal(guard({ name: 'pwsh', arguments: hostile }), undefined)
  assert.equal(harness.logs.filter((log) => /抛异常/.test(log.message)).length, 1)
})
