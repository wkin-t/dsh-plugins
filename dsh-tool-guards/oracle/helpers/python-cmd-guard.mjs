#!/usr/bin/env node
/**
 * Python Command Guard Hook (PreToolUse)
 * Windows (win32) 下拦截 python3 命令，提示使用 python
 * macOS/Linux 下拦截 python 命令（无版本号），提示使用 python3
 * exit 2 = 拦下容易跑错解释器的命令，并通过 stderr 解释原因
 *
 * 策略：先剥离远程上下文（ssh/docker exec 的引号参数），再检查剩余本地部分
 */

import { getCommand, isShellInvocation, readHookInput, reportBlock } from './hook-input.mjs';

const input = await readHookInput();

if (!isShellInvocation(input)) process.exit(0);

const cmd = getCommand(input);
if (!cmd) process.exit(0);
const isWindows = process.platform === 'win32';

// 剥离远程命令内容，使 python3 在远程上下文内不被检查
// 支持转义引号：ssh host "...\"...\"..." 和单引号 ssh host '...'
const REMOTE_PREFIX = /\b(ssh|docker\s+exec|kubectl\s+exec|wsl)\b/gi;
let localCmd = cmd;
// 策略：找到 ssh/docker exec 等关键词，从它开始到命令段结尾整体替换为 REMOTE
// 命令段边界：未被引号包裹的 && 或 ||（行尾也算）
// 简化实现：直接从 ssh 位置到字符串末尾或下一个顶层 && 做替换
function stripRemoteCommands(input) {
  let result = '';
  let i = 0;
  while (i < input.length) {
    // 检查是否是远程命令的开始
    const remaining = input.substring(i);
    const remoteMatch = remaining.match(/^(ssh|docker\s+exec|kubectl\s+exec|wsl)\s/i);
    if (remoteMatch) {
      // 跳过整个远程命令段（尊重引号嵌套）
      let j = i + remoteMatch[0].length;
      let inDouble = false, inSingle = false, escaped = false;
      while (j < input.length) {
        const ch = input[j];
        if (escaped) { escaped = false; j++; continue; }
        if (ch === '\\') { escaped = true; j++; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; j++; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; j++; continue; }
        // 顶层 && 或 || 是命令段边界
        if (!inDouble && !inSingle) {
          if ((ch === '&' && input[j+1] === '&') || (ch === '|' && input[j+1] === '|')) break;
          if (ch === ';') break;
        }
        j++;
      }
      result += 'REMOTE';
      i = j;
    } else {
      result += input[i];
      i++;
    }
  }
  return result;
}
localCmd = stripRemoteCommands(cmd);

if (isWindows) {
  // Windows: 在剥离远程内容后的本地命令中检查 python3
  if (/(?:^|[;&|]\s*|&&\s*|\|\|\s*)python3\s/m.test(localCmd) && !/[/\\]\.?venv[/\\]/i.test(localCmd)) {
    // 迁移适配：改走 reportBlock()（DSH 桥接把 exit 2 折成 1，只靠退出码会失效）。
    reportBlock(input,
      `🚫 [Python Cmd Guard] 已拦下 Windows 本地 python3 命令\n` +
      `   命令: ${cmd.substring(0, 150)}\n` +
      `   为什么：这台 Windows 环境通常只有 python 启动器；python3 容易找不到命令，或者误打到 WSL/远程语义。\n` +
      `   更稳做法：本地命令用 python；远程/WSL 命令已在检测前剥离，不会误拦。`
    );
  }
} else {
  if (/(?:^|[;&|]\s*|&&\s*|\|\|\s*)python\s(?!3)/m.test(localCmd) && !/[/\\]\.?venv[/\\]/i.test(localCmd)) {
    reportBlock(input,
      `🚫 [Python Cmd Guard] 已拦下 macOS/Linux 上的裸 python 命令\n` +
      `   命令: ${cmd.substring(0, 150)}\n` +
      `   为什么：python 在 Unix 环境可能指向 Python 2、缺失，或和项目 venv 预期不一致。\n` +
      `   更稳做法：用 python3；如果已在 venv 中可按 venv 约定执行。`
    );
  }
}

