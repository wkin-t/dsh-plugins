# 在新环境安装 dsh-tool-guards

把 Claude Code 那套 PreToolUse hooks 安全网装到一台新的 dsh 机器上。
**不依赖 hook 桥接**（`@deepseek-ai/dsh-hooks-claude-code` 在 0.2.1-rc.2 上包体缺失，
加载器直接报 `ERR_MODULE_NOT_FOUND`），改为进程内同步 guard。

> 本文同时覆盖 **Windows** 与 **macOS / Linux**。凡标 🍎 的段落是 macOS/POSIX 专属步骤；
> 标 🪟 的是 Windows 专属。没有标记的通用步骤两边都做。macOS 上 dsh 的 shell 工具名是
> `bash`（Windows 是 `pwsh`），插件同时接受两者，见第 6 节。

---

## 0 · 前置条件

| 项 | 要求 |
|---|---|
| dsh | 桌面版，profile 目录形如 `~/.dsh/profiles/<name>/`（本文按 `desktop` 写） |
| Node | 插件只用 Node 内置模块，**无运行时依赖** |
| `python3` / `python` | 仅当开启 `postSyntaxCheck` 时需要。🍎 macOS/Linux 用 **`python3`**（PEP 394 约定）；🪟 Windows 用 **`python`**。解释器由 `lib/post/syntax.js` 在模块加载时按 `process.platform` 自动选择，不需要手动配。 |

🍎 macOS 实测环境参考：macOS 27 / arm64、Node v26、Homebrew `python3`（`/opt/homebrew/bin/python3`）。
确认解释器可见：

```bash
python3 --version           # macOS/Linux
python --version            # Windows
```

插件本身是一个 bundle-shaped cordis 插件：`index.js` + `lib/` + 自带 `cordis.patch.yml`。

---

## 1 · 把插件目录放到新机器

🍎 **macOS 推荐直接就地安装（不搬家）**：本仓库已经是 pnpm workspace，仓库根
`node_modules/` 里已经装好宿主包（`@deepseek-ai/dsh-home-paths@0.2.1-rc.2`、
`@deepseek-ai/schemastery@3.18.5`），插件里那些 `@deepseek-ai/*` 的 bare import 才能解析。
因此 macOS 上有两种接法，任选其一：

**方式 A（推荐）：`plugin_manager` → `install_bundle`，target 填绝对包目录**

```
/Users/<you>/Projects/dsh-plugin-dev/repo/dsh-tool-guards
```

即把**绝对路径的包目录**作为安装目标交给插件管理器。它会按包名
`dsh-tool-guards` 注册 bundle；宿主依赖由仓库根 workspace / dsh profile 提供
（`package.json` 的 `peerDependencies` 已声明，**没有新增运行时依赖**，不要跑 `pnpm add`）。

**方式 B：软链到 profile 的 `plugins/` 目录，再按第 2 节接线**

```bash
mkdir -p ~/.dsh/profiles/desktop/plugins
ln -sfn /Users/<you>/Projects/dsh-plugin-dev/repo/dsh-tool-guards \
  ~/.dsh/profiles/desktop/plugins/dsh-tool-guards
ls -l ~/.dsh/profiles/desktop/plugins/dsh-tool-guards   # 应显示符号链接
```

> 🍎 路径一律用 POSIX 形式（`/Users/...`），不要用 `C:\...`；`hooks.example.json`
> 和所有运行时代码都不依赖 Windows 绝对路径。

如果你更习惯"拷贝一份"给别的 dsh 机器，把整个 `dsh-tool-guards/` 目录放到：

```
~/.dsh/profiles/<profile>/plugins/dsh-tool-guards/
```

目录里应该能看到 `index.js`、`package.json`、`cordis.patch.yml`、`hooks.example.json`、
`lib/`、`test/`、`oracle/`。

> `oracle/` 是原始 Claude Code 脚本的副本，**只供差分测试当作真值来源**，运行时不加载。
> 但建议一起带上——没有它，`node --test` 里的差分测试跑不起来。
> `hooks.example.json` 是可移植的默认开关表，拷贝到 `$DSH_HOME/tool-guards/hooks.json`
> 即可让五条 guard 全部启用（见第 3 节）。

---

## 2 · 接线（三步，缺一不可）

> 用第 1 节**方式 A（plugin_manager install_bundle）**装好的话，本节的 2.1–2.3 由
> 插件管理器代劳，可以直接跳到第 3 节；仍建议按第 4 节验证一遍。

### 2.1 `package.json` 的 dependencies

在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 里加一行：

```json
"dsh-tool-guards": "link:./plugins/dsh-tool-guards"
```

> ⚠️ **必须 `link:`，不要 `file:`**
>
> `file:` 会被 pnpm **拷贝**成 `node_modules/` 下的实体目录，宿主加载的是那份副本。
> 结果：你改 `plugins/` 里的源码永远不生效，而且失败是**静默的** ——
> 副本里若还是旧的默认配置路径，`apply()` 读不到配置 → 0 个 guard → 提前 return，
> 但条目仍显示 `fiberPhase: active`，看起来一切正常、实际一条都不拦。
> （2026-10-18 在 Windows 机器上实际踩过：`npm --version` 直接执行成功。）
>
> `link:` 建符号链接，改源码即改宿主加载的那份。

### 2.2 `package.json` 的 bundles 列表

同一个 `package.json` 里，`dsh.profile.bundles` 数组追加：

```json
"dsh-tool-guards"
```

### 2.3 安装

🍎 macOS / 🐧 Linux：

```bash
cd ~/.dsh/profiles/desktop
pnpm install
```

🪟 Windows：

```powershell
cd ~/.dsh/profiles/desktop
pnpm install
```

装完确认链接是符号链接：

```bash
# 🍎 macOS / Linux
readlink node_modules/dsh-tool-guards
```

```powershell
# 🪟 Windows
(Get-Item node_modules/dsh-tool-guards -Force).LinkType   # 应为 SymbolicLink
```

---

## 3 · 配置开关表

插件需要一份 `hooks.json` 决定**启用哪些 guard**（判定逻辑在代码里，不在这里）。
默认读：

```
~/.dsh/tool-guards/hooks.json
```

（不存在 → **fail-open：全部不启用** + 一条 warn，绝不会让 dsh 起不来。）

### 最小可用配置（直接复制随包模板）

插件自带一份可移植模板 `hooks.example.json`（五条 guard 全部启用、不写 matcher）。
**不要手抄 JSON**，直接复制，避免手抄漂移：

🍎 macOS / Linux：

```bash
mkdir -p ~/.dsh/tool-guards
cp <插件目录>/hooks.example.json ~/.dsh/tool-guards/hooks.json
```

🪟 Windows（PowerShell）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\tool-guards" | Out-Null
Copy-Item "<插件目录>\hooks.example.json" "$env:USERPROFILE\.dsh\tool-guards\hooks.json"
```

模板内容形如（命令只需**脚本文件名**，路径不参与判断，因此三平台通用）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "node deprecated-guard.mjs", "timeout": 10 },
          { "type": "command", "command": "node git-safety-guard.mjs", "timeout": 10 },
          { "type": "command", "command": "node truncation-guard.mjs", "timeout": 10 },
          { "type": "command", "command": "node python-cmd-guard.mjs", "timeout": 10 },
          { "type": "command", "command": "node npm-guard.mjs", "timeout": 10 }
        ]
      }
    ]
  }
}
```

> 模板里**没有任何 Windows 绝对路径或反斜杠路径**，`test/hooksExample.test.js` 会锁住
> 「合法 JSON + 五条 guard 全启用 + 命令只含 basename」这三个契约。
> 仓库里的 `hooks.example.json` 只是模板；真正生效的是你复制出来的
> `~/.dsh/tool-guards/hooks.json`，不要反过来改模板当配置用。

五个文件名对应五条 guard：

| 脚本文件名 | 作用 |
|---|---|
| `npm-guard.mjs` | 拦 `npm` / `npx`，提示改用 `pnpm` |
| `python-cmd-guard.mjs` | 🪟 Windows 拦裸 `python3`（用 `python`）；🍎 Unix/macOS 拦裸 `python`（用 `python3`） |
| `git-safety-guard.mjs` | 拦 `push --force`、`reset --hard`、`clean -fd`、`branch -D` 等 |
| `truncation-guard.mjs` | 拦写入含"代码被截断"占位符的内容 |
| `deprecated-guard.mjs` | 拦已废弃写法 |

### 匹配规则

- **只读 `hooks.PreToolUse`**；`PostToolUse` 段不参与开关（语法检查器由插件配置项控制）。
- `matcher` 缺省 = 匹配所有工具；否则按 `|` 切成正则分支，**不区分大小写、部分匹配**。
- 顺序即执行顺序，**第一条返回理由的终止**（与 CC 串行执行、第一个 block 生效一致）。

### 换配置路径

若想放到别处，在 profile 的 `cordis.patch.yml` 里覆盖（顶层覆盖，**不要**写成 `- insert:`）：

```yaml
- id: tool-guards
  config:
    hooksPath: "~/my-hooks.json"
```

---

## 4 · 重启并验证

**新增 bundle 条目必须重启 dsh**（改 `package.json` 的 `dsh.profile.bundles` 不会热生效）。
重启后在 GUI 的"已安装插件"里应能看到 `dsh-tool-guards`。
🍎 macOS 桌面版：退出 DSH Desktop 后重新打开（或按 dsh 的重载插件操作）；仅刷新页面
**不会**重新导入 ESM 模块。

后续改插件**配置**时，`plugin_manager` 的 `set_bundle` 通常会触发重组让新配置生效；
改**源码**则一定需要重启（ESM 模块缓存，见第 6 节第 3 条）。
不确定时一律以重启为准。整条不稳定路径的代价是"看起来改了、其实没生效"，
比多等一次重启贵得多。

### 验证清单

| # | 操作 | 期望 |
|---|---|---|
| 1 | `npm --version` | 被拒，返回 `🚫 [npm Guard] 已拦下 npm 命令，请改用 pnpm` |
| 2 | 🪟 `python3 --version`（Windows） | 被拒，返回 `🚫 [Python Cmd Guard] …` |
| 2' | 🍎 `python --version`（macOS/Linux） | 被拒，返回 `🚫 [Python Cmd Guard] …`；同一台机器上 `python3 --version` **正常执行** |
| 3 | 写一个含截断占位符的文件 | 被拒，返回 `🚫 [Truncation Guard] …` |
| 4 | `pnpm --version`、`git status` | **正常执行**（不误伤） |
| 5 | `cd <仓库根> && node --test dsh-tool-guards/test` | 全绿（当前 513 项，含差分测试与平台矩阵） |

第 1 条通过就基本说明装好了；第 5 条说明 oracle 也到位了。
🍎 macOS 上 dsh 的 shell 工具名是 `bash`（不是 `pwsh`）；第 1、2'、4 条都应通过
`bash` 工具执行，确认 guard 对 `bash` 同样生效。

---

## 5 · 可选特性

| 配置项 | 默认 | 说明 |
|---|---|---|
| `sshRemoteWriteWarning` | `true` | SSH 远程写代码的**软提醒**（只写日志，不拦截）。原 CC 机制写 stderr、用户当场可见；dsh 无"告警但不拦"通道，可见性弱于原机制。 |
| `postSyntaxCheck` | `false` | 写 `.py`/`.ts` 后跑语法检查，语法错就把这次调用转成失败并让模型立刻修。**开启后每次写文件要起一个子进程**，破坏本插件其余部分的零子进程性质，故默认关。 |
| `postSyntaxTimeoutMs` | `20000` | 语法检查超时，对齐原 `hooks.json` 的 20s。 |
| `diagnostics` | `true` | 输出启用清单等 `info` 日志（`warn` 永远输出）。 |

在 profile 的 `cordis.patch.yml` 里开启（顶层覆盖）：

```yaml
- id: tool-guards
  config:
    postSyntaxCheck: true
```

> 开 `postSyntaxCheck` 的前提：平台对应的解释器在 PATH 上——🍎 macOS/Linux 是
> `python3`，🪟 Windows 是 `python`（由 `lib/post/syntax.js` 的 `pythonRunnerFor()`
> 在模块加载时按 `process.platform` 选定，解析不到会 fail-open 放行）。
> 🍎 Homebrew 的 `python3` 通常在 `/opt/homebrew/bin/python3`；如果 DSH 从 Finder/GUI
> 启动导致 PATH 不含 Homebrew，写后检查会静默跳过——先在 dsh 的 shell 里跑
> `which python3` 确认。
> TypeScript 那半跑在 `node` 上，并要求**被写文件所在的工程自己装了 `typescript`**——
> 检查器是从被检查文件目录往上找 `node_modules/typescript`，找不到就静默跳过，这是原设计。

---

## 6 · 踩过的坑（照做就不会重复踩）

1. **`file:` 会拷贝成实体副本** → 宿主跑旧代码、静默 fail-open。用 `link:`。
2. **`post-execute` 的 block 决策 `feedback` 必须是内容块数组**（`[{type:'text',text}]`），
   传字符串会让 harness 抛 `content.map is not a function`，整次工具调用失败。
   本项目已用 `buildBlockDecision()` 统一产出，`test/postDecision.test.js` 锁死形状——
   如果你要改这块，别绕过它。
3. **改源码不会热重载**（ESM 模块缓存）：`set_bundle` 只重组，不重新导入模块。
   改代码后要**重启 dsh**。换一次依赖形态（`file:` ↔ `link:`）会改变解析路径从而触发重载。
4. **配置读不到就是静默不拦**：`hooks.json` 缺失/损坏/无 `PreToolUse` 段都走 fail-open。
   装完务必跑第 4 节的验证清单，不要只看"插件显示已启用"。
5. **`hooks.json` 必须是 JSON**（不是 YAML，不是带注释的 JSON5）。
6. 🍎 **macOS 的 shell 工具名是 `bash`**：插件在 `lib/shared.js` 的工具名白名单里同时
   接受 `pwsh` 与 `bash`，判定逻辑不依赖 PowerShell 语法。但如果你在 `hooks.json` 里
   写了 `"matcher": "pwsh"`，macOS 上的 `bash` 调用**一条都不会命中**——模板因此不写
   matcher（= 匹配所有工具，各 guard 自己再按 shell/写入工具筛）。
7. 🍎 **Python 解释器别写死**：macOS 上裸 `python` 常常不存在（Homebrew 只提供
   `python3`）。写后检查器由 `pythonRunnerFor(process.platform)` 选 `python3`；
   同时 python guard 会拦裸 `python`、放行 `python3`，这是 macOS 上的预期行为，
   不是误伤。
8. 🍎 **路径一律 POSIX**：插件运行时用 `node:path` 拼路径（默认配置
   `$DSH_HOME/tool-guards/hooks.json` 与检查器脚本路径），不依赖 `C:\` 或反斜杠。
   自定义 `hooksPath` 时写 `~/...` 或 `/Users/...`。

---

## 7 · 卸载

1. `package.json` 的 `dependencies` 删 `dsh-tool-guards` 行；
2. `dsh.profile.bundles` 删 `"dsh-tool-guards"`；
3. `pnpm install`；
4. 删 `plugins/dsh-tool-guards/` 目录；
5. 可选：删 `~/.dsh/tool-guards/hooks.json`。

---

## 8 · 目录结构

```
dsh-tool-guards/
├── index.js              插件入口：读配置 → 注册 ctx.tools.guard（同步）
├── package.json          含 dsh.bundle.patch 声明 + 宿主包的 peerDependencies
├── cordis.patch.yml      bundle 注册：- insert: [{ id: tool-guards, name: dsh-tool-guards }]
├── hooks.example.json    可移植默认开关表：五条 guard 全启用，复制到 ~/.dsh/tool-guards/hooks.json
├── lib/
│   ├── shared.js         工具名/参数的归一化（认 write/edit 与 pwsh/bash 等）
│   ├── hooks-config.js   解析 hooks.json → 启用清单
│   ├── guards/           五条同步 guard（判定 + 中文文案，逐字照搬原脚本）
│   └── post/syntax.js    写后语法检查（python3/python 按平台选；仅 postSyntaxCheck 开启时加载）
├── oracle/               原始 CC 脚本副本，**只给测试当真值**，运行时不加载
├── test/                 单元 + 差分测试（node --test，无第三方依赖）
└── README.md             设计说明、已知偏差、排查指引
```
