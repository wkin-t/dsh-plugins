/**
 * truncation guard 的单元测试：四条占位符正则、长度门槛、配置目录豁免、
 * 以及「只查 new_string」这条容易踩的语义。
 *
 * @module dsh-tool-guards/test/truncation
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { check } from '../lib/guards/truncation.js'

/** 写入一个 JS 文件，正文里放指定占位符。 */
function writeWith(content, filePath = 'C:\\proj\\a.js') {
  return check('write', { file_path: filePath, content })
}

test('规则 1：注释 + 省略号 + 英文省略词', () => {
  for (const content of [
    'function a() {\n  return 1\n}\n\n// ... rest of the code unchanged\n',
    'const a = 1\n// ... remaining\nexport { a }\n',
    'const a = 1\n// ... keep going\n',
    'const a = 1\n/* ... existing */\nconst b = 2\n',
    'const a = 1\n# ... same\nconst b = 2\n',
    'const a = 1\n-- ... previous\nconst b = 2\n',
    'const a = 1\n<!-- ... truncat\nconst b = 2\n',
  ]) {
    assert.match(writeWith(content), /已拦下疑似不完整代码写入/, `应拦下：${JSON.stringify(content)}`)
  }
})

test('规则 2：注释 + rest unchanged 之类的括号写法', () => {
  for (const content of [
    'const a = 1\nconst b = 2\n// rest unchanged\nconst c = 3\n',
    'const a = 1\n// remaining omitted\nconst b = 2\n',
    'const a = 1\n# code stays the same\nconst b = 2\n',
    'const a = 1\n// (rest omitted)\nconst b = 2\n',
  ]) {
    assert.match(writeWith(content), /已拦下疑似不完整代码写入/, `应拦下：${JSON.stringify(content)}`)
  }
})

test('规则 3：注释 + 省略号 + 中文省略语', () => {
  for (const content of [
    'const a = 1\n// ... 其余代码保持不变\nconst b = 2\n',
    'const a = 1\n// ... 剩余部分\nconst b = 2\n',
    'const a = 1\n# ... 省略\nconst b = 2\n',
  ]) {
    assert.match(writeWith(content), /已拦下疑似不完整代码写入/, `应拦下：${JSON.stringify(content)}`)
  }
})

test('规则 4：注释 + 方括号包裹的省略语', () => {
  for (const content of [
    'const a = 1\n// [rest of the implementation omitted]\nconst b = 2\n',
    'const a = 1\n// [remaining]\nconst b = 2\n',
  ]) {
    assert.match(writeWith(content), /已拦下疑似不完整代码写入/, `应拦下：${JSON.stringify(content)}`)
  }
})

test('匹配内容是命中那一行（trim 后），不是整段正文', () => {
  const content = 'const a = 1\n    // ... rest of code   \nconst b = 2\n'
  const reason = writeWith(content)
  assert.equal(reason.split('\n')[1], '   匹配内容: // ... rest of code')
})

test('匹配内容超过 100 字符时截断', () => {
  const line = `// [rest ${'x'.repeat(300)}]`
  const reason = writeWith(`const a = 1\n${line}\n`)
  assert.equal(reason.split('\n')[1], `   匹配内容: ${line.substring(0, 100)}`)
})

test('短内容不检查（内容 < 20 字符）', () => {
  assert.equal(writeWith('// ...rest'), undefined)
})

test('完整代码放行', () => {
  assert.equal(writeWith('export function add(a, b) {\n  return a + b\n}\n'), undefined)
  assert.equal(writeWith('const a = 1\nconst b = 2\nconsole.log(a + b)\n'), undefined)
})

test('配置目录里的占位符放行（这些目录自身把截断字符串当测试数据）', () => {
  for (const filePath of [
    'C:\\Users\\example\\.claude\\helpers\\t.js',
    'C:\\Users\\example\\.dsh\\plugins\\x.js',
    'C:\\proj\\.codex\\h.js',
    'C:\\proj\\.github\\w.js',
  ]) {
    assert.equal(writeWith('const s = "// ... rest of code"\n', filePath), undefined, `不应拦截：${filePath}`)
  }
})

test('edit 只查 new_string，old_string 里的占位符不算', () => {
  const fixed = check('edit', {
    file_path: 'C:\\proj\\a.js',
    old_string: '// ... rest of code',
    new_string: 'export const add = (a, b) => a + b\n',
  })
  assert.equal(fixed, undefined, '把占位符替换成完整代码是正确修复，不能拦')

  const regressed = check('edit', {
    file_path: 'C:\\proj\\a.js',
    old_string: 'export const add = (a, b) => a + b',
    new_string: 'export const add = (a, b) => a + b\n// ... rest of code\n',
  })
  assert.match(regressed, /已拦下疑似不完整代码写入/)
})

test('apply_patch 形态：patch 文本也会被检查（认「拿到内容」这条后门）', () => {
  const patch = '*** Begin Patch\n*** Update File: a.js\n@@\n-const a = 1\n+// ... rest of code\n*** End Patch\n'
  assert.match(check('apply_patch', { patch }), /已拦下疑似不完整代码写入/)
})

test('text 字段同样被检查（其他 agent CLI 的写入形状）', () => {
  assert.match(check('write', { file_path: 'C:\\proj\\a.txt', text: 'line1\n// ... rest of code\n' }), /已拦下/)
})

test('非写入工具且无内容时放行', () => {
  assert.equal(check('read', { file_path: 'C:\\proj\\_deprecated\\a.js' }), undefined)
  assert.equal(check('pwsh', { command: 'echo "// ... rest of code"' }), undefined)
})

test('写入空文件放行（content 为空串）', () => {
  assert.equal(check('write', { file_path: 'C:\\proj\\empty.js', content: '' }), undefined)
})
