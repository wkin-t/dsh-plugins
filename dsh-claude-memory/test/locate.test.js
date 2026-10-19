import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { test } from 'node:test'
import { memoryDirFor, projectRootFor, slugFor } from '../lib/locate.js'

test('slug: 反斜杠与冒号各出一个连字符（C:\\PersonalFiles\\cc）', () => {
  assert.deepEqual(slugFor('C:\\PersonalFiles\\cc'), {
    slug: 'C--PersonalFiles-cc',
    truncated: false,
  })
})

test('slug: 下划线属于非法字符，编码为连字符', () => {
  assert.equal(slugFor('E:\\TestProjects\\20261013_macos').slug, 'E--TestProjects-20261013-macos')
})

test('slug: 不做 toLowerCase，保留大小写', () => {
  assert.equal(slugFor('C:\\PersonalFiles\\cc').slug, 'C--PersonalFiles-cc')
})

test('slug: 超过 200 字符时截断并标记 truncated（hash36 后缀未复刻）', () => {
  const long = `C:\\${'a'.repeat(300)}`
  const result = slugFor(long)
  assert.equal(result.slug.length, 200)
  assert.equal(result.truncated, true)
})

// ---------------------------------------------------------------------------
// projectRoot 语义：**cwd 字面量，不上溯**。
//
// 下面三条的期望值全部取自 `~/.claude/projects` 里**真实存在的目录名**，
// 即 CC 自己在同样 cwd 下生成的 slug。若有人把 `.git` 上溯逻辑改回来，
// 这三条会立刻失败。证据见 research/ac10-verification.md。
// ---------------------------------------------------------------------------

test('AC10: 普通仓库根保持自身（不上溯也不变形）', () => {
  assert.equal(
    slugFor(projectRootFor('E:\\TestProjects\\20261016_dsh')).slug,
    'E--TestProjects-20261016-dsh',
  )
})

test('AC10: 仓库子目录不归并到仓库根（CC 实测目录名）', () => {
  // CC 侧真实目录：E--TestProjects-PecStar-Pro-2-src-GraphApp-GraphApp
  // 曾经的实现会返回 E:\TestProjects\PecStar-Pro → slug 少掉两级，指向错误记忆库
  assert.equal(
    slugFor(projectRootFor('E:\\TestProjects\\PecStar-Pro\\2.src\\GraphApp\\GraphApp')).slug,
    'E--TestProjects-PecStar-Pro-2-src-GraphApp-GraphApp',
  )
  // CC 侧真实目录：E--TestProjects-PecStar-Pro-2-src-application-SIMS-PecWavePro
  assert.equal(
    slugFor(projectRootFor('E:\\TestProjects\\PecStar-Pro\\2.src\\application\\SIMS\\PecWavePro')).slug,
    'E--TestProjects-PecStar-Pro-2-src-application-SIMS-PecWavePro',
  )
})

test('AC10: 链接工作树不归回共同仓库根（CC 实测目录名）', () => {
  // CC 侧真实目录：C--PersonalFiles-dingtalk-ai-bot--claude-worktrees-fix-openrouter-display-name
  // 曾经的实现会读 .git → gitdir → commondir，返回 C:\PersonalFiles\dingtalk-ai-bot
  assert.equal(
    slugFor(projectRootFor('C:\\PersonalFiles\\dingtalk-ai-bot\\.claude\\worktrees\\fix-openrouter-display-name')).slug,
    'C--PersonalFiles-dingtalk-ai-bot--claude-worktrees-fix-openrouter-display-name',
  )
})

test('AC10: 工作树 cwd → slug → memory 目录（CC 侧该 slug 下确有 memory/）', () => {
  const { slug } = slugFor(
    projectRootFor('E:\\TestProjects\\universal-automation-test\\.claude\\worktrees\\frontend-ui-audit'),
  )
  assert.equal(slug, 'E--TestProjects-universal-automation-test--claude-worktrees-frontend-ui-audit')
  assert.equal(memoryDirFor('C:\\root', slug), `C:\\root\\${slug}\\memory`)
})

test('AC10: 相对路径被绝对化', () => {
  assert.equal(isAbsolute(projectRootFor('relative/dir')), true)
})

test('memoryDir: 严格使用算法 slug，不做归一化回退', () => {
  assert.equal(
    memoryDirFor('C:\\root', 'E--TestProjects-20261013-macos'),
    'C:\\root\\E--TestProjects-20261013-macos\\memory',
  )
})
