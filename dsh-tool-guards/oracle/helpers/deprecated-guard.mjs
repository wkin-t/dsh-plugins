#!/usr/bin/env node
/**
 * Deprecated Guard Hook (PreToolUse)
 * 拦下对 _deprecated/ 目录的写入操作，避免修到历史实现
 * exit 2 = 拦下写入，并通过 stderr 解释原因
 */

import { getFilePath, isWriteTool, readHookInput, reportBlock } from './hook-input.mjs';

const input = await readHookInput();

const DEPRECATED_PATTERN = /[/\\]_deprecated[/\\]|[/\\]deprecated[/\\]|[/\\]legacy[/\\]/i;
const EXCLUDED_PATHS = /[/\\]\.(claude|dsh|codex|github)[/\\]|[/\\]node_modules[/\\]/i;

// 迁移适配：原实现按 'Write'/'Edit' 精确比较，DeepSeek Harness 传的是小写
// `write`/`edit`，会导致本 hook 静默失效；改用共用的 isWriteTool()。
if (isWriteTool(input)) {
  const filePath = getFilePath(input);
  if (DEPRECATED_PATTERN.test(filePath) && !EXCLUDED_PATHS.test(filePath)) {
    // 迁移适配：改走 reportBlock()（DSH 桥接把 exit 2 折成 1，只靠退出码会失效）。
    reportBlock(input,
      `🚫 [Deprecated Guard] 已拦下对废弃目录的写入\n` +
      `   文件: ${filePath}\n` +
      `   为什么：_deprecated/、legacy/ 通常只保留历史实现；继续改这里容易修到不再运行的代码。\n` +
      `   更稳做法：先找到当前生效的实现位置，再在那里修改。\n` +
      `   如果不确定现役路径，先说明查到的候选位置再确认。`
    );
  }
}


