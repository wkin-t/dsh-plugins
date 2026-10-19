#!/usr/bin/env node
/**
 * PostToolUse hook: Edit/Write/Serena 编辑后检查 TypeScript/TSX 语法
 * 使用 TypeScript compiler API 做纯语法解析（不做类型检查，~100ms）
 * - 语法正确: exit 0
 * - 语法错误: 反馈给宿主 agent 让其立即修复
 *
 * 回传通道按宿主能力分支（见 reportSyntaxError）：
 * - Claude Code / 其他：exit 2 + stderr
 * - Codex：stdout JSON {systemMessage}（仅展示给用户）
 * - WorkBuddy：stdout JSON {hookSpecificOutput.additionalContext} + exit 0
 *   （桌面端未实现 PostToolUse 的 exit 2 + stderr 回传，2026-09-30 实测）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';
import { homedir } from 'os';
import { getCandidatePaths, readHookInput } from '../helpers/hook-input.mjs';

// 迁移适配：日志落点从 ~/.claude/logs 改到 ~/.dsh/logs，避免 DSH 侧写回 Claude Code 目录。
const LOG_FILE = resolve(homedir(), '.dsh', 'logs', 'syntax-hooks.log');
const IS_CODEX_CLIENT = process.argv.includes('--client=codex');
// 宿主名，由 readHookInput() 之后赋值（payload 的 client 字段）
let CLIENT_NAME = '';
// 事件名，由 readHookInput() 之后赋值（payload 的 hook_event_name）
let HOOK_EVENT_NAME = '';

function logMaintenanceError(error) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] [check-ts-syntax] ${error?.name || 'Error'}: ${error?.message || error}\n`,
      'utf8',
    );
  } catch {}
}

function reportSyntaxError(message) {
  if (IS_CODEX_CLIENT) {
    process.stdout.write(JSON.stringify({ systemMessage: message }));
    process.exit(0);
  }

  if (String(CLIENT_NAME).trim().toLowerCase() === 'workbuddy') {
    // WorkBuddy 只认 JSON 通道；exit 0 表示 hook 成功，消息由 additionalContext 注入
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: message.trim(),
      },
    }));
    process.exit(0);
  }

  // 迁移适配：DeepSeek Harness 的 hooks 桥接只在 exitCode === 2 时判定阻塞，但它经
  // shell 包装层执行命令时会把 2 折成 1（实测 `node -e "process.exit(2)"` → exit 1），
  // 拦截因此被降级成非阻塞错误。桥接在 exitCode === 0 时会解析 stdout 上以 `{` 开头的
  // JSON，故这里同时给出 stderr（人类可读）与结构化 block JSON，并 exit 0。
  const text = String(message).trim();
  process.stderr.write(message);
  const payload = { decision: 'block', reason: text };
  if (HOOK_EVENT_NAME) {
    payload.hookSpecificOutput = {
      hookEventName: HOOK_EVENT_NAME,
      permissionDecision: 'deny',
      permissionDecisionReason: text,
    };
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

// 从文件位置向上查找 node_modules/typescript
function findTS(startDir) {
  let dir = startDir;
  for (let i = 0; i < 15; i++) {
    const p = resolve(dir, 'node_modules', 'typescript');
    if (existsSync(resolve(p, 'lib', 'typescript.js'))) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function checkFile(filePath) {
  if (!filePath || !/\.(ts|tsx)$/i.test(filePath)) return;

  // 相对路径转绝对路径
  if (!filePath.match(/^[A-Z]:/i) && !filePath.startsWith('/')) {
    filePath = resolve(process.cwd(), filePath);
  }
  if (!existsSync(filePath)) return;

  const tsDir = findTS(dirname(filePath)) || findTS(process.cwd());
  if (!tsDir) return; // 没找到 TypeScript，跳过

  try {
    // 用 createRequire 加载（比 dynamic import 更可靠）
    const require = createRequire(resolve(tsDir, 'lib', 'typescript.js'));
    const ts = require(resolve(tsDir, 'lib', 'typescript.js'));

    const source = readFileSync(filePath, 'utf-8');
    const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
    const diagnostics = sourceFile.parseDiagnostics || [];

    if (diagnostics.length > 0) {
      const errors = diagnostics.slice(0, 5).map(d => {
        const pos = sourceFile.getLineAndCharacterOfPosition(d.start || 0);
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        return `  行 ${pos.line + 1}: ${msg}`;
      }).join('\n');

      const extra = diagnostics.length > 5 ? `\n  ... 还有 ${diagnostics.length - 5} 个错误` : '';
      reportSyntaxError(
        `\nTypeScript 语法错误 in ${filePath}:\n${errors}${extra}\n` +
        `为什么必须先修：TS 编译器遇到语法错误会放弃解析整个文件，` +
        `导致同文件的类型推断全部失效、下游 import 链断裂，` +
        `其他文件因此报出的错误可能是假阳性——继续改别处只会累积假信号。` +
        `修完再往下走。\n\n`
      );
    }
  } catch {
    // 加载或解析失败，静默跳过
  }
}

try {
  const input = await readHookInput();
  CLIENT_NAME = String(input?.client || '');
  HOOK_EVENT_NAME = String(input?.hook_event_name || '');
  const candidatePaths = getCandidatePaths(input);

  for (const filePath of candidatePaths) {
    checkFile(filePath);
  }
} catch (error) {
  logMaintenanceError(error);
  process.exit(0);
}

process.exit(0);
