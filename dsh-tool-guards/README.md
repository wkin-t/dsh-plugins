# dsh-tool-guards

把 Claude Code 时代的 hook guard 搬成 **dsh 进程内同步 guard**，绕开已经失效的 hook 桥接。

## 为什么不用 hook 桥接了

这台机器上 `@deepseek-ai/dsh-hooks-claude-code` 的包体缺失（`fiberPhase: null`），
`~/.dsh/claude-hooks/hooks.json` 里那 7 个 hook **全部不生效**——桥接根本没跑起来。

dsh 提供了原生替代：

```js
ctx.tools.guard((exec) => string | undefined)   // 同步；返回字符串 = 拒绝，undefined = 放行
```

语义是**单调 deny**：任一 guard 返回理由即拒绝，没有 guard 能强制放行。
`exec.name` 是工具名，`exec.arguments` 是已解析（且深冻结）的参数对象。
不依赖任何外部进程、不读 stdin、不写 stdout，因此不受桥接状态影响。

## 目录

```
index.js               插件入口：读配置 → 注册一条组合 guard
lib/shared.js          dsh (toolName, args) → CC (tool_name, tool_input) 的归一（移植自 hook-input.mjs）
lib/hooks-config.js    hooks.json → 「启用哪些 guard + 各自 matcher」
lib/guards/npm.js         拦 npm/npx（含查询类命令）
lib/guards/pythonCmd.js   win32 拦裸 python3；其他平台拦裸 python
lib/guards/gitSafety.js   拦危险 git 操作与系统破坏性命令
lib/guards/deprecated.js  拦对 _deprecated/ deprecated/ legacy/ 的写入
lib/guards/truncation.js  拦 `// ... rest of code` 式截断写入
test/                  node --test（单元 + 差分）
```

每个 guard 模块导出 `id`、`script`（对应的 CC 脚本文件名）与
`check(toolName, args) -> string | undefined`。`check` 是**纯同步、无 I/O、无子进程**的。

## 挂载

本目录只是插件本体。要真正生效还需两步（都在 profile 级，属于挂载方的操作）：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加
   `"dsh-tool-guards": "link:./plugins/dsh-tool-guards"`，`dsh.profile.bundles` 加 `"dsh-tool-guards"`。

   ⚠️ **必须用 `link:` 而不是 `file:`**。`file:` 会被 pnpm 拷成 `node_modules/` 下的**实体副本**，
   宿主加载的是那份拷贝；于是你改 `plugins/` 里的源码永远不会生效，
   最要命的是失败方式是**静默的**：副本里还是旧的默认 `hooksPath`，指向一个已不存在的路径，
   `apply()` 读不到配置 → 0 个 guard → 提前 return → 条目仍显示 `fiberPhase: active`，
   但**一条都不拦**。（2026-10-18 实际踩过：`npm --version` 直接执行成功。）
   `link:` 建的是符号链接，改源码即改宿主加载的那份。
   改完依赖后还要重载插件：`file:`→`link:` 会改变解析路径，条目会重新建 fiber；
   仅改源码内容则**不会**自动重载（ESM 模块缓存），需重启 dsh 或换一次依赖形态。
2. 本插件自带的 `cordis.patch.yml` 由 bundle 机制读取，内容即：

```yaml
- insert:
    - id: tool-guards
      name: dsh-tool-guards
```

`name` 用裸包名而不是 `./index.js`，与同目录 `dsh-claude-memory` 的做法一致。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `hooksPath` | `$DSH_HOME/tool-guards/hooks.json` | 启用开关表；支持 `~` 前缀 |
| `diagnostics` | `true` | 输出启用清单等 `info` 日志（`warn` 永远输出） |
| `sshRemoteWriteWarning` | `true` | SSH 远程写代码的**软提醒**（只写日志，不拦截） |
| `postSyntaxCheck` | `false` | 写 `.py`/`.ts` 后跑语法检查（要起子进程，默认关） |
| `postSyntaxTimeoutMs` | `20000` | 语法检查超时，对齐原 `hooks.json` 的 20s |

## 启用规则（`hooks.json` 只当开关）

- 只读 `hooks.PreToolUse` 决定启用哪些 guard。`PostToolUse` 段不再当开关用——
  两个语法检查器改由 `postSyntaxCheck` 配置项控制（因为它们的执行时机是
  `tools/post-execute`，与 `hooks.json` 的 PreToolUse 开关不是一回事）。
- 一条 guard 只有「出现在 `PreToolUse` 里」且「其 `command` 指向对应的 `.mjs`」才算启用。
  认的是脚本 basename（`npm-guard.mjs` 等），不看路径，因此换机器、换目录都不用改代码。
- `matcher` 缺省 = 匹配所有工具；否则按 `|` 分隔成若干**正则**分支，任一命中即应用，
  比较**不区分大小写**，且与 CC 一样是**部分匹配**（`edit` 也会命中 `multi_edit`）。
- 文件缺失 / 读取失败 / JSON 解析失败 / 没有 `PreToolUse` 段 → **fail-open（全部不启用）**
  ＋一条 `warn` 诊断，`diagnostics: false` 也压不掉。插件是加载期同步执行的，
  这里抛错会让 dsh 起不来，代价远大于「少拦几次工具调用」。
- 判定逻辑（正则、白名单、文案）**全在插件代码里**，`hooks.json` 改不动它们。
  这样可以避免「CC 侧改了一个正则、dsh 侧还是旧的」这种静默分叉。

当前这份 `hooks.json` 解析出的启用清单：

```
deprecated(matcher=*), gitSafety(matcher=*), truncation(matcher=*), pythonCmd(matcher=*), npm(matcher=*)
```

（单组、无 `matcher`，因此五条全部覆盖所有工具；各 guard 自己在 `check()` 里按
「是否 shell 调用 / 是否写文件工具」再筛一遍。）

## 拦截顺序

按 `hooks.json` 里出现的顺序依次询问，**第一条返回理由的即终止**——
与 CC 串行执行全部 hook、第一个 block 生效的语义一致。

## 测试

```powershell
node --test "$env:USERPROFILE\.dsh\profiles\desktop\plugins\dsh-tool-guards\test"
```

- `test/*.test.js`：各 guard 的正例/反例，覆盖脚本里每一条规则分支。
- `test/differential.test.js`：**核心**。对每条 fixture（67 条）× 每条 guard（5 条）
  都用 `spawnSync(process.execPath, [原脚本], { input: CC 形状 JSON })` 把**原始 `.mjs` 跑起来**，
  从 stdout 取 `{"decision":"block","reason":...}`，与插件 `check()` 的返回值要求
  **完全相等**（含中文标点与空格）。原脚本退出码非 0 直接判失败，避免把「oracle 崩了」
  误当成「放行」。

## 实现说明

**为什么不用 `ctx.fs`**：guard 不能做异步 I/O，也不需要——它只处理字符串。
唯一读文件的地方是加载期的 `hooks.json`（`readFileSync`），必须同步完成，
否则注册完成前到达的工具调用会漏检。

**guard 抛异常怎么办**：降级为「这条规则这次不生效」并记一次 `warn`。
`guardReason()` 是同步遍历，异常会打断整次工具调用（表现为一个与 guard 无关的报错），
等于「一个 guard 有 bug → 所有工具都不能用」；这个代价比漏拦一次高。

**注册的生命周期**：`ctx.effect(() => ctx.tools.guard(evaluate), 'tool-guards')`。
`tools.guard()` 自己返回的 disposer 已绑当前 ctx，外面再包一层 `ctx.effect`
是为了让「注册」显式出现在 effect 树里——HMR / unload 时能确定被回收，
不会残留一条指向上一个模块实例的 guard。

## 已知偏差（没能照搬的部分）

1. **SSH 远程写代码提醒的可见性变弱**（2026-10-18 已移植，但不是原样）。
   原脚本往 stderr 写一条非阻塞告警，**用户当场能看到**；
   dsh 的 guard 只有「拒绝 / 放行」两态，没有"告警但不拦"的通道，
   所以改走 `ctx.logger.warn`（`sshRemoteWriteWarning`，默认开）。
   命中范围与原正则**逐字对拍过**（`test/sshWarning.test.js`，10 条 fixture），
   且显式断言"提醒绝不变成拒绝理由"——否则远程运维命令会被一起挡掉。
2. **PostToolUse 语法检查器**（2026-10-18 已移植，默认关）。
   走 `tools/post-execute`，`block` 决策把调用转成失败并把中文理由交给模型，
   对应 CC 的 `exit 2 + stderr`。四个边界：
   - 每次写 `.py`/`.ts` 要起一个子进程，**破坏了本插件其余部分的"零子进程"性质**，
     因此默认关，需要显式开 `postSyntaxCheck`。
   - ⚠️ **`feedback` 必须是内容块数组，不能是字符串**。harness 的 `postExecute`
     拿到 block 决策后把 `decision.feedback` 直接当 content 用，并用
     `failureMessageFromContent(decision.feedback)` 推错误消息，而后者内部是
     `content.map(...)`——传字符串会抛 `content.map is not a function`，
     **整次工具调用失败**（2026-10-19 端到端验证时真实踩到）。
     形状由 `buildBlockDecision()` 统一产出，`test/postDecision.test.js` 锁死。
   - `check-ts-syntax.mjs` 会从**被检查文件的目录往上找** `node_modules/typescript`，
     找不到就静默跳过（原脚本 L98）。所以它只在「工程自己装了 typescript」时才生效；
     写临时目录里的 `.ts` 不会被检查。这是原设计，未改动。
   - 检查器自身崩了 / 超时 → 一律**放行 + 一条 warn**，绝不连累工具调用。
3. **`hooks.json` 里的 `timeout`**：PreToolUse 的同步 guard 没有超时概念，字段被忽略；
   `postSyntaxCheck` 的超时改由 `postSyntaxTimeoutMs` 控制。
4. **平台分支**（2026-10-18 已补 oracle）。原脚本读 `process.platform`，Windows 开发机
   只能跑到 win32 分支。现在用 `node --import` 预载改写 `process.platform`
   让原脚本**真的**求值 linux/darwin 分支，再与 `checkForPlatform()` 对拍
   （`test/platform.test.js`，12 fixture × 2 平台 + 1 条"预载确实切换了分支"的自检，
   防止预载失效导致两边都跑 win32 而假绿）。
5. **`npm-guard.mjs` 的 Codex/PermissionRequest 分支**：原脚本对
   `shell_command` / `exec_command` 这类工具名会多写一份 `hookSpecificOutput`。
   那是桥接协议细节，与拦截判定无关；新插件只保留判定与 `reason` 文案，
   差分测试里 `exec_command` fixture 证明两边 `reason` 仍逐字相等。
