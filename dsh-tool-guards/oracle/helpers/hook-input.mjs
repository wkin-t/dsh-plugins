export async function readHookInput() {
  const raw = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });

  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return asObject(parsed);
    } catch {
      return {};
    }
  }
  return {};
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

function commandArrayToString(value) {
  if (!Array.isArray(value) || value.length === 0) return '';
  const parts = value
    .map((item) => firstString(item))
    .filter(Boolean);
  return parts.join(' ');
}

function firstParsedCommand(...values) {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const cmd = firstString(asObject(item).cmd, asObject(item).command);
      if (cmd) return cmd;
    }
  }
  return '';
}

export function getToolName(input = {}) {
  return firstString(
    input.tool_name,
    input.toolName,
    input.tool,
    input.name,
    input.hook_tool_name,
    input.hookToolName,
  );
}

export function getToolInput(input = {}) {
  return asObject(
    input.tool_input ??
    input.toolInput ??
    input.input ??
    input.arguments ??
    input.params ??
    input.action,
  );
}

export function getToolResult(input = {}) {
  return asObject(
    input.tool_result ??
    input.toolResult ??
    input.result ??
    input.output,
  );
}

export function getCommand(input = {}) {
  const toolInput = getToolInput(input);
  const action = asObject(toolInput.action ?? input.action);
  const argv = Array.isArray(toolInput.argv) ? toolInput.argv : [];
  const argvCommand = argv.length > 0
    ? [toolInput.program, ...argv].filter(Boolean).join(' ')
    : '';
  const commandVector = commandArrayToString(toolInput.command) || commandArrayToString(input.command);
  const parsedCommand = firstParsedCommand(
    toolInput.parsedCmd,
    toolInput.parsed_cmd,
    toolInput.commandActions,
    toolInput.command_actions,
    input.parsedCmd,
    input.parsed_cmd,
    input.commandActions,
    input.command_actions,
  );

  return firstString(
    toolInput.command,
    toolInput.cmd,
    toolInput.shellCommand,
    toolInput.script,
    input.command,
    input.cmd,
    action.command,
    action.cmd,
    commandVector,
    parsedCommand,
    argvCommand,
  );
}

export function getStdout(input = {}) {
  const result = getToolResult(input);
  return firstString(
    result.stdout,
    result.output,
    result.text,
    input.stdout,
  );
}

function pushPath(paths, value) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/dev/null') return;
  paths.push(trimmed);
}

function collectFromPatch(paths, patch) {
  if (typeof patch !== 'string' || !patch.includes('\n')) return;
  const patterns = [
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
    /^\*\*\* Move to: (.+)$/gm,
    /^--- (?:a\/)?(.+)$/gm,
    /^\+\+\+ (?:b\/)?(.+)$/gm,
  ];

  for (const pattern of patterns) {
    for (const match of patch.matchAll(pattern)) {
      pushPath(paths, match[1]);
    }
  }
}

export function getCandidatePaths(input = {}) {
  const toolInput = getToolInput(input);
  const paths = [];
  const scalarKeys = [
    'file_path',
    'filePath',
    'relative_path',
    'relativePath',
    'path',
    'filename',
    'target_file',
    'targetFile',
  ];
  const arrayKeys = ['file_paths', 'filePaths', 'files', 'paths'];

  for (const key of scalarKeys) pushPath(paths, toolInput[key]);
  for (const key of scalarKeys) pushPath(paths, input[key]);

  for (const key of arrayKeys) {
    const value = toolInput[key] ?? input[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') pushPath(paths, item);
        else if (item && typeof item === 'object') {
          for (const scalarKey of scalarKeys) pushPath(paths, item[scalarKey]);
        }
      }
    }
  }

  collectFromPatch(paths, toolInput.patch ?? input.patch ?? toolInput.diff ?? input.diff ?? '');
  return [...new Set(paths)];
}

export function getFilePath(input = {}) {
  return getCandidatePaths(input)[0] ?? '';
}

export function getTextToCheck(input = {}) {
  const toolInput = getToolInput(input);
  return firstString(
    toolInput.new_string,
    toolInput.content,
    toolInput.text,
    toolInput.patch,
    toolInput.diff,
    input.content,
    input.patch,
    input.diff,
  );
}

export function isShellInvocation(input = {}) {
  const toolName = getToolName(input);
  // 迁移适配：DeepSeek Harness 的 shell 工具名是 `pwsh` / `bash`（全小写），
  // 不在 Claude Code 的白名单里；显式补入，避免只靠 getCommand() 兜底。
  if (/^(Bash|PowerShell|Shell|exec|exec_command|shell_command|unified_exec|command\/exec|pwsh|bash|cmd)$/i.test(toolName)) {
    return true;
  }
  return Boolean(getCommand(input));
}

/**
 * 迁移适配：判断是否为「写文件」类工具调用。
 * DeepSeek Harness 用全小写的 `write` / `edit`，Claude Code 用 `Write` / `Edit`；
 * 原 guard 按精确大小写比较，直接搬过来会静默失效，故统一小写归一。
 */
export function isWriteTool(input = {}) {
  const toolName = String(getToolName(input)).toLowerCase();
  return [
    'write',
    'edit',
    'multiedit',
    'multi_edit',
    'apply_patch',
    'apply_patch_streaming_events',
  ].includes(toolName);
}

/**
 * 统一的「拦截」出口。
 *
 * 为什么不能只靠 exit 2：DeepSeek Harness 的 hooks 桥接确实只在 exitCode === 2
 * 时判定阻塞，但它经 shell 包装层执行命令时会把 2 折成 1（实测
 * `node -e "process.exit(2)"` 观测到 exit 1），于是「拦下了」被降级成
 * 「非阻塞错误」，工具照常执行——会话日志里表现为 decision=pass、exitCode=1，
 * 而 stderr 里其实已经有正确的拦截文案。
 *
 * 桥接在 exitCode === 0 时会解析 stdout 上以 `{` 开头的 JSON，并读取
 * hookSpecificOutput.permissionDecision 与顶层 decision，因此这里同时给出两条通道：
 *   1) stderr 写中文原因（人类可读，也保留 Claude Code 的 exit-2 语义）；
 *   2) stdout 写结构化 block JSON 并 exit 0（DSH 与 Claude Code 都认）。
 * 顶层 decision 与 hookSpecificOutput 双保险：即使 hookEventName 对不上被丢弃，
 * `decision: "block"` 仍然生效。
 *
 * @param {object} input  - readHookInput() 的返回值，用于取 hook_event_name
 * @param {string} message - 已排版好的中文拦截说明
 * @returns {never}
 */
export function reportBlock(input, message) {
  const text = String(message ?? '').trim();
  process.stderr.write(`\n${text}\n\n`);

  const eventName = String(
    input?.hook_event_name ?? input?.hookEventName ?? '',
  ).trim();

  const out = { decision: 'block', reason: text };
  if (eventName) {
    out.hookSpecificOutput = {
      hookEventName: eventName,
      permissionDecision: 'deny',
      permissionDecisionReason: text,
    };
  }

  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}
