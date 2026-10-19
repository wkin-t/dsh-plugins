/**
 * 写文件后的语法自检（对应原 PostToolUse 的两个检查器）。
 *
 * 为什么单独放一个模块而不是继续塞进 guard：guard 是**同步、调用前**执行的纯函数，
 * 而语法检查必须等文件真的落盘之后、并且要跑解释器，天然是异步 + 事后（post-execute）。
 * 两者混在一起会破坏 guard 的"零子进程"性质，也会让 `evaluate` 变成 async 而失效。
 *
 * 回传通道：`tools/post-execute` 的 `block` 决策会把这次调用转成 `isError` 并把
 * `feedback` 交给模型——这与 Claude Code 里 PostToolUse `exit 2` + stderr 的语义一致
 * （原文见 `oracle/hooks/check-python-syntax.py` 头部注释）。
 *
 * @module dsh-tool-guards/post/syntax
 */
import { spawn } from 'node:child_process'
import { extname, join } from 'node:path'
import { isWriteTool } from '../shared.js'

/**
 * 按平台选 Python 解释器。
 *
 * - win32：`python`（python.org 安装器只把启动器注册成 `python`；`python3` 常缺失，
 *   或指向 Microsoft Store 的占位程序）；
 * - darwin / linux（以及其他类 Unix 平台）：`python3`（PEP 394 约定；裸 `python`
 *   在 macOS 上可能不存在，在部分发行版上仍可能指向 Python 2）。
 *
 * 单独导出成函数是为了让测试能显式验三条分支：本机只可能落到其中一条，
 * 不给入口的话另外两条永远只有"读代码觉得对"这种伪验证。
 *
 * @param platform - `process.platform` 的取值。
 * @returns 解释器命令名。
 */
export function pythonRunnerFor(platform) {
  return platform === 'win32' ? 'python' : 'python3'
}

/** 模块加载时按本机平台定下的 Python 解释器（不要在每次检查时重算/读环境）。 */
const PYTHON_RUNNER = pythonRunnerFor(process.platform)

/** 检查器脚本相对插件根的位置（vendor 自原 hooks 目录），运行时用 node:path 拼接。 */
export const CHECKERS = {
  python: { script: 'oracle/hooks/check-python-syntax.py', runner: PYTHON_RUNNER, exts: ['.py'] },
  typescript: { script: 'oracle/hooks/check-ts-syntax.mjs', runner: 'node', exts: ['.ts', '.tsx', '.mts', '.cts'] },
}

/**
 * 注意 TypeScript 那半的固有边界（**不是**本插件的缺陷）：
 * `check-ts-syntax.mjs` 会从被检查文件的目录逐级往上找 `node_modules/typescript`，
 * 找不到就静默跳过（原脚本 L98 `if (!tsDir) return;`）。
 * 因此它只在「被写文件所在的工程自己装了 typescript」时才会真的检查；
 * 写一个临时目录里的 `.ts` 是不会被检查的。这是原设计，照搬即可，不要用
 * `NODE_PATH` 之类的手段硬塞搜索路径——那会改变它的判定边界。
 */

/**
 * 按扩展名选检查器。
 *
 * 为什么只看扩展名不看工具名：`write` 和 `edit` 都可能写任何语言，
 * 而原 hooks.json 用 `matcher: "edit|write"` 把两个检查器都挂上，
 * 真正决定跑哪个的是检查器自己按扩展名过滤——这里保持一致。
 *
 * @param filePath - 被写入的文件路径。
 * @returns 命中的检查器种类；不适用时返回 undefined。
 */
export function checkerFor(filePath) {
  const ext = extname(String(filePath ?? '')).toLowerCase()
  if (CHECKERS.python.exts.includes(ext)) return 'python'
  if (CHECKERS.typescript.exts.includes(ext)) return 'typescript'
  return undefined
}

/**
 * 跑一个检查器，返回它对这次写入的语法错误反馈。
 *
 * @param options - 运行参数。
 * @param options.kind - 检查器种类。
 * @param options.pluginRoot - 插件根目录（用于定位脚本）。
 * @param options.exec - dsh 的工具执行信息。
 * @param options.timeoutMs - 超时毫秒数（对齐 hooks.json 的 20s）。
 * @returns 反馈文案；无问题或检查器不可用时返回 undefined。
 */
export function runChecker({ kind, pluginRoot, exec, timeoutMs }) {
  const spec = CHECKERS[kind]
  const args = exec?.arguments ?? {}
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: exec?.name,
    tool_input: args,
  })

  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child
    try {
      // 用 node:path 的 join 拼脚本路径，而不是字符串相加：按当前平台给出正确分隔符，
      // pluginRoot 末尾是否带分隔符都不会拼出 `//` 或混合分隔符。
      child = spawn(spec.runner, [join(pluginRoot, spec.script)], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch {
      // 找不到解释器（例如没装 python/python3）视为"检查器不可用"，放行。
      settle(undefined)
      return
    }

    let stdout = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })

    // 超时必须真的把子进程杀掉：post-execute 是工具调用链路上的一环，
    // 一个卡住的检查器会把整次工具调用一起挂住。
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      settle(undefined)
    }, timeoutMs)
    timer.unref?.()

    child.on('error', () => {
      clearTimeout(timer)
      settle(undefined)
    })
    child.on('close', () => {
      clearTimeout(timer)
      // 原检查器用 exit 2 表达"有语法错误"，同时把结构化结果写进 stdout；
      // 这里只认 stdout 里的 block 决策——退出码在各宿主上语义不一，不可靠。
      const line = stdout
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith('{'))
        .at(-1)
      if (!line) {
        settle(undefined)
        return
      }
      try {
        const parsed = JSON.parse(line)
        settle(parsed?.decision === 'block' && typeof parsed.reason === 'string' ? parsed.reason : undefined)
      } catch {
        settle(undefined)
      }
    })

    child.stdin?.on('error', () => {})
    child.stdin?.end(payload)
  })
}

/**
 * 判断一次调用是否值得做写后检查。
 *
 * @param exec - dsh 的工具执行信息。
 * @returns 需要检查时返回 `{ kind, filePath }`；否则 undefined。
 */
export function planCheck(exec) {
  if (!isWriteTool(exec?.name)) return undefined
  const filePath = exec?.arguments?.file_path
  const kind = checkerFor(filePath)
  if (!kind) return undefined
  return { kind, filePath }
}

/**
 * 把语法错误拼成 `tools/post-execute` 的 block 决策。
 *
 * 为什么 `feedback` 是数组而不是字符串：harness 的 `postExecute` 拿到 block 决策后
 * 做 `content: decision.feedback`，并用 `failureMessageFromContent(decision.feedback)`
 * 推错误消息，而它内部是 `content.map(...)`——传字符串会抛
 * `content.map is not a function`，把整次工具调用搞崩（2026-10-19 实测踩到）。
 *
 * 为什么要显式带上 `additionalContexts`：harness 在 block 分支只转发
 * **block 决策自己带的** context，被 block 的工具原本 deferred 的上下文会被丢弃。
 * 把 `result.additionalContexts` 合并回来，避免一次语法检查连带丢掉别的插件注入的内容。
 *
 * @param decision - 下游决策（可能是 accept，也可能已是别的插件的 block）。
 * @param reason - 检查器给出的中文反馈。
 * @param result - 本次工具执行结果（用于取回 additionalContexts）。
 * @returns 合并后的 block 决策。
 */
export function buildBlockDecision(decision, reason, result) {
  const feedback = [{ type: 'text', text: reason }]
  const additionalContexts = [...(result?.additionalContexts ?? []), ...(decision?.additionalContexts ?? [])]
  const withContexts = additionalContexts.length > 0 ? { additionalContexts } : {}

  // 下游已经是 block：**追加**理由，不要覆盖它原本的反馈。
  if (decision?.kind === 'block') {
    return {
      ...decision,
      feedback: [...(Array.isArray(decision.feedback) ? decision.feedback : []), ...feedback],
      ...withContexts,
    }
  }

  return { kind: 'block', feedback, ...withContexts }
}
