# dsh-plugins

两个自用的 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）原生 cordis 插件，
共同目标是把 **Claude Code 的既有能力搬到 dsh 上**，并且**不改变磁盘上的数据格式**——
这样随时能迁回 Claude Code，不需要任何转换。

| 插件 | 作用 | 状态 |
|---|---|---|
| [`dsh-claude-memory`](dsh-claude-memory/README.md) | 读取 Claude Code 的 auto memory（`MEMORY.md`）并注入模型上下文，注入格式与 CC **字节级对齐** | 可用 |
| [`dsh-tool-guards`](dsh-tool-guards/README.md) | 把 CC 的 PreToolUse hooks 安全网重建为 dsh 进程内同步 guard（`ctx.tools.guard`），**零子进程** | 可用 |

两者都只读 Claude Code 的数据、只写 dsh 自己的目录，不会回写 CC 的任何路径。

---

## 为什么不用现成的社区方案

- `dsh-plugin-claude-bridge` / `dsh-auto-memory` 走的是各自的私有格式，
  一旦采用就**无法无损迁回** Claude Code；
- dsh 官方的 `@deepseek-ai/dsh-hooks-claude-code` 在 `0.2.1-rc.2` 上**包体缺失**——
  加载器报 `ERR_MODULE_NOT_FOUND`，条目 `enabled: true` 但 `fiberPhase: null`，
  配置里的 hook 全部静默失效。本仓库的 `dsh-tool-guards` 正是它的替代品。

---

## 安装

每个插件目录都是自包含的 bundle-shaped cordis 插件（`index.js` + `lib/` +
自带 `cordis.patch.yml`），**无运行时第三方依赖**。

详细步骤见 [`dsh-tool-guards/INSTALL.md`](dsh-tool-guards/INSTALL.md)，
其中「踩过的坑」一节对两个插件都适用，尤其是这一条：

> **依赖声明必须用 `link:`，不要用 `file:`。**
> pnpm 的 `file:` 会把插件**拷贝**成 `node_modules/` 下的实体目录，宿主加载的是那份副本：
> 改 `plugins/` 里的源码永远不生效，而且失败是**静默的**——条目仍显示已启用，
> 实际一条规则都不跑。

---

## 仓库结构

```
dsh-plugins/
├── dsh-tool-guards/        危险命令拦截（npm / python / git / 截断占位符 / 废弃写法）
│   ├── lib/guards/         五条同步 guard，判定逻辑与中文文案逐字照搬 CC 脚本
│   ├── lib/post/           可选的写后语法检查（默认关）
│   ├── oracle/             原始 CC 脚本副本，**仅作差分测试真值**，运行时不加载
│   ├── test/               单元 + 差分测试（node --test，无第三方依赖）
│   ├── INSTALL.md          新环境安装指南
│   └── README.md           设计说明、已知偏差、排查指引
└── dsh-claude-memory/      读取 CC 的 MEMORY.md 并注入上下文
    ├── lib/                locate（定位 memory 目录）/ render（渲染）/ inject（注入）
    ├── test/               45 项测试，含与 CC 真实字节输出的对拍
    └── README.md           算法证据、已知偏差
```

---

## 测试

两个插件都用 Node 内置测试运行器，不需要装任何依赖：

```powershell
node --test dsh-tool-guards/test
node --test dsh-claude-memory/test
```

`dsh-tool-guards` 的差分测试会把 `oracle/` 里的**原始 Claude Code 脚本真的跑起来**，
与插件实现逐字比对返回值（含中文标点与空格）。所以 `oracle/` 不是装饰，
**删了差分测试就没有真值来源了**。

---

## 兼容性

开发与验证环境：dsh desktop `0.2.1-rc.2` / Node v26 / Windows 11 + PowerShell 7。
插件只用 Node 内置模块，Unix 上理论可用，但 `dsh-tool-guards` 的平台分支
（Windows 拦裸 `python3`、Unix 拦裸 `python`）在 Unix 侧是靠**预载改写
`process.platform` 驱动原脚本**做的差分验证，不是在真实 Unix 上跑过。
