/**
 * deprecated guard 的单元测试。
 *
 * @module dsh-tool-guards/test/deprecated
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { check } from '../lib/guards/deprecated.js'

/** 该 guard 只看路径，content 只是为了贴近真实调用。 */
const CONTENT = 'export const a = 1\n'

test('写 _deprecated/ 被拦', () => {
  const reason = check('write', { file_path: 'C:\\proj\\src\\_deprecated\\old.js', content: CONTENT })
  assert.match(reason, /已拦下对废弃目录的写入/)
  assert.ok(reason.includes('C:\\proj\\src\\_deprecated\\old.js'))
})

test('写 deprecated/ 被拦', () => {
  assert.ok(check('write', { file_path: '/proj/src/deprecated/old.js', content: CONTENT }))
})

test('写 legacy/ 被拦', () => {
  assert.ok(check('edit', { file_path: '/proj/src/legacy/a.js', old_string: 'a', new_string: 'b' }))
})

test('大小写不敏感（Legacy）', () => {
  assert.ok(check('write', { file_path: 'C:\\proj\\LEGACY\\a.js', content: CONTENT }))
})

test('普通目录放行', () => {
  assert.equal(check('write', { file_path: 'C:\\proj\\src\\main.js', content: CONTENT }), undefined)
})

test('agent 配置目录里的 legacy 放行', () => {
  for (const filePath of [
    'C:\\Users\\example\\.dsh\\legacy\\x.js',
    'C:\\Users\\example\\.claude\\legacy\\x.js',
    'C:\\proj\\.codex\\legacy\\x.js',
    'C:\\proj\\.github\\legacy\\x.js',
  ]) {
    assert.equal(check('write', { file_path: filePath, content: CONTENT }), undefined, `不应拦截：${filePath}`)
  }
})

test('node_modules 里的 legacy 放行', () => {
  assert.equal(
    check('write', { file_path: 'C:\\proj\\node_modules\\pkg\\legacy\\a.js', content: CONTENT }),
    undefined,
  )
})

test('非写入工具放行（即使路径命中）', () => {
  assert.equal(check('read', { file_path: 'C:\\proj\\src\\legacy\\a.js' }), undefined)
  assert.equal(check('pwsh', { command: 'cat C:\\proj\\src\\legacy\\a.js' }), undefined)
})

test('缺路径时放行', () => {
  assert.equal(check('write', { content: CONTENT }), undefined)
  assert.equal(check('write', {}), undefined)
})

test('路径取第一个候选：file_path 优先于 path', () => {
  assert.equal(
    check('write', { file_path: 'C:\\proj\\src\\main.js', path: 'C:\\proj\\src\\legacy\\a.js', content: CONTENT }),
    undefined,
    'file_path 存在时以它为准，不应被 path 带偏',
  )
})
