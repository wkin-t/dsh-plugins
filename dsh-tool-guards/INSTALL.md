# 在新环境安装 dsh-tool-guards

把 Claude Code 那套 PreToolUse hooks 安全网装到一台新的 dsh 机器上。
**不依赖 hook 桥接**（`@deepseek-ai/dsh-hooks-claude-code` 在 0.2.1-rc.2 上包体缺失，
加载器直接报 `ERR_MODULE_NOT_FOUND`），改为进程内同步 guard。

---

## 0 · 前置条件

| 项 | 要求 |
|---|---|
| dsh | 桌面版，profile 目录形如 `~/.dsh/profiles/<name>/`（本文按 `desktop` 写） |
| Node | 插件只用 Node 内置模块，**无运行时依赖** |
| `python` | 仅当开启 `postSyntaxCheck` 时需要（Python 语法检查器用它） |

插件本身是一个 bundle-shaped cordis 插件：`index.js` + `lib/` + 自带 `cordis.patch.yml`。

---

## 1 · 把插件目录放到新机器

把整个 `dsh-tool-guards/` 目录放到：

```
~/.dsh/profiles/<profile>/plugins/dsh-tool-guards/
```

目录里应该能看到 `index.js`、`package.json`、`cordis.patch.yml`、`lib/`、`test/`、`oracle/`。

> `oracle/` 是原始 Claude Code 脚本的副本，**只供差分测试当作真值来源**，运行时不加载。
> 但建议一起带上——没有它，`node --test` 里的差分测试跑不起来。

---

## 2 · 接线（三步，缺一不可）

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

```powershell
cd ~/.dsh/profiles/desktop
pnpm install
```

装完确认链接是符号链接：

```powershell
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

### 最小可用配置

只需 **脚本文件名**，路径完全不参与判断：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "node npm-guard.mjs" },
          { "type": "command", "command": "node python-cmd-guard.mjs" },
          { "type": "command", "command": "node git-safety-guard.mjs" },
          { "type": "command", "command": "node truncation-guard.mjs" },
          { "type": "command", "command": "node deprecated-guard.mjs" }
        ]
      }
    ]
  }
}
```

五个文件名对应五条 guard：

| 脚本文件名 | 作用 |
|---|---|
| `npm-guard.mjs` | 拦 `npm` / `npx`，提示改用 `pnpm` |
| `python-cmd-guard.mjs` | Windows 拦裸 `python3`（用 `python`）；Unix 拦裸 `python`（用 `python3`） |
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

后续改插件**配置**时，`plugin_manager` 的 `set_bundle` 通常会触发重组让新配置生效；
改**源码**则一定需要重启（ESM 模块缓存，见第 6 节第 3 条）。
不确定时一律以重启为准。整条不稳定路径的代价是"看起来改了、其实没生效"，
比多等一次重启贵得多。

### 验证清单

| # | 操作 | 期望 |
|---|---|---|
| 1 | `npm --version` | 被拒，返回 `🚫 [npm Guard] 已拦下 npm 命令，请改用 pnpm` |
| 2 | `python3 --version`（Windows） | 被拒，返回 `🚫 [Python Cmd Guard] …` |
| 3 | 写一个含截断占位符的文件 | 被拒，返回 `🚫 [Truncation Guard] …` |
| 4 | `pnpm --version`、`git status` | **正常执行**（不误伤） |
| 5 | `node --test <plugin>/test` | 全绿（约 490 项，含差分测试） |

第 1 条通过就基本说明装好了；第 5 条说明 oracle 也到位了。

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

> 开 `postSyntaxCheck` 的前提：`python` 在 PATH 上（Python 检查器）。
> TypeScript 那半还要求**被写文件所在的工程自己装了 `typescript`**——检查器是从
> 被检查文件目录往上找 `node_modules/typescript`，找不到就静默跳过，这是原设计。

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
├── package.json          含 dsh.bundle.patch 声明
├── cordis.patch.yml      bundle 注册：- insert: [{ id: tool-guards, name: dsh-tool-guards }]
├── lib/
│   ├── shared.js         工具名/参数的归一化（认 write/edit/pwsh 等）
│   ├── hooks-config.js   解析 hooks.json → 启用清单
│   ├── guards/           五条同步 guard（判定 + 中文文案，逐字照搬原脚本）
│   └── post/syntax.js    写后语法检查（仅 postSyntaxCheck 开启时加载）
├── oracle/               原始 CC 脚本副本，**只给测试当真值**，运行时不加载
├── test/                 单元 + 差分测试（node --test，无第三方依赖）
└── README.md             设计说明、已知偏差、排查指引
```
