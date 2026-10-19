/**
 * 读 `~/.dsh/claude-hooks/hooks.json`，解析出「哪些 guard 启用、各自匹配哪些工具」。
 *
 * 这一步只决定**开关**：判定逻辑（正则、文案）留在 `lib/guards/` 里，
 * 因此 CC 侧改 hook 只影响启用与否，不会让两边的判定悄悄分叉。
 *
 * 失败一律 fail-open（全部不启用）+ 一条可诊断的原因：插件是加载期同步执行的，
 * 这里抛错会让 dsh 起不来，代价远大于「少拦几次工具调用」。
 *
 * @module dsh-tool-guards/hooks-config
 */
import { readFileSync } from 'node:fs'

/**
 * @typedef {{ level: 'info' | 'warn', message: string }} Diagnostic
 * @typedef {{ id: string, script: string }} CatalogEntry 一条 guard 的 id 与它对应的 CC 脚本文件名
 * @typedef {{ id: string, matchAll: boolean, patterns: string[], regexes: RegExp[] }} EnabledGuard
 *   一条已启用 guard 的匹配规则；`matchAll` 表示 hooks.json 里没写 matcher。
 */

/**
 * 从 hook 命令里抠出脚本文件名。
 *
 * 命令形如 `node "C:/Users/x/.dsh/claude-hooks/helpers/npm-guard.mjs"`，
 * 路径可能带引号、可能带空格，所以先按「带引号的一段」优先匹配，
 * 再退回「非空白的一段」。只取 basename，比较时忽略大小写（Windows 路径）。
 *
 * @param command - hooks.json 里的 command 字符串。
 * @returns 脚本文件名（小写）；解析不出时为空串。
 */
export function scriptNameOfCommand(command) {
  if (typeof command !== 'string') return ''
  const match = command.match(/"([^"]*\.mjs)"|'([^']*\.mjs)'|(\S*\.mjs)/i)
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? ''
  return raw.split(/[/\\]/).pop().toLowerCase()
}

/**
 * 把 matcher 字符串编译成匹配函数所需的形状。
 *
 * 语义（照 CC 的 matcher 约定）：缺省或空白 = 匹配所有工具；否则按 `|` 切成
 * 若干**正则**分支，任一条命中即可，比较不区分大小写。
 *
 * 非法正则只丢弃该分支并记一条诊断，**不**退化成「匹配所有」——
 * 一个笔误把 guard 放到全部工具上，比少拦几次危险得多。
 *
 * @param matcher - matcher 原文，可能为 undefined。
 * @returns `{ matchAll, patterns, regexes }`。
 */
function compileMatcher(matcher) {
  const text = matcher === undefined || matcher === null ? '' : String(matcher).trim()
  if (text.length === 0) return { matchAll: true, patterns: [], regexes: [], invalid: [] }

  const patterns = text.split('|').map((branch) => branch.trim()).filter(Boolean)
  if (patterns.length === 0) return { matchAll: true, patterns: [], regexes: [], invalid: [] }

  const regexes = []
  const invalid = []
  for (const pattern of patterns) {
    try {
      regexes.push(new RegExp(pattern, 'i'))
    } catch {
      invalid.push(pattern)
    }
  }
  return { matchAll: false, patterns, regexes, invalid }
}

/**
 * 解析 hooks.json 原文。
 *
 * 只认 `hooks.PreToolUse`：PostToolUse 的两个语法检查器需要工具**返回值**，
 * 进程内同步 guard 拿不到，属于另一次移植。
 *
 * @param text - hooks.json 原文。
 * @param catalog - 本插件已移植的 guard 清单 `[{ id, script }]`。
 * @returns `{ enabled, diagnostics }`；解析失败时 `enabled` 为空数组。
 */
export function parseHooksConfig(text, catalog) {
  /** @type {EnabledGuard[]} */
  const enabled = []
  /** @type {Diagnostic[]} */
  const diagnostics = []
  const byScript = new Map(catalog.map((entry) => [entry.script.toLowerCase(), entry.id]))
  const byId = new Map()

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      enabled,
      diagnostics: [{ level: 'warn', message: `hooks.json 解析失败（${error.message}）；按 fail-open 处理，所有 guard 不启用` }],
    }
  }

  const groups = parsed?.hooks?.PreToolUse
  if (groups === undefined) {
    return {
      enabled,
      diagnostics: [{ level: 'warn', message: 'hooks.json 里没有 hooks.PreToolUse 段；所有 guard 不启用' }],
    }
  }
  if (!Array.isArray(groups)) {
    return {
      enabled,
      diagnostics: [{ level: 'warn', message: 'hooks.json 的 hooks.PreToolUse 不是数组；所有 guard 不启用' }],
    }
  }

  for (const group of groups) {
    const compiled = compileMatcher(group?.matcher)
    for (const pattern of compiled.invalid) {
      diagnostics.push({
        level: 'warn',
        message: `matcher 分支不是合法正则（${JSON.stringify(pattern)}），已丢弃；该分支覆盖的工具不会被本组 guard 检查`,
      })
    }

    const hooks = Array.isArray(group?.hooks) ? group.hooks : []
    for (const hook of hooks) {
      const type = hook?.type ?? 'command'
      if (type !== 'command') {
        diagnostics.push({ level: 'info', message: `跳过非 command 类型的 hook（type=${String(type)}）` })
        continue
      }

      const script = scriptNameOfCommand(hook?.command)
      const id = byScript.get(script)
      if (id === undefined) {
        diagnostics.push({
          level: 'info',
          message: `跳过未移植为 guard 的 PreToolUse 命令：${String(hook?.command ?? '(空)')}`,
        })
        continue
      }

      // 同一个 guard 出现在多个分组时取并集（任一分组允许即启用），
      // 与 CC 串行执行全部 hook 的语义一致。
      let entry = byId.get(id)
      if (entry === undefined) {
        entry = {
          id,
          matchAll: compiled.matchAll,
          patterns: [...compiled.patterns],
          regexes: [...compiled.regexes],
        }
        byId.set(id, entry)
        enabled.push(entry)
        continue
      }
      entry.matchAll = entry.matchAll || compiled.matchAll
      entry.patterns.push(...compiled.patterns)
      entry.regexes.push(...compiled.regexes)
    }
  }

  return { enabled, diagnostics }
}

/**
 * 同步读取并解析 hooks.json。
 *
 * 用同步 I/O 而不是 await：`apply()` 里的注册必须是同步完成的，
 * 否则注册完成前到达的工具调用会漏检。
 *
 * @param path - hooks.json 绝对路径。
 * @param catalog - 本插件已移植的 guard 清单。
 * @returns `{ enabled, diagnostics }`；读取失败时 `enabled` 为空数组。
 */
export function readHooksConfig(path, catalog) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return {
      enabled: [],
      diagnostics: [{ level: 'warn', message: `读取 hooks.json 失败（${error.code ?? error.message}）：${path}；按 fail-open 处理，所有 guard 不启用` }],
    }
  }
  const { enabled, diagnostics } = parseHooksConfig(text, catalog)
  return { enabled, diagnostics: diagnostics.map((d) => ({ ...d, message: `[${path}] ${d.message}` })) }
}

/**
 * 判断某条已启用 guard 是否覆盖这次工具调用。
 * @param entry - `parseHooksConfig` 产出的启用项。
 * @param toolName - dsh 的工具名。
 * @returns 是否应用该 guard。
 */
export function guardAppliesTo(entry, toolName) {
  if (entry.matchAll) return true
  const name = String(toolName ?? '')
  return entry.regexes.some((regex) => regex.test(name))
}

/**
 * 把启用清单渲染成一行，用于启动诊断与交付报告。
 * @param enabled - `parseHooksConfig` 产出的启用项。
 * @returns 形如 `npm(matcher=*), gitSafety(matcher=*)` 的字符串。
 */
export function describeEnabled(enabled) {
  if (enabled.length === 0) return '(无)'
  return enabled
    .map((entry) => `${entry.id}(${entry.matchAll ? 'matcher=*' : `matcher=${entry.patterns.join('|')}`})`)
    .join(', ')
}
