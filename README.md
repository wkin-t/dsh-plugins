# dsh-plugins

两个自用的 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）原生 cordis 插件，
共同目标是把 **Claude Code 的既有能力搬到 dsh 上**，并且**不改变磁盘上的数据格式**——
这样随时能迁回 Claude Code，不需要任何转换。

| 插件 | 作用 | 状态 |
|---|---|---|
| [`dsh-claude-memory`](dsh-claude-memory/README.md) | 读取 Claude Code 的 auto memory（`MEMORY.md`）并注入模型上下文，注入格式与 CC **字节级对齐** | 可用（Windows / macOS） |
| [`dsh-tool-guards`](dsh-tool-guards/README.md) | 把 CC 的 PreToolUse hooks 安全网重建为 dsh 进程内同步 guard（`ctx.tools.guard`），**零子进程** | 可用（Windows / macOS） |

两者都只读 Claude Code 的数据、只写 dsh 自己的目录，不会回写 CC 的任何路径。

---

## macOS 适配（本仓库当前状态）

插件最初在 Windows 11 + PowerShell 7 上开发。本次在 macOS 27（arm64）+
dsh desktop `0.2.1-rc.2` 上完成安装与适配，改动如下：

| 项 | 改动 |
|---|---|
| 仓库根 | 改成 **pnpm workspace**：根 `package.json` + `pnpm-workspace.yaml` 把宿主包 `@deepseek-ai/dsh-home-paths`、`dsh-llm`、`schemastery` 装到仓库根 `node_modules`。`plugin_manager` 用 `link:` 安装时，被链入的插件按自己的真实路径解析 import，必须靠这份 workspace 依赖才能找到宿主包。 |
| `dsh-claude-memory` | ① `memoryRoot` 支持解析顺序：显式配置 → `$DSH_HOME/projects` → `~/.claude/projects`（macOS 上 CC 的真实 store）→ 兜底 `$DSH_HOME/projects`；② 使用 dsh `0.2.1-rc.2` 的 `workingDirectory` 服务取**有效工作目录**（`working_directory` 切换 / 子代理 cwd 与 session header 不一致时仍能命中正确项目），缺失时回退 `session.header.cwd` → `process.cwd()`；③ 定位测试夹具平台化（Windows / POSIX 各自用本平台绝对路径，不再把 `C:\...` 交给 POSIX 的 `resolve`/`join`）。 |
| `dsh-tool-guards` | ① POST 写后 Python 语法检查按平台选解释器：macOS/Linux 用 `python3`，Windows 用 `python`；② 检查器脚本路径改用 `node:path` 拼接；③ 新增可移植的 `hooks.example.json`（无 Windows 绝对路径，三平台通用）；④ 伪造平台差分矩阵扩展到 `linux + darwin + win32`，macOS 上也能对拍 Windows 分支。 |
| 文档 | 两个插件的 README / INSTALL 增加 macOS 安装、配置、验证与排查步骤（中文，命令用 bash / POSIX 路径）。 |

Windows 行为保持兼容：插件运行时代码没有平台专属分支被删除；
`dsh-tool-guards` 的平台测试会同时驱动 `linux` / `darwin` / `win32` 三条分支。

---

## 为什么不用现成的社区方案

- `dsh-plugin-claude-bridge` / `dsh-auto-memory` 走的是各自的私有格式，
  一旦采用就**无法无损迁回** Claude Code；
- dsh 官方的 `@deepseek-ai/dsh-hooks-claude-code` 在 `0.2.1-rc.2` 上**包体缺失**——
  加载器报 `ERR_MODULE_NOT_FOUND`，条目 `enabled: true` 但 `fiberPhase: null`，
  配置里的 hook 全部静默失效。本仓库的 `dsh-tool-guards` 正是它的替代品。

---

## 安装（dsh desktop 0.2.1-rc.2）

每个插件目录都是自包含的 bundle-shaped cordis 插件（`index.js` + `lib/` +
自带 `cordis.patch.yml`）。安装走 dsh 的 `plugin_manager`，不要手改 profile。

### 0 · 准备 workspace 依赖

被 `link:` 安装的插件不会由 profile 安装它自己的依赖，因此**先在仓库根装一次**：

```bash
cd <repo>/dsh-plugins
pnpm install
```

这一步把宿主包装到 `repo/node_modules`，插件的裸导入
（`@deepseek-ai/dsh-llm` / `dsh-home-paths` / `schemastery`）才能解析。
`package.json` 里的 `peerDependencies` 只是把宿主契约写清楚，不会新增运行时依赖。

### 1 · 安装两个 bundle

在 dsh agent 会话里调用（`target` 是**绝对包目录**，不是 `.tgz`）：

```text
plugin_manager(action: "install_bundle",
               target: "<repo>/dsh-plugins/dsh-claude-memory")
plugin_manager(action: "install_bundle",
               target: "<repo>/dsh-plugins/dsh-tool-guards")
```

返回 `application: "applied"` 表示已生效；两个插件会出现在当前 profile 的
「已安装插件 / Bundles」里。安装结果会写入 profile 的 `package.json`
（`link:` 依赖 + `dsh.profile.bundles`），由插件管理器维护，不要手写。

### 2 · 配置 tool-guards 的开关表

`dsh-tool-guards` 需要一份 `hooks.json` 决定启用哪些 guard（判定逻辑在代码里）。
仓库自带三平台通用的模板：

```bash
mkdir -p ~/.dsh/tool-guards
cp dsh-tool-guards/hooks.example.json ~/.dsh/tool-guards/hooks.json
```

Windows（PowerShell）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\tool-guards" | Out-Null
Copy-Item dsh-tool-guards\hooks.example.json "$env:USERPROFILE\.dsh\tool-guards\hooks.json"
```

文件缺失 / 坏 JSON / 无 `PreToolUse` 段时插件 **fail-open**（一条 guard 都不启用，
只留 warn），不会让 dsh 起不来；但这等于安全网没打开，装完请按「验证」跑一遍。

### 3 · claude-memory 的 memoryRoot

macOS 上通常**不需要配置**：`$DSH_HOME/projects` 不存在时自动复用
`~/.claude/projects`（Claude Code 的真实 auto-memory store，只读）。
解析顺序与显式覆盖方式见 [`dsh-claude-memory/README.md`](dsh-claude-memory/README.md)。

### 4 · 生效与重启

- 新增 bundle 时 `plugin_manager` 一般会立即重组并生效（本次实测 `applied` 后
  guard 立即拦截）；
- **改插件源码后不会热重载**（ESM 模块缓存）：需要重启 dsh desktop，
  或先 `remove_bundle` 再 `install_bundle` 触发一次全新导入；
- 改 `~/.dsh/tool-guards/hooks.json` 后同样需要重启（配置在 `apply()` 时同步读取）。

### 5 · 验证

在 dsh 的 bash 工具里逐条确认（macOS）：

| # | 操作 | 期望 |
|---|---|---|
| 1 | `npm --version` | 被拒：`🚫 [npm Guard] 已拦下 npm 命令，请改用 pnpm` |
| 2 | `python --version` | 被拒：`🚫 [Python Cmd Guard] 已拦下 macOS/Linux 上的裸 python 命令` |
| 3 | `git branch -D foo` | 被拒：`🚫 [Git Safety Guard] … git branch -D` |
| 4 | `pnpm --version`、`git status` | 正常执行（不误伤） |
| 5 | 打开/新建一个在 `~/.claude/projects/<slug>/memory/MEMORY.md` 有记忆的项目会话 | 模型上下文里出现 `<system-reminder>` + `Contents of … (user's auto-memory, persists across conversations)` |

`dsh-claude-memory` 每个会话会写一条诊断：
`claude-memory: no MEMORY.md at … (memoryRoot=…, rootSource=…, slug=…)`，
`rootSource=claude-projects` 表示正在只读复用 CC store。

---

## 仓库结构

```
dsh-plugins/
├── package.json            pnpm workspace 根：宿主包依赖 + 测试脚本
├── pnpm-workspace.yaml     workspace 成员：两个插件目录
├── pnpm-lock.yaml          锁文件（保证宿主包版本可复现）
├── dsh-tool-guards/        危险命令拦截（npm / python / git / 截断占位符 / 废弃写法）
│   ├── lib/guards/         五条同步 guard，判定逻辑与中文文案逐字照搬 CC 脚本
│   ├── lib/post/           可选的写后语法检查（默认关，按平台选 python3 / python）
│   ├── oracle/             原始 CC 脚本副本，**仅作差分测试真值**，运行时不加载
│   ├── hooks.example.json  可移植的 guard 开关表模板
│   ├── test/               单元 + 差分测试（node --test，无第三方依赖）
│   ├── INSTALL.md          新环境安装指南（Windows / macOS）
│   └── README.md           设计说明、已知偏差、排查指引
└── dsh-claude-memory/      读取 CC 的 MEMORY.md 并注入上下文
    ├── lib/                locate（定位）/ render（渲染）/ inject（注入）/ roots（记忆根解析）/ working-dir（有效 cwd）
    ├── test/               单元测试 + 与 CC 真实字节输出的对拍
    └── README.md           算法证据、已知偏差、macOS 安装
```

---

## 测试

两个插件都用 Node 内置测试运行器，不需要额外测试依赖。**在仓库根执行**
（workspace 依赖在根 `node_modules`）：

```bash
pnpm test                                  # 两个插件一起跑
node --test dsh-tool-guards/test           # 只跑 guards
node --test dsh-claude-memory/test         # 只跑 claude-memory
```

`dsh-tool-guards` 的差分测试会把 `oracle/` 里的**原始 Claude Code 脚本真的跑起来**，
与插件实现逐字比对返回值（含中文标点与空格）。所以 `oracle/` 不是装饰，
**删了差分测试就没有真值来源了**。

---

## 兼容性

| 平台 | 状态 |
|---|---|
| Windows 11 + PowerShell 7 | 原开发环境；插件按 `pwsh` / `python` 分支保留，平台差分测试覆盖 `win32` |
| macOS 27（arm64）+ 默认 `bash` 工具 | **本次实测**：dsh desktop `0.2.1-rc.2` / Node v26 / Homebrew `python3`；两个插件安装并生效，测试全绿 |
| Linux | 代码路径与 macOS 相同（POSIX / `bash` / `python3`），未做整机实测 |

插件依赖的宿主包版本固定为 `0.2.1-rc.2`；升级 dsh 时如果宿主 API 变化
（例如 `workingDirectory` 服务），需要同步适配并重跑测试。
