#!/usr/bin/env node
/**
 * npm Guard Hook (PreToolUse)
 * 全局拦截 npm 命令，统一要求使用 pnpm。
 * exit 2 = 拦下会引入 npm 依赖链路风险的命令，并通过 stderr 解释原因
 */

import { getCommand, getToolName, isShellInvocation, readHookInput, reportBlock } from './hook-input.mjs';

const input = await readHookInput();

if (!isShellInvocation(input)) process.exit(0);

const cmd = getCommand(input);
if (!cmd) process.exit(0);

const blocked = findBlockedInvocation(cmd);
if (!blocked) process.exit(0);

const tool = blocked.groups?.tool?.toLowerCase() || 'npm';
const subcommand = extractSubcommand(blocked.groups?.subcommand || '');

function extractSubcommand(raw) {
  const cleaned = raw.trim();
  if (!cleaned) return '';
  const argListMatch = cleaned.match(/^["']?([\w:-]+)["']?/);
  return argListMatch?.[1] || '';
}

function stripQuotedStrings(value) {
  return value.replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, '""');
}

function unquote(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractPowerShellCommand(value) {
  const match = value.match(/(?:^|\s)-(?:Command|EncodedCommand|c)\s+(?<script>"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^\r\n]+)/i);
  if (!match?.groups?.script) return '';
  if (/(?:^|\s)-EncodedCommand\s+/i.test(match[0])) return '';
  return unquote(match.groups.script);
}

function findDirectInvocation(value) {
  const commandWithoutQuotedStrings = stripQuotedStrings(value);
  return commandWithoutQuotedStrings.match(/(?:^|[;&|]\s*|&&\s*|\|\|\s*)\b(?<tool>npx|npm)(?:\.cmd|\.ps1)?(?:\s+(?<subcommand>[\w:-]+))?/i);
}

function findBlockedInvocation(value) {
  const direct = findDirectInvocation(value);
  if (direct) return direct;

  const powerShellScript = extractPowerShellCommand(value);
  if (powerShellScript) {
    const nested = findDirectInvocation(powerShellScript);
    if (nested) return nested;
  }

  return (
    value.match(/(?:^|\s)-FilePath\s+["']?(?<tool>npx|npm)(?:\.cmd|\.ps1)?["']?(?:\s+-ArgumentList\s+(?<subcommand>[\s\S]*))?/i) ||
    value.match(/(?:^|\s)-ArgumentList\s+[\s\S]*?["'](?:\/c\s+)?(?<tool>npx|npm)(?:\.cmd|\.ps1)?(?:\s+(?<subcommand>[\w:-]+))?/i)
  );
}

function pnpmEquivalent(toolName, verb) {
  if (toolName === 'npx') return 'pnpm dlx <package-or-command>';
  if (!verb) return 'pnpm --help';
  if (verb === 'i' || verb === 'ci') return 'pnpm install';
  if (verb === 'install') return 'pnpm install';
  if (verb === 'exec') return 'pnpm exec';
  if (verb === 'uninstall' || verb === 'remove' || verb === 'rm') return 'pnpm remove';
  if (verb === 'list' || verb === 'ls') return 'pnpm list';
  if (verb === 'root') return 'pnpm root';
  if (verb === 'run' || verb === 'start' || verb === 'test' || verb === 'build') return `pnpm ${verb}`;
  return `pnpm ${verb}`;
}

const pnpmEquiv = pnpmEquivalent(tool, subcommand);

const message =
  `🚫 [npm Guard] 已拦下 ${tool} 命令，请改用 pnpm\n` +
  `   命令: ${cmd.substring(0, 150)}\n` +
  `   为什么：npm 历史上多次出现供应链与安装链路安全问题；统一禁用 npm 可以减少被恶意包、生命周期脚本、锁文件漂移和错误 registry 配置影响的风险。\n` +
  `   为什么连查询类 npm 命令也拦：agent 很容易从 npm root/list/view 过渡到 npm install/run，统一拦在入口能减少习惯性回退到 npm 的概率。\n` +
  `   为什么不用混用：npm 会生成 package-lock.json，和 pnpm-lock.yaml 的依赖解析模型不同，容易让本地、CI、部署环境安装出不一致的依赖树。\n` +
  `   为什么用 pnpm：pnpm 的内容寻址存储和严格依赖隔离更利于复现，也能减少幽灵依赖造成的安全与调试成本。\n` +
  `   更稳做法: ${pnpmEquiv}`;

function isCodexShellTool(inputData) {
  const toolName = getToolName(inputData);
  const eventName = String(inputData.hook_event_name || inputData.hookEventName || inputData.eventName || '').trim();
  return (
    /^(functions[.]shell_command|shell_command|exec_command|unified_exec|command\/exec)$/i.test(toolName) ||
    /^PermissionRequest$/i.test(eventName)
  );
}

if (isCodexShellTool(input)) {
  const hookEventName = String(input.hook_event_name || input.hookEventName || input.eventName || 'PreToolUse').trim();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: 'deny',
      permissionDecisionReason: message,
    },
    systemMessage: message,
    decision: 'block',
    reason: message,
  }));
  process.stdout.write('\n');
  process.exit(0);
}

// 迁移适配：改走 reportBlock()，同时给出 stderr 与 stdout JSON 两条通道
// （DSH 桥接把 exit 2 折成 1，只靠退出码会被降级成非阻塞错误）。
reportBlock(input, message);
