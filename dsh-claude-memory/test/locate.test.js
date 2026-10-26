import assert from 'node:assert/strict'
import { isAbsolute, join, resolve } from 'node:path'
import { test } from 'node:test'
import { memoryDirFor, projectRootFor, slugFor } from '../lib/locate.js'

// 平台说明：项目根与 memory 目录的期望值依赖宿主 node:path 的 resolve()/join()。
// 原套件用 Windows 字面量当期望值，在 macOS（POSIX）上必然失败，那不是插件缺陷。
// 这里按平台选一组**通用绝对路径夹具**（不绑定任何真实机器/仓库），
// 让同一套语义在两个平台上都被诚实验证：
//
// - slugFor() 是纯字符串变换，与宿主平台无关：Windows 与 POSIX 夹具都保留。
// - projectRootFor() / memoryDirFor() 的期望值一律由 resolve()/join() 推导。

/** 独立于 slugFor 的期望值编码（CC 同一条规则的测试侧实现，用于推导期望）。 */
const encode = (path) => path.replace(/[^a-zA-Z0-9]/g, '-')

const IS_WINDOWS = process.platform === 'win32'

/** 按宿主平台选取的通用夹具；每项都是绝对路径。 */
const FIXTURE = IS_WINDOWS
  ? {
      label: 'Windows',
      projectRoot: 'D:\\Projects\\my-app',
      projectRootSlug: 'D--Projects-my-app',
      mainRepo: 'C:\\Projects\\my-bot',
      mainRepoSlug: 'C--Projects-my-bot',
      worktreeRepo: 'D:\\Projects\\worktree-target',
      homeDir: 'C:\\Users\\example',
      memoryRoot: 'C:\\root',
    }
  : {
      label: 'POSIX',
      projectRoot: '/Users/example/Projects/20261016_dsh',
      projectRootSlug: '-Users-example-Projects-20261016-dsh',
      mainRepo: '/Users/example/Projects/my-bot',
      mainRepoSlug: '-Users-example-Projects-my-bot',
      worktreeRepo: '/Users/example/Projects/universal-automation-test',
      homeDir: '/Users/example',
      memoryRoot: '/Users/example/.dsh/projects',
    }

// ---------------------------------------------------------------------------
// slugFor：纯字符串变换，Windows / POSIX 夹具都可跨平台验证。
// ---------------------------------------------------------------------------

test('slug: 反斜杠与冒号各出一个连字符（C:\\Projects\\cc）', () => {
  assert.deepEqual(slugFor('C:\\Projects\\cc'), {
    slug: 'C--Projects-cc',
    truncated: false,
  })
})

test('slug: 下划线属于非法字符，编码为连字符', () => {
  assert.equal(slugFor('D:\\Projects\\sample_macos').slug, 'D--Projects-sample-macos')
})

test('slug: 不做 toLowerCase，保留大小写', () => {
  assert.equal(slugFor('C:\\Projects\\cc').slug, 'C--Projects-cc')
})

test('slug: 超过 200 字符时截断并标记 truncated（hash36 后缀未复刻）', () => {
  const long = `C:\\${'a'.repeat(300)}`
  const result = slugFor(long)
  assert.equal(result.slug.length, 200)
  assert.equal(result.truncated, true)
})

test('slug: POSIX 路径的每个 / 各出一个连字符，含开头那个（与 macOS CC 目录名同形）', () => {
  assert.equal(
    slugFor('/Users/example/Projects/my-bot').slug,
    '-Users-example-Projects-my-bot',
  )
  assert.equal(slugFor('/Users/example').slug, '-Users-example')
})

// ---------------------------------------------------------------------------
// projectRoot 语义：**cwd 字面量，不上溯**。
//
// AC10 的判别意图：若有人把 `.git` 上溯 / worktree 归并逻辑改回来，
// 下面这些断言会立刻失败（上溯后的 slug 会等于更短的上层路径 slug）。
// 夹具按平台选取，期望 slug 由夹具推导，不绑定任何真实机器。
// 证据见 research/ac10-verification.md（69 个 CC 真实会话核对）。
// ---------------------------------------------------------------------------

test(`AC10: 普通仓库根保持自身（${FIXTURE.label} 夹具，不上溯也不变形）`, () => {
  const cwd = FIXTURE.projectRoot
  assert.equal(projectRootFor(cwd), resolve(cwd), 'projectRootFor 必须返回 cwd 字面量')
  assert.equal(slugFor(projectRootFor(cwd)).slug, FIXTURE.projectRootSlug)
})

test(`AC10: 仓库子目录不归并到仓库根（${FIXTURE.label} 夹具）`, () => {
  const cwd = join(FIXTURE.projectRoot, '2.src', 'GraphApp', 'GraphApp')
  assert.equal(projectRootFor(cwd), resolve(cwd))
  assert.equal(
    slugFor(projectRootFor(cwd)).slug,
    `${FIXTURE.projectRootSlug}-2-src-GraphApp-GraphApp`,
  )
  assert.notEqual(
    slugFor(projectRootFor(cwd)).slug,
    FIXTURE.projectRootSlug,
    '不得归并到仓库根',
  )
})

test(`AC10: 链接工作树不归回共同仓库根（${FIXTURE.label} 夹具）`, () => {
  const cwd = join(FIXTURE.mainRepo, '.claude', 'worktrees', 'fix-openrouter-display-name')
  assert.equal(projectRootFor(cwd), resolve(cwd))
  assert.equal(
    slugFor(projectRootFor(cwd)).slug,
    `${FIXTURE.mainRepoSlug}--claude-worktrees-fix-openrouter-display-name`,
  )
  assert.notEqual(
    slugFor(projectRootFor(cwd)).slug,
    FIXTURE.mainRepoSlug,
    '不得归回主仓库根',
  )
})

test(`AC10: 工作树 cwd → slug → memory 目录（${FIXTURE.label} 夹具，期望值由 resolve/join 推导）`, () => {
  const cwd = join(FIXTURE.worktreeRepo, '.claude', 'worktrees', 'frontend-ui-audit')
  const { slug } = slugFor(projectRootFor(cwd))
  assert.equal(slug, encode(resolve(cwd)))
  const memoryRoot = join(FIXTURE.homeDir, '.claude', 'projects')
  const memoryDir = memoryDirFor(memoryRoot, slug)
  assert.equal(memoryDir, join(memoryRoot, slug, 'memory'))
  assert.equal(isAbsolute(memoryDir), true)
})

test('AC10: 相对路径被绝对化', () => {
  assert.equal(isAbsolute(projectRootFor('relative/dir')), true)
})

// ---------------------------------------------------------------------------
// memoryDirFor：严格使用算法 slug，不做归一化回退。
// ---------------------------------------------------------------------------

test('memoryDir: 严格使用算法 slug，不做归一化回退', () => {
  const slug = 'D--Projects-sample-macos'
  assert.equal(memoryDirFor(FIXTURE.memoryRoot, slug), join(FIXTURE.memoryRoot, slug, 'memory'))
})

test('memoryDir: 算法 slug 不存在时也只做拼接（由调用方注入 0 字节）', () => {
  const missingSlug = 'E--Projects-Not-A-Real-Project'
  assert.equal(
    memoryDirFor(FIXTURE.memoryRoot, missingSlug),
    join(FIXTURE.memoryRoot, missingSlug, 'memory'),
  )
})
