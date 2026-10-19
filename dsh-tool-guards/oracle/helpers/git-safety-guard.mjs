#!/usr/bin/env node
/**
 * Git Safety Guard Hook (PreToolUse)
 * 拦截危险的 git 操作和系统破坏性命令
 * exit 2 = 拦下高风险操作，并通过 stderr 解释原因
 */

import { getCommand, isShellInvocation, readHookInput, reportBlock } from './hook-input.mjs';

const input = await readHookInput();

if (!isShellInvocation(input)) process.exit(0);

const cmd = getCommand(input);
if (!cmd) process.exit(0);

// 危险模式列表：[正则, 人类可读描述, 建议替代]
// 前缀 (?:^|[;&|]\s*|&&\s*|\|\|\s*) 锚定到命令边界，防止误判字符串字面量中的同名词
const CMD = '(?:^|[;&|]\\s*|&&\\s*|\\|\\|\\s*)';
const DANGEROUS_PATTERNS = [
  [new RegExp(`${CMD}git\\s+push\\s+.*--force(?!-with-lease)`, 'im'), 'git push --force', '使用 --force-with-lease 更安全'],
  [new RegExp(`${CMD}git\\s+push\\s+-f\\b`, 'im'), 'git push -f', '使用 --force-with-lease 更安全'],
  [new RegExp(`${CMD}git\\s+reset\\s+--hard`, 'im'), 'git reset --hard', '考虑 git stash 或 git reset --soft'],
  [new RegExp(`${CMD}git\\s+clean\\s+-[a-z]*f`, 'im'), 'git clean -f', '先用 git clean -n 预览'],
  [new RegExp(`${CMD}rm\\s+-rf\\s+[/\\\\]`, 'im'), 'rm -rf /', '请指定具体路径'],
  [new RegExp(`${CMD}Remove-Item\\s+.*-Recurse.*-Force\\s+C:\\\\`, 'im'), 'Remove-Item -Recurse -Force C:\\', '请指定具体路径'],
  [new RegExp(`${CMD}Format-Volume`, 'im'), 'Format-Volume', '磁盘格式化不可逆'],
  [new RegExp(`${CMD}mkfs`, 'im'), 'mkfs', '磁盘格式化不可逆'],
  [new RegExp(`${CMD}chmod\\s+-R\\s+777`, 'im'), 'chmod -R 777', '权限过于宽松，使用更精确的权限'],
  [new RegExp(`${CMD}icacls\\s+.*\\/grant\\s+Everyone:F`, 'im'), 'icacls Everyone:F', '权限过于宽松'],
  [new RegExp(`${CMD}git\\s+branch\\s+-D\\b`, 'm'), 'git branch -D', '使用 -d（小写）更安全，已合并才删'],
];

for (const [pattern, name, suggestion] of DANGEROUS_PATTERNS) {
  if (pattern.test(cmd)) {
    // 迁移适配：改走 reportBlock()（DSH 桥接把 exit 2 折成 1，只靠退出码会失效）。
    reportBlock(input,
      `🚫 [Git Safety Guard] 已拦下高风险命令：${name}\n` +
      `   完整命令: ${cmd.substring(0, 200)}\n` +
      `   为什么：这类操作可能删除本地工作、改写远端历史或扩大系统权限，失败后很难完整恢复。\n` +
      `   更稳做法: ${suggestion}\n` +
      `   如果用户确实要执行，需要说明具体目标、影响范围和回退方案，再请求授权。`
    );
  }
}

// SSH 远程写代码检测（软提醒，不阻断）
// 匹配 ssh [user@]host "写操作命令"
const SSH_WRITE_PATTERN = /\bssh\s+\S+.*(?:cat\s*>|tee\s|echo\s.*>|sed\s+-i|vim\s|nano\s|>\s*\S+\.(py|ts|tsx|js|java|cpp|go|rs|sh))/i;
if (SSH_WRITE_PATTERN.test(cmd)) {
  process.stderr.write(
    `\n⚠️ [Git Safety Guard] 检测到 SSH 远程写代码操作\n` +
    `   命令: ${cmd.substring(0, 200)}\n` +
    `   → 为什么提醒：远程直接写代码会绕开本地测试、diff 和 git 审计，建议本地编辑验证后通过部署流程推送\n` +
    `   → 如果这是运维操作（非代码修改），可忽略此提醒\n\n`
  );
}


