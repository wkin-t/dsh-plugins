/**
 * Claude Code 的项目记忆定位：projectRoot → slug → memory 目录。
 *
 * slug 与 projectRoot 的规则来自对 claude.exe v2.1.300 的字节级还原，
 * 证据见任务 research/cc-verbatim-strings.md 与 cc-memory-store-reality.md。
 *
 * ⚠️ 其中 projectRoot 的语义（= cwd 字面量，**不上溯**）已由 AC10 实测校正：
 * 源码还原出的「共同仓库根」是错的，见 research/ac10-verification.md。
 *
 * 本模块只做纯计算 + 通过注入的 fs 适配器做只读探测，不依赖 dsh 服务类型，
 * 以便脱离运行时单测。
 *
 * @module dsh-claude-memory/locate
 */
import { join, resolve } from 'node:path'

/** slug 的截断长度上限（CC 算法）。 */
export const MAX_SLUG_LENGTH = 200

/**
 * 按 CC 算法把项目根路径编码为 slug。
 *
 * `[^a-zA-Z0-9]` 的每个字符各出一个 `-`，不做 toLowerCase。
 * 例：`C:\Projects\cc` → `C--Projects-cc`（`:` 与 `\` 各一个 `-`）。
 *
 * ⚠️ 已知偏差：CC 在 slug 超过 200 字符时会追加 `-<hash36(projectRoot)>`，
 * 该 hash 函数尚未还原。此处只做截断，并通过 `truncated` 让调用方发诊断，
 * 不伪造 hash 值。
 *
 * @param projectRoot - 项目根绝对路径。
 * @returns 编码后的 slug 与是否发生了截断。
 */
export function slugFor(projectRoot) {
  const raw = projectRoot.replace(/[^a-zA-Z0-9]/g, '-')
  if (raw.length <= MAX_SLUG_LENGTH) return { slug: raw, truncated: false }
  return { slug: raw.slice(0, MAX_SLUG_LENGTH), truncated: true }
}

/**
 * 解析项目根：**就是 cwd 字面量**，不做任何上溯。
 *
 * 曾经的实现会向上找 `.git`，并把链接工作树归回共同仓库根。那是从
 * claude.exe 还原出的推断，**已被实测推翻**（见 `research/ac10-verification.md`）：
 *
 * 1. `~/.claude/projects` 下存在 12 个 worktree slug 目录，目录名 == `slugFor(worktree 路径)`；
 *    其中 `D--Projects-worktree-target--claude-worktrees-frontend-ui-audit`
 *    下**有 `memory/` 目录**，说明记忆库同样按 cwd 字面量分 key，没有归并。
 * 2. 以 CC 自己的 69 个会话目录为 oracle：上溯实现命中 66/69，3 个不符全部由上溯造成
 *    （1 个 worktree + 2 个 `PecStar-Pro` 仓库子目录）；改为 cwd 字面量后 69/69。
 *
 * 因此「仓库子目录」与「链接工作树」各自拥有独立 slug，与 CC 一致。
 *
 * @param cwd - 起始目录（通常为会话的 `header.cwd`）。
 * @returns 项目根绝对路径。
 */
export function projectRootFor(cwd) {
  return resolve(cwd)
}

/**
 * 计算某个 slug 对应的 memory 目录绝对路径。
 *
 * **严格对齐 CC：不做任何回退。** 不扫描 `-`/`_` 归一化别名、不合并多个目录。
 * 算法 slug 目录不存在时，调用方应注入 0 字节（这正是 CC 自身的行为）。
 *
 * @param memoryRoot - 记忆根目录绝对路径。
 * @param slug - 已编码的 slug。
 * @returns memory 目录绝对路径。
 */
export function memoryDirFor(memoryRoot, slug) {
  return join(memoryRoot, slug, 'memory')
}

/**
 * 读取该项目的 `MEMORY.md` 原文。
 *
 * @param memoryDir - memory 目录绝对路径。
 * @param fs - 只读文件系统适配器：`{ stat(path), readText(path) }`。
 * @param signal - 取消信号。
 * @returns 文件绝对路径与原文；文件不存在时 `text` 为 undefined。
 */
export async function readMemoryIndex(memoryDir, fs, signal) {
  const memoryPath = join(memoryDir, 'MEMORY.md')
  signal?.throwIfAborted()
  const info = await fs.stat(memoryPath)
  if (info === undefined || info.kind !== 'file') return { memoryPath, text: undefined }
  const text = await fs.readText(memoryPath)
  return { memoryPath, text }
}
