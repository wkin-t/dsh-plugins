# dsh-plugins

两个 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）原生 cordis 插件。

| 插件 | 作用 |
|---|---|
| [`dsh-claude-memory`](dsh-claude-memory/README.md) | 把一份 automemory 索引（`MEMORY.md`）注入 dsh 会话上下文。格式与 Claude Code 的 automemory 同构。 |
| [`dsh-tool-guards`](dsh-tool-guards/README.md) | 把危险命令拦截做成 dsh **进程内同步 guard**（`ctx.tools.guard`），零子进程。拦 `npm`/`npx`、Windows 上的裸 `python3`、`git push --force`/`reset --hard`/`clean -fd`/`branch -D` 等。 |

两者都只读工作区之外的数据、只写自己的配置，不修改你的项目文件。

> **注意**：`dsh` 本身没有内置 automemory。`dsh-claude-memory` 补的是这个空缺，
> 它自己维护 `$DSH_HOME/projects/<slug>/memory/` 这套目录。

---

## 安装

两个插件都是自包含的 bundle-shaped cordis 插件（`index.js` + `lib/` +
自带 `cordis.patch.yml`），**无运行时第三方依赖**。

详细步骤见 [`dsh-tool-guards/INSTALL.md`](dsh-tool-guards/INSTALL.md)，其中「踩过的坑」
一节对两个插件都适用。最关键的是一条：

> **依赖声明必须用 `link:`，不要用 `file:`。**
> pnpm 的 `file:` 会把插件**拷贝**成 `node_modules/` 下的实体副本，宿主加载那份副本：
> 改源码永远不生效，而且失败是**静默的** —— 条目仍显示已启用，实际一条规则都不跑。

---

## 仓库结构

```
dsh-plugins-public/
├── dsh-claude-memory/      读取 MEMORY.md 索引并注入上下文
│   ├── lib/                locate（定位 memory 目录）/ render（渲染）/ inject（注入）
│   └── test/               locate / render / inject / roots / working-dir
└── dsh-tool-guards/        危险命令拦截
    ├── lib/guards/         五条同步 guard（npm / pythonCmd / gitSafety / deprecated / truncation）
    ├── lib/post/           可选的写后语法检查（默认关）
    ├── test/               单元测试 + 差分测试
    ├── INSTALL.md          新环境安装指南
    └── README.md           设计说明、已知偏差、排查指引
```

---

## 测试

Node 内置测试运行器，不需要额外依赖：

```bash
pnpm install     # 只为让插件的宿主包导入可解析
pnpm test
```

### 关于差分测试需要你自备 `oracle/`

`dsh-tool-guards` 的差分测试会拿**原始脚本**当 oracle，逐条比对判定结果与中文文案
（含标点与空格），确认移植没有走样。那些原始脚本派生自 Claude Code 自带的 hook 脚本，
**属于第三方版权内容，因此本仓库不包含它们**。

所以：

- `differential.test.js` / `platform.test.js` / `sshWarning.test.js` 在缺少 `oracle/`
  时会**整组标记为 skip**，`pnpm test` 仍然全绿。
- 想跑完整差分测试：自己准备 `dsh-tool-guards/oracle/` 目录，结构如下
  （目录名与文件名必须是这些，测试按固定路径找）：

  ```
  dsh-tool-guards/oracle/
  ├── helpers/
  │   ├── hook-input.mjs
  │   ├── npm-guard.mjs
  │   ├── python-cmd-guard.mjs
  │   ├── git-safety-guard.mjs
  │   ├── truncation-guard.mjs
  │   └── deprecated-guard.mjs
  └── hooks/
      ├── check-python-syntax.py
      └── check-ts-syntax.mjs
  ```

  每个 guard 脚本的契约：从 stdin 读一个 hooks 形状的 JSON，放行时 stdout 为空；
  拦截时 stdout 输出带 `decision` / `reason` 字段的 JSON。

---

## 兼容性

开发与验证环境：dsh desktop `0.2.1-rc.3` / Node 24+ / Windows 11 + PowerShell 7。

`dsh-claude-memory` 的注入格式按字节对齐 Claude Code（`<system-reminder>` 包裹
`Contents of <path> (user's auto-memory, persists across conversations):`），
截断预算 200 行 / 25000 UTF-16 code units。

---

## License

MIT，见 [LICENSE](LICENSE)。
