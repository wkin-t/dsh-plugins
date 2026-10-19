/**
 * 差分测试：拿**原始 CC 脚本**当 oracle，逐条比对判定与文案。
 *
 * 为什么不做"写死期望文案"的对比：那只是把实现抄了两遍，抄错的地方会一起错。
 * 这里真的把 `.mjs` 跑起来（CC 形状的 JSON 喂 stdin），从 stdout 取
 * `decision === 'block'` 的 `reason`，与插件 `check()` 的返回值要求**完全相等**
 * （含中文标点与空格）。
 *
 * 每个 fixture × 每个 guard 都要过一遍：一个 fixture 只对一条 guard 断言的话，
 * 就漏掉了「A guard 误拦了 B 领域的命令」这类最常见的移植事故。
 *
 * @module dsh-tool-guards/test/differential
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import * as deprecatedGuard from '../lib/guards/deprecated.js'
import * as gitSafetyGuard from '../lib/guards/gitSafety.js'
import * as npmGuard from '../lib/guards/npm.js'
import * as pythonCmdGuard from '../lib/guards/pythonCmd.js'
import * as truncationGuard from '../lib/guards/truncation.js'

/**
 * 原脚本的**本地副本**目录（真值来源）。
 *
 * 为什么不再指向 `$DSH_HOME/claude-hooks/helpers`：那棵树是给已失效的 hook 桥接用的，
 * 已整体退役。脚本 vendor 到插件内 `oracle/`，既是差异化测试的 oracle，
 * 也让"删掉旧目录"不至于把唯一的真值一起删掉。
 */
const HELPERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'oracle', 'helpers')

/** 被测 guard 与原脚本的对应关系。 */
const GUARDS = [
  { id: npmGuard.id, script: npmGuard.script, check: npmGuard.check },
  { id: pythonCmdGuard.id, script: pythonCmdGuard.script, check: pythonCmdGuard.check },
  { id: gitSafetyGuard.id, script: gitSafetyGuard.script, check: gitSafetyGuard.check },
  { id: truncationGuard.id, script: truncationGuard.script, check: truncationGuard.check },
  { id: deprecatedGuard.id, script: deprecatedGuard.script, check: deprecatedGuard.check },
]

/**
 * 跑一次原始脚本，取出它的拦截理由。
 *
 * 原脚本走 `reportBlock()`：exit 0 + 一行 JSON（`decision: 'block'`）表示拦截，
 * stdout 为空表示放行。退出码非 0 说明脚本自己崩了——那属于 oracle 失效，
 * 必须让测试失败而不是静默当成放行。
 *
 * @param script - 脚本文件名。
 * @param ccInput - CC 形状的 hook 输入。
 * @returns 拦截理由；放行时返回 undefined。
 */
function runOriginal(script, ccInput) {
  const result = spawnSync(process.execPath, [join(HELPERS_DIR, script)], {
    input: JSON.stringify(ccInput),
    encoding: 'utf8',
    timeout: 30000,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `原脚本 ${script} 退出码异常：${result.status}\nstderr:\n${result.stderr}`)

  const stdout = (result.stdout ?? '').trim()
  if (stdout === '') return undefined

  const decision = JSON.parse(stdout.split('\n')[0])
  if (decision.decision !== 'block') return undefined
  return decision.reason
}

/**
 * fixture：`tool` 是工具名，`args` 是工具参数。
 * `ccTool` 只在需要验证「CC 命名与 dsh 命名同样成立」时给出。
 */
const FIXTURES = [
  // ---- npm / npx：装包、脚本、查询类都必须拦 ----
  { name: 'npm install', tool: 'pwsh', args: { command: 'npm install lodash' } },
  { name: 'npm i', tool: 'pwsh', args: { command: 'npm i' } },
  { name: 'npm ci', tool: 'pwsh', args: { command: 'npm ci' } },
  { name: 'npm run build', tool: 'pwsh', args: { command: 'npm run build' } },
  { name: 'npm test', tool: 'pwsh', args: { command: 'npm test' } },
  { name: 'npm ls（查询类也拦）', tool: 'pwsh', args: { command: 'npm ls --depth=0' } },
  { name: 'npm view（查询类也拦）', tool: 'pwsh', args: { command: 'npm view react version' } },
  { name: 'npm root -g', tool: 'pwsh', args: { command: 'npm root -g' } },
  { name: 'npm uninstall', tool: 'pwsh', args: { command: 'npm uninstall lodash' } },
  { name: 'npx', tool: 'pwsh', args: { command: 'npx create-react-app my-app' } },
  { name: 'npm.cmd 形态', tool: 'pwsh', args: { command: 'npm.cmd install' } },
  { name: 'npm 大写', tool: 'pwsh', args: { command: 'NPM install lodash' } },
  { name: '; 之后的 npm', tool: 'pwsh', args: { command: 'git status; npm install' } },
  { name: 'powershell -Command 嵌套', tool: 'pwsh', args: { command: 'powershell -Command "npm run build"' } },
  { name: 'pnpm install 放行', tool: 'pwsh', args: { command: 'pnpm install' } },
  { name: 'pnpm dlx 放行', tool: 'pwsh', args: { command: 'pnpm dlx create-react-app my-app' } },
  { name: 'echo npm install 放行（非命令位）', tool: 'pwsh', args: { command: 'echo npm install' } },
  { name: 'git commit -m "npm install" 放行', tool: 'pwsh', args: { command: 'git commit -m "npm install"' } },
  { name: '裸 npm（无子命令）', tool: 'pwsh', args: { command: 'npm' } },
  { name: 'npm audit（未知子命令仍拦）', tool: 'pwsh', args: { command: 'npm audit' } },
  { name: 'Start-Process -FilePath npm', tool: 'pwsh', args: { command: 'Start-Process -FilePath npm -ArgumentList install' } },
  { name: 'cmd /c npm install 放行（原脚本不认这条路径）', tool: 'pwsh', args: { command: 'cmd /c npm install' } },

  // ---- python / python3 ----
  { name: 'win32 python3 拦截', tool: 'pwsh', args: { command: 'python3 -c "print(1)"' } },
  { name: 'win32 python3 无参数（原脚本不拦）', tool: 'pwsh', args: { command: 'python3' } },
  { name: 'win32 裸 python 放行', tool: 'pwsh', args: { command: 'python -c "print(1)"' } },
  { name: 'venv 里的 python3 放行', tool: 'pwsh', args: { command: 'C:\\proj\\.venv\\Scripts\\python3 x.py' } },
  { name: 'ssh 远程 python3 放行', tool: 'pwsh', args: { command: 'ssh host "python3 x.py"' } },
  { name: 'ssh 之后本地 python3 仍拦', tool: 'pwsh', args: { command: 'ssh host "cd /tmp" && python3 x.py' } },
  { name: 'docker exec 远程 python3 放行', tool: 'pwsh', args: { command: 'docker exec app python3 x.py' } },

  // ---- git 安全 / 系统破坏性命令 ----
  { name: 'git push --force', tool: 'pwsh', args: { command: 'git push --force origin main' } },
  { name: 'git push --force-with-lease 放行', tool: 'pwsh', args: { command: 'git push --force-with-lease origin main' } },
  { name: 'git push -f', tool: 'pwsh', args: { command: 'git push -f origin main' } },
  { name: 'git reset --hard', tool: 'pwsh', args: { command: 'git reset --hard HEAD~1' } },
  { name: 'git stash 放行', tool: 'pwsh', args: { command: 'git stash push -m wip' } },
  { name: 'git clean -fd', tool: 'pwsh', args: { command: 'git clean -fd' } },
  { name: 'git clean -n 放行', tool: 'pwsh', args: { command: 'git clean -n' } },
  { name: 'git branch -D', tool: 'pwsh', args: { command: 'git branch -D feature' } },
  { name: 'git branch -d 放行', tool: 'pwsh', args: { command: 'git branch -d feature' } },
  { name: 'rm -rf /', tool: 'pwsh', args: { command: 'rm -rf /' } },
  { name: 'chmod -R 777', tool: 'pwsh', args: { command: 'chmod -R 777 ./data' } },
  { name: 'mkfs', tool: 'pwsh', args: { command: 'mkfs.ext4 /dev/sdb1' } },
  { name: 'Format-Volume', tool: 'pwsh', args: { command: 'Format-Volume -DriveLetter D' } },
  { name: 'git commit 说明里的危险词放行', tool: 'pwsh', args: { command: 'git commit -m "never git reset --hard here"' } },

  // ---- deprecated 目录写入 ----
  { name: 'write 到 _deprecated', tool: 'write', args: { file_path: 'C:\\proj\\src\\_deprecated\\old.js', content: 'export const a = 1\n' } },
  { name: 'write 到 legacy', tool: 'write', args: { file_path: 'C:\\proj\\src\\legacy\\old.js', content: 'export const a = 1\n' } },
  { name: 'write 到普通目录放行', tool: 'write', args: { file_path: 'C:\\proj\\src\\main.js', content: 'export const a = 1\n' } },
  { name: 'write 到 .dsh 下 legacy 放行', tool: 'write', args: { file_path: 'C:\\Users\\DELL\\.dsh\\legacy\\x.js', content: 'export const a = 1\n' } },
  { name: 'edit 到 node_modules 下 legacy 放行', tool: 'edit', args: { file_path: 'C:\\proj\\node_modules\\pkg\\legacy\\a.js', old_string: 'a', new_string: 'b' } },

  // ---- 截断占位符 ----
  { name: 'write 含 // ... rest of code', tool: 'write', args: { file_path: 'C:\\proj\\a.js', content: 'function a() {\n  return 1\n}\n\n// ... rest of code unchanged\n' } },
  { name: 'write 含 # ... remaining', tool: 'write', args: { file_path: 'C:\\proj\\a.py', content: 'def a():\n    return 1\n\n# ... remaining functions omitted\n' } },
  { name: 'write 含中文省略', tool: 'write', args: { file_path: 'C:\\proj\\a.js', content: 'function a() { return 1 }\n\n// ... 其余代码保持不变\n' } },
  { name: 'write 含 // [rest omitted]', tool: 'write', args: { file_path: 'C:\\proj\\a.js', content: 'const a = 1\nconst b = 2\n// [rest of the implementation omitted]\n' } },
  { name: 'write 含 // rest unchanged', tool: 'write', args: { file_path: 'C:\\proj\\a.js', content: 'const a = 1\nconst b = 2\n// rest unchanged\nconst c = 3\n' } },
  { name: 'write 含 <!-- ... rest -->', tool: 'write', args: { file_path: 'C:\\proj\\a.html', content: '<div>a</div>\n<div>b</div>\n<!-- ... rest of the markup -->\n' } },
  { name: 'write 完整代码放行', tool: 'write', args: { file_path: 'C:\\proj\\a.js', content: 'export function add(a, b) {\n  return a + b\n}\n' } },
  { name: 'edit 的 new_string 含占位符', tool: 'edit', args: { file_path: 'C:\\proj\\a.js', old_string: 'const a = 1', new_string: 'const a = 1\n// ... rest of code\nconst b = 2' } },
  { name: 'edit 的 old_string 含占位符放行（只查 new_string）', tool: 'edit', args: { file_path: 'C:\\proj\\a.js', old_string: '// ... rest of code', new_string: 'export const add = (a, b) => a + b\n' } },
  { name: '短内容不检查（<20 字符）', tool: 'write', args: { file_path: 'C:\\proj\\a.js', content: '// ...rest' } },
  { name: '配置目录里的占位符放行', tool: 'write', args: { file_path: 'C:\\Users\\DELL\\.claude\\helpers\\t.js', content: 'const s = "// ... rest of code"\n' } },
  { name: '多行真实写入放行', tool: 'write', args: { file_path: 'C:\\proj\\a.js', content: 'const a = 1\nconst b = 2\nconst c = a + b\nconsole.log(c)\n' } },

  // ---- 非写入 / 非 shell 工具一律放行 ----
  { name: 'read 工具放行', tool: 'read', args: { file_path: 'C:\\proj\\_deprecated\\a.js' } },
  { name: 'shell 里的截断字符串放行（不是写文件）', tool: 'pwsh', args: { command: 'echo "// ... rest of code"' } },
  { name: 'todo 工具放行', tool: 'todo_write', args: { todos: [{ content: 'npm install', status: 'pending' }] } },

  // ---- 工具命名：CC 大小写与 Codex 形态同样成立 ----
  { name: 'CC 的 Bash 工具名', tool: 'Bash', args: { command: 'python3 x.py' } },
  { name: 'CC 的 Write 工具名', tool: 'Write', args: { file_path: 'C:\\proj\\src\\legacy\\a.js', content: 'const a = 1\n' } },
  { name: 'CC 的 Edit 工具名', tool: 'Edit', args: { file_path: 'C:\\proj\\a.js', old_string: 'a', new_string: 'const a = 1\n// ... rest of code\n' } },
  { name: 'Codex 的 exec_command 工具名', tool: 'exec_command', args: { command: 'npm install left-pad' } },
]

/**
 * 每条 fixture × 每条 guard 一个子测试：失败时能直接看出是哪个领域误判。
 */
for (const fixture of FIXTURES) {
  describe(fixture.name, () => {
    for (const guard of GUARDS) {
      test(guard.id, () => {
        const ccInput = {
          hook_event_name: 'PreToolUse',
          tool_name: fixture.tool,
          tool_input: fixture.args,
        }
        const expected = runOriginal(guard.script, ccInput)
        const actual = guard.check(fixture.tool, fixture.args)
        assert.equal(
          actual,
          expected,
          `${guard.id} 与 ${guard.script} 结论不一致\n` +
            `tool=${fixture.tool}\nargs=${JSON.stringify(fixture.args)}\n` +
            `原脚本: ${expected === undefined ? '放行' : JSON.stringify(expected)}\n` +
            `插件:   ${actual === undefined ? '放行' : JSON.stringify(actual)}`,
        )
      })
    }
  })
}

test('fixture 覆盖度：至少 25 条，且五个 guard 都曾被拦下过', () => {
  assert.ok(FIXTURES.length >= 25, `fixture 只有 ${FIXTURES.length} 条`)
  for (const guard of GUARDS) {
    const blocked = FIXTURES.filter((fixture) => guard.check(fixture.tool, fixture.args) !== undefined)
    assert.ok(blocked.length > 0, `guard ${guard.id} 没有任何一条 fixture 命中，覆盖不足`)
  }
})
