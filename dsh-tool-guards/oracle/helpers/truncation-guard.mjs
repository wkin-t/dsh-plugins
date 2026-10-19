#!/usr/bin/env node
/**
 * Truncation Guard Hook (PreToolUse)
 * 拦下 Edit/Write 中包含代码截断占位符的写入操作，避免写丢真实逻辑
 * exit 2 = 拦下不完整写入，并通过 stderr 解释原因
 */

import { getFilePath, getTextToCheck, isWriteTool, readHookInput, reportBlock } from './hook-input.mjs';

const input = await readHookInput();
const content = getTextToCheck(input);

// 迁移适配：isWriteTool() 同时认 Claude Code 的 Write/Edit 与 DeepSeek Harness 的 write/edit。
if (!isWriteTool(input) && !content) {
  process.exit(0);
}

// 排除 agent 配置目录（hook/skill/helper 文件本身可能含截断字符串作为测试数据）
const filePath = getFilePath(input);
if (/[/\\]\.(claude|dsh|codex|github)[/\\]/i.test(filePath)) process.exit(0);

// 只检查超过一定长度的内容（短内容不太可能是截断）
if (content.length < 20) process.exit(0);

// 截断标记模式：注释风格 (//, #, /*, --, <!--) + 省略号 + 语义词
const TRUNCATION_PATTERNS = [
  // 注释 + 省略号 + 省略语义词（rest/remaining/unchanged 等）
  /(?:\/\/|#|\/\*|--|<!--)\s*\.{2,}\s*(?:rest|remaining|unchanged|existing|same|previous|keep|omit|snip|truncat)/i,
  // 注释 + (rest unchanged) 括号形式
  /(?:\/\/|#|\/\*|--|<!--)\s*\(?\s*(?:rest|remaining|code)\s+(?:unchanged|omitted|remains|stays|same|here)\s*\)?/i,
  // 注释 + 省略号 + 中文省略语
  /(?:\/\/|#|\/\*|--|<!--)\s*\.{2,}\s*(?:其余|剩余|省略|保持不变|其他代码)/,
  // 注释 + 方括号 + 省略语义
  /(?:\/\/|#|\/\*|--|<!--)\s*\[.*(?:rest|remaining|implementation|omitted).*\]/i,
];

for (const pattern of TRUNCATION_PATTERNS) {
  const match = content.match(pattern);
  if (match) {
    const lines = content.split('\n');
    const matchLine = lines.find(l => pattern.test(l)) || match[0];
    // 迁移适配：改走 reportBlock()（DSH 桥接把 exit 2 折成 1，只靠退出码会失效）。
    reportBlock(input,
      `🚫 [Truncation Guard] 已拦下疑似不完整代码写入\n` +
      `   匹配内容: ${matchLine.trim().substring(0, 100)}\n` +
      `   为什么：占位符会把真实逻辑写丢，用户复制或后续运行时才暴露问题，定位成本很高。\n` +
      `   更稳做法：写入完整代码；文件很长时分多次小范围编辑。`
    );
  }
}


