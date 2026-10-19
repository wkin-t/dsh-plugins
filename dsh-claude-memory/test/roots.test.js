import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ROOT_SOURCE,
  claudeProjectsRoot,
  dshProjectsRoot,
  resolveMemoryRoot,
} from '../lib/roots.js'

// 注入固定路径，避免测试依赖当前机器；期望值一律用 node:path 拼，
// 这样在 POSIX 与 Windows 上都是平台正确的写法。
const DSH_HOME = '/Users/porter/.dsh'
const HOME_DIR = '/Users/porter'
const DSH_PROJECTS = dshProjectsRoot(DSH_HOME)
const CLAUDE_PROJECTS = claudeProjectsRoot(HOME_DIR)

/**
 * 构造记录探测路径的存在性谓词。
 * @param existing - 视为存在的路径列表。
 * @returns `{ exists, probed }`。
 */
function existsOf(existing) {
  const probed = []
  const exists = async (path) => {
    probed.push(path)
    return existing.includes(path)
  }
  return { exists, probed }
}

test('resolveMemoryRoot: 显式配置最高优先级，且完全不探测文件系统', async () => {
  const { exists, probed } = existsOf([DSH_PROJECTS, CLAUDE_PROJECTS])
  const result = await resolveMemoryRoot({
    configured: '/Volumes/claude-memory',
    dshHome: DSH_HOME,
    homeDir: HOME_DIR,
    exists,
  })
  assert.equal(result.memoryRoot, '/Volumes/claude-memory')
  assert.equal(result.source, ROOT_SOURCE.CONFIGURED)
  assert.deepEqual(probed, [], '显式配置不应触发存在性探测')
  assert.equal(result.candidates.dshProjects, DSH_PROJECTS)
  assert.equal(result.candidates.claudeProjects, CLAUDE_PROJECTS)
})

test('resolveMemoryRoot: 空白配置视为未配置（继续按默认顺序探测）', async () => {
  const { exists } = existsOf([DSH_PROJECTS])
  const result = await resolveMemoryRoot({
    configured: '   ',
    dshHome: DSH_HOME,
    homeDir: HOME_DIR,
    exists,
  })
  assert.equal(result.memoryRoot, DSH_PROJECTS)
  assert.equal(result.source, ROOT_SOURCE.DSH_PROJECTS)
})

test('resolveMemoryRoot: $DSH_HOME/projects 存在时优先于 ~/.claude/projects', async () => {
  const { exists, probed } = existsOf([DSH_PROJECTS, CLAUDE_PROJECTS])
  const result = await resolveMemoryRoot({ dshHome: DSH_HOME, homeDir: HOME_DIR, exists })
  assert.equal(result.memoryRoot, DSH_PROJECTS)
  assert.equal(result.source, ROOT_SOURCE.DSH_PROJECTS)
  assert.deepEqual(probed, [DSH_PROJECTS], '$DSH_HOME/projects 命中后不应再探测 CC store')
})

test('resolveMemoryRoot: $DSH_HOME/projects 不存在时回退到 ~/.claude/projects（macOS 真实 store）', async () => {
  const { exists, probed } = existsOf([CLAUDE_PROJECTS])
  const result = await resolveMemoryRoot({
    configured: '',
    dshHome: DSH_HOME,
    homeDir: HOME_DIR,
    exists,
  })
  assert.equal(result.memoryRoot, CLAUDE_PROJECTS)
  assert.equal(result.source, ROOT_SOURCE.CLAUDE_PROJECTS)
  assert.deepEqual(probed, [DSH_PROJECTS, CLAUDE_PROJECTS])
})

test('resolveMemoryRoot: 两个默认根都不存在时兜底 $DSH_HOME/projects（保留既有诊断路径）', async () => {
  const { exists, probed } = existsOf([])
  const result = await resolveMemoryRoot({ dshHome: DSH_HOME, homeDir: HOME_DIR, exists })
  assert.equal(result.memoryRoot, DSH_PROJECTS)
  assert.equal(result.source, ROOT_SOURCE.DSH_PROJECTS_FALLBACK)
  assert.deepEqual(probed, [DSH_PROJECTS, CLAUDE_PROJECTS])
})

test('resolveMemoryRoot: 存在性探测抛异常按“不存在”处理，不向外抛', async () => {
  const probed = []
  const exists = async (path) => {
    probed.push(path)
    throw new Error(`EACCES: ${path}`)
  }
  const result = await resolveMemoryRoot({ dshHome: DSH_HOME, homeDir: HOME_DIR, exists })
  assert.equal(result.memoryRoot, DSH_PROJECTS)
  assert.equal(result.source, ROOT_SOURCE.DSH_PROJECTS_FALLBACK)
  assert.deepEqual(probed, [DSH_PROJECTS, CLAUDE_PROJECTS])
})

test('resolveMemoryRoot: 单个探测异常不影响后续回退分支', async () => {
  const probed = []
  const exists = async (path) => {
    probed.push(path)
    if (path === DSH_PROJECTS) throw new Error('EACCES')
    return path === CLAUDE_PROJECTS
  }
  const result = await resolveMemoryRoot({ dshHome: DSH_HOME, homeDir: HOME_DIR, exists })
  assert.equal(result.memoryRoot, CLAUDE_PROJECTS)
  assert.equal(result.source, ROOT_SOURCE.CLAUDE_PROJECTS)
  assert.deepEqual(probed, [DSH_PROJECTS, CLAUDE_PROJECTS])
})

test('resolveMemoryRoot: exists 允许是同步谓词（契约不强制 async）', async () => {
  const result = await resolveMemoryRoot({
    dshHome: DSH_HOME,
    homeDir: HOME_DIR,
    exists: (path) => path === DSH_PROJECTS,
  })
  assert.equal(result.memoryRoot, DSH_PROJECTS)
  assert.equal(result.source, ROOT_SOURCE.DSH_PROJECTS)
})

test('默认候选路径：$DSH_HOME/projects 与 ~/.claude/projects（用 node:path 拼）', () => {
  assert.equal(DSH_PROJECTS, join(DSH_HOME, 'projects'))
  assert.equal(CLAUDE_PROJECTS, join(HOME_DIR, '.claude', 'projects'))
})
