# dsh-claude-memory

读取 Claude Code 的 auto memory 索引（`MEMORY.md`）并注入 dsh 的模型上下文。
**注入结果与 Claude Code 逐字对齐**，使未来迁回 CC 只需复制目录、无需格式转换。

插件**只读**：不写任何 memory 文件，不改写 CC 的存储格式。

## 两份副本：哪份是权威

| 副本 | 路径 | 角色 |
|---|---|---|
| **运行副本（权威）** | `~/.dsh/profiles/desktop/plugins/dsh-claude-memory/` | dsh 实际加载的就是它。**改代码改这里。** |
| 审计快照 | `<仓库>/.trellis/tasks/10-16-claude-memory-plugin/deliverable/` | 仅供版本控制与事后追溯，**不是**运行副本 |

两份**没有自动同步**。快照是手工复制的，`deliverable/MANIFEST.sha256` 记录了复制时的哈希，
可用它检出漂移：

```powershell
cd .trellis/tasks/10-16-claude-memory-plugin/deliverable
Get-Content MANIFEST.sha256 | ForEach-Object {
  $h,$f = $_ -split '  ',2
  $a = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
  "{0}  {1}" -f $(if($a -eq $h){'OK '}else{'DIFF'}), $f
}
```

发现 DIFF 时：**以运行副本为准**，重新复制并更新 `MANIFEST.sha256`。

## 挂载

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加（**必须包在 `insert:` 内**）：

```yaml
- insert:
    - id: claude-memory
      name: ./plugins/dsh-claude-memory/index.js
      config:
        memoryRoot: ~/.dsh/projects
```

`name` 以 `.` 开头，按 profile 目录解析（cordis loader 的 `baseUrl` 语义）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `memoryRoot` | `$DSH_HOME/projects` | 记忆根目录。支持 `~` / `~/` / `~\` 前缀 |
| `maxLines` | `200` | 索引行数上限 |
| `maxCodeUnits` | `25000` | 索引长度上限，单位是 **UTF-16 code unit**（不是 UTF-8 字节，见下） |
| `diagnostics` | `true` | 每个会话输出一次定位诊断 |

## 行为

**定位**：`cwd` → 项目根（**共同仓库根**，链接工作树会归回主仓库）→ CC 的 slug 算法 → `<memoryRoot>/<slug>/memory/MEMORY.md`。

**无回退**：只使用算法 slug。不扫描 `-`/`_` 归一化别名、不合并多个目录。
算法 slug 不存在时注入 0 字节——这与 CC 自身行为一致。

**注入形态**：

```
<system-reminder>
Codebase and user instructions are shown below. …（CC 前言原文）
Contents of <MEMORY.md 绝对路径> (user's auto-memory, persists across conversations):
<净化并 trim 后的索引内容>
</system-reminder>
```

**幂等**：同一会话内容未变时不重复注入；内容变化后重注入；压缩后自动重注入。

## 排查：为什么注入了 0 字节

开 `diagnostics`（默认开），日志里会有：

```
claude-memory: no MEMORY.md at <路径> (memoryRoot=…, slug=…); injecting nothing — …
```

对照检查三件事：

1. **路径对不对**：日志里的 `memoryRoot` 与 `slug` 是否指向你预期的项目。
   - slug 的算法是「每个非 `[a-zA-Z0-9]` 字符各出一个 `-`」，且**不做** toLowerCase。
     例：`C:\PersonalFiles\cc` → `C--PersonalFiles-cc`。
   - 若你的项目在**链接工作树**或**仓库子目录**里，slug 仍取 **cwd 字面量**，不上溯到仓库根
     ——这与 CC 一致（已用 69 个真实会话核对）。
2. **文件在不在**：`<memoryRoot>/<slug>/memory/MEMORY.md` 是否存在且非空。
3. **迁移做没做**：`memoryRoot` 默认指向 `~/.dsh/projects`。若还没从 `~/.claude/projects`
   迁过来，这里自然是空的——临时把 `memoryRoot` 指向 `C:/Users/<you>/.claude/projects` 即可先验证插件本身。

## 验收对照（均已实测）

证据文件位于仓库 `.trellis/tasks/10-16-claude-memory-plugin/research/`。

| AC | 内容 | 结果 | 证据文件 |
|---|---|---|---|
| AC1 | 与 CC 真实注入逐字一致 | **98/98** | `ac1-verification.md` |
| AC2 | 截断三分支逐字一致 | **5/5** | `ac2-verification.md` |
| AC3 | 无回退（遗留 `_` 目录不被读取） | 注入 0 字节 | `ac3-ac5-ac7-verification.md` |
| AC4 | 幂等与更新（含压缩重注入、A→B→A） | **4/4** | `ac4-verification.md` |
| AC5 | 空态 → 0 字节 + 诊断 | 3/3 | `ac3-ac5-ac7-verification.md` |
| AC7 | hooks 桥接无回归 | 2116/2116 pass | 同上 |
| AC9 | 迁移逐文件哈希一致 | 10552 文件 | `migration-record.md` |
| AC10 | slug 定位与 CC 一致 | **69/69** | `ac10-verification.md` |

AC1 的方法：用 CC transcript 里的**字节级**真实注入（`$.rendered[0].content`）与当时的原文
（`$.attachment.files[AutoMem].content`）配对，扫描 1917 个 jsonl 得到 **98 处注入样本**：

| 断言 | 结果 |
|---|---|
| 整块以 `<system-reminder>\n` 开头、`\n</system-reminder>` 结尾 | **98/98** |
| AutoMem 段 == `表头 + "\n\n" + 原文.trim()` | **98/98** |

**结论：初次注入形态逐字一致。**

## 已知偏差

### 未实现：增量重读变体

CC 的前言有**三种变体**（实测）。本插件只实现**变体 1（初次注入）**：

1. **初次注入**：`Codebase and user instructions are shown below. …as written.` ✅ 已实现
2. **会话启动重读**：`Instruction files were re-read when this session started; …the instructions preamble above still applies:` ❌
3. **压缩后重读**：`Instruction files were re-read after the conversation was compacted; …` ❌

变体 2/3 **只发送发生变化的文件**且不重复前言——这需要跟踪「文件自上次注入以来是否变化」，
本插件没有该状态。压缩后重注入时，本插件发送**完整的变体 1 块**。
段格式（表头 + `\n\n` + trim）三者相同，差异只在前言与「发哪些文件」。

### 未验证：`consumedLines === 0` 分支

截断提示语的三条主分支已用 5 个夹具逐字对齐（AC2）。但还有一条边界分支——「单行且超长，
以至于第 1 行前 N 个字符之后全被切掉」——**没有任何夹具触发过**，其措辞未经字节验证。

### 未验证：`formatSize` 的输入单位

提示语里的 `(limit: 24.4KB)` 由 `(n/1024).toFixed(1) + "KB"` 生成。`n` 是码元还是字节
尚无定论：判别性夹具 D/E 已排除「**截断阈值**按字节」，但未直接命中该**显示**分支。
（截断阈值本身是 **25000 code unit**，与 `24.4KB` 的显示无关。）

### 未验证：内容含标签或控制字符

样本中无一例含 `<system-reminder>` 字面量或控制字符，故 CC 在这些情形下的行为未知。

本实现对内容**只做 `.trim()`**（与 98/98 观测一致）；另在 `wrapSystemReminder` 里对
**整块 body**（含前言）做一次字面 `</system-reminder>` → HTML 实体转义，以防块被提前闭合。
**后者未经验证**，但对全部 98 个样本都是空操作。这是**唯一一处主动偏离** CC 的地方，
属于安全取舍——CC 在同样输入下大概率会真的提前闭合。

> 反面教训：`claude.exe` 里还原出的 `s()`（会把 `\r\n` 归一化为 `\n`）与 `Aae()`（标签中和）
> **不在 AutoMem 这条路径上**。若照源码实现而不做对照，98 个样本会**全部失配**，
> 且失配点极隐蔽（CRLF 被静默吃掉）。这两个函数**已从实现中删除**——留着会诱导后来者重新接上。

### slug 超 200 字符

CC 会追加 `-<hash36(projectRoot)>`，该哈希未还原；本实现只截断并发诊断。
现有 129 个真实 slug 均未触及该阈值。

### 宿主结构性偏差（插件侧无法消除）

CC 的 `Vi` 前言统辖**全部**指令文件（AGENTS.md 与 MEMORY.md 在同一个 `<system-reminder>` 里）；
dsh 里它只统辖 `MEMORY.md`，`AGENTS.md` 由 `agent-instructions` 用另一套措辞放在另一个块。
单文件场景下逐字一致。

## 实现说明

**为什么用 `node:fs` 而不是 `ctx.fs`**：读取不受沙箱限制（`fs-sandbox` 只栅栏写入），
而 `ctx.fs.stat` 的返回结构（`FsInfo`）在调研中未能确证——猜错会让定位逻辑**静默失效**。
`node:fs` 的 `Stats` 语义确定，不会产生这类风险。

**为什么 `inject` 为空数组**：`inject` 列出的服务必须全部在场，否则插件永久 PENDING。
本插件不需要任何服务在场，因此不声明依赖。

**异常处理**：`agent/pre-step` 监听器整体 `try/catch`。pre-step 抛异常会让当前 turn 失败，
且该步输入已被 claim，代价高于"少注入一块记忆"，故异常时原样返回下游决策并记 warn 日志。

## 测试

```powershell
node --test "$env:USERPROFILE\.dsh\profiles\desktop\plugins\dsh-claude-memory\test"
```
