/**
 * dsh-tool-guards —— 把 Claude Code 时代的 hook guard 搬成 dsh 进程内同步 guard。
 *
 * 为什么不再走 hook 桥接：这台机器上 `@deepseek-ai/dsh-hooks-claude-code` 的包体缺失
 * （`fiberPhase: null`），`~/.dsh/claude-hooks/hooks.json` 里的 7 个 hook 全部不生效。
 * dsh 提供了原生替代 `ctx.tools.guard()`：同步、单调 deny、返回字符串即拒绝该次调用，
 * 不依赖任何外部进程，因此不受桥接状态影响。
 *
 * 分工：
 * - `hooks.json` 决定**启用哪些 guard**（以及各自的 matcher）；
 * - `lib/guards/*` 决定**怎么判**（正则与文案照搬 CC 脚本，差分测试逐字比对）。
 *
 * @module dsh-tool-guards
 */
import z from '@deepseek-ai/schemastery'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { asObject } from './lib/shared.js'
import { describeEnabled, guardAppliesTo, readHooksConfig } from './lib/hooks-config.js'
import { buildBlockDecision, planCheck, runChecker } from './lib/post/syntax.js'
import * as deprecatedGuard from './lib/guards/deprecated.js'
import * as gitSafetyGuard from './lib/guards/gitSafety.js'
import * as npmGuard from './lib/guards/npm.js'
import * as pythonCmdGuard from './lib/guards/pythonCmd.js'
import * as truncationGuard from './lib/guards/truncation.js'

/** 插件根目录：检查器脚本按它定位。 */
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))

/** 插件显示名。 */
export const name = 'tool-guards'

/**
 * 必需服务：整个插件只做一件事——往 `ctx.tools` 上挂 guard。
 * 少了 `tools` 就没有挂载点，因此这是硬依赖而不是可选依赖。
 */
export const inject = ['tools']

/** 已移植的 guard 清单；`id`/`script` 由各模块自己声明，避免两处字符串漂移。 */
const GUARDS = [deprecatedGuard, gitSafetyGuard, npmGuard, pythonCmdGuard, truncationGuard]

/** 传给 `hooks-config` 的目录：只认 id 与脚本文件名，不泄露 check 实现。 */
const CATALOG = GUARDS.map(({ id, script }) => ({ id, script }))

/** 插件配置 schema。 */
export const Config = z.object({
  hooksPath: z.string().default(''),
  diagnostics: z.boolean().default(true),
  /**
   * SSH 远程写代码的软提醒（只写日志，不拦截）。
   *
   * 默认开：原脚本一直是开着的，关掉等于静默丢弃这条提醒。
   * 单独给开关是因为它会在每次命中的调用上各写一条日志，
   * 频繁跑远程运维命令时会显得吵。
   */
  sshRemoteWriteWarning: z.boolean().default(true),
  /**
   * 写文件后的语法自检（对应原 PostToolUse 的两个检查器）。
   *
   * 默认**关**：它每次写 `.py`/`.ts` 都要起一个子进程，而本插件的其余部分
   * 是零子进程的同步 guard。原配置里它是开着的，但那时是 hook 桥接统一调度；
   * 这里默认关、由用户显式开启，避免"装个安全插件却发现每次写文件都变慢"。
   */
  postSyntaxCheck: z.boolean().default(false),
  /** 语法检查超时（毫秒），对齐原 hooks.json 的 20s。 */
  postSyntaxTimeoutMs: z.number().default(20000),
})

/**
 * 解析配置：`hooksPath` 空值落到 `$DSH_HOME/tool-guards/hooks.json`。
 *
 * 为什么不在旧的 `$DSH_HOME/claude-hooks/` 下：那棵树原本只为已失效的 hook 桥接服务，
 * 现已整体退役；本插件把自己的配置放在自己的目录里，避免"删了旧树、安全网静默失效"。
 * 旧树里的 guard 脚本已 vendor 到 `oracle/`，仅作差分测试的真值来源，不参与运行。
 * @param config - 原始插件配置。
 * @returns 归一化后的配置。
 */
function resolveConfig(config) {
  const raw = typeof config?.hooksPath === 'string' ? config.hooksPath.trim() : ''
  const hooksPath = raw.length === 0
    ? `${resolveDshHome()}/tool-guards/hooks.json`
    : expandHomePath(raw)
  return {
    hooksPath,
    diagnostics: config?.diagnostics !== false,
    sshRemoteWriteWarning: config?.sshRemoteWriteWarning !== false,
    postSyntaxCheck: config?.postSyntaxCheck === true,
    postSyntaxTimeoutMs:
      typeof config?.postSyntaxTimeoutMs === 'number' && config.postSyntaxTimeoutMs > 0
        ? config.postSyntaxTimeoutMs
        : 20000,
  }
}

/**
 * 装载插件。
 * @param ctx - cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const log = (level, message) => ctx.logger?.[level]?.(`tool-guards: ${message}`)

  const { enabled, diagnostics } = readHooksConfig(resolved.hooksPath, CATALOG)
  for (const diagnostic of diagnostics) {
    // warn 永不被 `diagnostics: false` 吞掉：fail-open 必须留痕，否则「规则没生效」
    // 会表现得和「规则没写」一模一样，排查时无从下手。
    if (resolved.diagnostics || diagnostic.level === 'warn') log(diagnostic.level, diagnostic.message)
  }

  if (enabled.length === 0) {
    log('warn', `没有启用任何 guard（hooksPath=${resolved.hooksPath}）；工具调用将不做任何拦截`)
    return
  }

  const byId = new Map(GUARDS.map((guard) => [guard.id, guard]))
  const active = enabled.map((entry) => ({ entry, check: byId.get(entry.id).check }))
  if (resolved.diagnostics) log('info', `已启用 guard: ${describeEnabled(enabled)}`)

  /** 已经报过异常的 guard；guard 是每次工具调用都要跑的，重复刷日志没有信息量。 */
  const reported = new Set()

  /**
   * 单条 guard 抛异常时记一次日志并继续。
   *
   * 为什么不在外层放开让异常冒出去：`guardReason()` 是同步遍历，异常会直接打断
   * 整次工具调用（表现为一个与 guard 无关的报错），等于「一个 guard 有 bug →
   * 所有工具都不能用」。这里选择降级为「这条规则这次不生效」+ 可见日志。
   *
   * @param id - guard 标识。
   * @param error - 捕获到的异常。
   */
  const reportGuardFailure = (id, error) => {
    if (reported.has(id)) return
    reported.add(id)
    log('warn', `guard "${id}" 抛异常（本次按放行处理），后续不再重复记录该异常：${error?.stack ?? error}`)
  }

  /**
   * 依次询问已启用且 matcher 命中的 guard，返回第一条拒绝理由。
   * @param exec - dsh 的工具执行信息：`{ name, arguments }`。
   * @returns 拒绝理由；全部放行时返回 undefined。
   */
  const evaluate = (exec) => {
    const toolName = typeof exec.name === 'string' ? exec.name : ''
    const args = asObject(exec.arguments)
    for (const { entry, check } of active) {
      if (!guardAppliesTo(entry, toolName)) continue
      let reason
      try {
        reason = check(toolName, args)
      } catch (error) {
        reportGuardFailure(entry.id, error)
        continue
      }
      // 只接受非空字符串：guard 返回空串属于实现 bug，
      // 真让它传下去会变成一次「没有理由的拒绝」，模型只会看到空白。
      if (typeof reason === 'string' && reason.length > 0) return reason
    }

    // 软提醒走在这里：它**不能**变成拒绝理由，否则就把「提醒」升级成了「拦截」，
    // 语义与原脚本不一致（远程运维命令会被一起挡掉）。
    // 只在 gitSafety 这条 guard 启用时才提醒：提醒逻辑本来就长在它的代码里，
    // 用户关掉 gitSafety 却还收到它的提醒会很奇怪。
    if (resolved.sshRemoteWriteWarning && active.some(({ entry }) => entry.id === gitSafetyGuard.id)) {
      try {
        const warning = gitSafetyGuard.sshRemoteWriteWarning?.(toolName, args)
        if (warning) log('warn', warning)
      } catch (error) {
        reportGuardFailure('sshRemoteWriteWarning', error)
      }
    }
    return undefined
  }

  // guard 注册挂在 ctx.effect 上：`tools.guard()` 自己返回的 disposer 已绑 ctx，
  // 这里再包一层是为了让「注册」这件事显式出现在 effect 树里——
  // HMR / unload 时能确定它被回收，不会残留一条指向上一个模块实例的 guard。
  ctx.effect(() => ctx.tools.guard(evaluate), 'tool-guards')

  if (resolved.postSyntaxCheck) {
    if (resolved.diagnostics) log('info', `写后语法检查已启用（超时 ${resolved.postSyntaxTimeoutMs}ms）`)
    ctx.effect(
      () =>
        ctx.on('tools/post-execute', async (exec, result, next) => {
          const decision = await next()
          const plan = planCheck(exec)
          if (!plan) return decision

          let reason
          try {
            reason = await runChecker({
              kind: plan.kind,
              pluginRoot: PLUGIN_ROOT,
              exec,
              timeoutMs: resolved.postSyntaxTimeoutMs,
            })
          } catch (error) {
            // 检查器自己坏了不能连累工具调用：放行并留一次 warn。
            reportGuardFailure('postSyntaxCheck', error)
            return decision
          }
          if (!reason) return decision

          // 与 Claude Code 的 PostToolUse `exit 2` 对齐：把这次调用转成失败，
          // 理由交给模型，让它立刻回来修语法。
          // 决策形状由 buildBlockDecision 统一负责（feedback 必须是内容块数组，
          // 传字符串会让 harness 抛 content.map is not a function）。
          return buildBlockDecision(decision, reason, result)
        }),
      'tool-guards-post-syntax',
    )
  }
}
