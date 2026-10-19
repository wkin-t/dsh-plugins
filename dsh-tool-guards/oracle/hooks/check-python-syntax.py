"""
PostToolUse hook: Edit/Write/Serena 编辑后自动检查 Python 文件语法
- 语法正确: 静默通过 (exit 0)
- 语法错误: 反馈给宿主 agent 让其立即修复

回传通道按宿主能力分支（见 report_syntax_error）：
- Claude Code / 其他：exit 2 + stderr
- Codex：stdout JSON {systemMessage}（仅展示给用户）
- WorkBuddy：stdout JSON {hookSpecificOutput.additionalContext} + exit 0
  （桌面端未实现 PostToolUse 的 exit 2 + stderr 回传，2026-09-30 实测）
"""
import sys
import json
import ast
import os
import re
from datetime import datetime

# 迁移适配：日志落点从 ~/.claude/logs 改到 ~/.dsh/logs，避免 DSH 侧写回 Claude Code 目录。
LOG_FILE = os.path.join(os.path.expanduser('~'), '.dsh', 'logs', 'syntax-hooks.log')
IS_CODEX_CLIENT = '--client=codex' in sys.argv
# 宿主名，由 read_input() 之后的赋值填入（payload 的 client 字段）
CLIENT_NAME = ''
# 事件名，由 read_input() 之后的赋值填入（payload 的 hook_event_name）
HOOK_EVENT_NAME = ''


def log_maintenance_error(message):
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(f"[{datetime.now().isoformat()}] [check-python-syntax] {message}\n")
    except OSError:
        pass


def report_syntax_error(message):
    if IS_CODEX_CLIENT:
        print(json.dumps({'systemMessage': message}, ensure_ascii=False))
        sys.exit(0)

    if CLIENT_NAME.strip().lower() == 'workbuddy':
        # WorkBuddy 只认 JSON 通道；exit 0 表示 hook 成功，消息由 additionalContext 注入
        print(json.dumps({
            'hookSpecificOutput': {
                'hookEventName': 'PostToolUse',
                'additionalContext': message.strip(),
            }
        }, ensure_ascii=False))
        sys.exit(0)

    # 迁移适配：DeepSeek Harness 的 hooks 桥接只在 exitCode == 2 时判定阻塞，但它经
    # shell 包装层执行命令时会把 2 折成 1（实测 node -e "process.exit(2)" → exit 1），
    # 拦截因此被降级成非阻塞错误。桥接在 exitCode == 0 时会解析 stdout 上以 { 开头的
    # JSON，故这里同时给出 stderr（人类可读）与结构化 block JSON，并 exit 0。
    text = message.strip()
    print(text, file=sys.stderr)
    payload = {'decision': 'block', 'reason': text}
    if HOOK_EVENT_NAME:
        payload['hookSpecificOutput'] = {
            'hookEventName': HOOK_EVENT_NAME,
            'permissionDecision': 'deny',
            'permissionDecisionReason': text,
        }
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0)

def as_dict(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def read_input():
    try:
        return json.load(sys.stdin)
    except json.JSONDecodeError:
        return {}


def add_path(paths, value):
    if isinstance(value, str):
        value = value.strip()
        if value and value != '/dev/null' and value not in paths:
            paths.append(value)


def collect_patch_paths(paths, patch):
    if not isinstance(patch, str) or '\n' not in patch:
        return
    patterns = [
        r'^\*\*\* (?:Add|Update|Delete) File: (.+)$',
        r'^\*\*\* Move to: (.+)$',
        r'^--- (?:a/)?(.+)$',
        r'^\+\+\+ (?:b/)?(.+)$',
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, patch, re.MULTILINE):
            add_path(paths, match.group(1))


def candidate_paths(data):
    tool_input = as_dict(
        data.get('tool_input')
        or data.get('toolInput')
        or data.get('input')
        or data.get('arguments')
        or data.get('params')
    )
    paths = []
    keys = [
        'file_path', 'filePath', 'relative_path', 'relativePath',
        'path', 'filename', 'target_file', 'targetFile',
    ]
    for key in keys:
        add_path(paths, tool_input.get(key))
        add_path(paths, data.get(key))
    for key in ('file_paths', 'filePaths', 'files', 'paths'):
        value = tool_input.get(key) or data.get(key)
        if isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    for path_key in keys:
                        add_path(paths, item.get(path_key))
                else:
                    add_path(paths, item)
    collect_patch_paths(paths, tool_input.get('patch') or data.get('patch') or '')
    collect_patch_paths(paths, tool_input.get('diff') or data.get('diff') or '')
    return paths


def check_python_file(file_path):
    # 相对路径转绝对路径（Serena 返回相对路径）
    if file_path and not os.path.isabs(file_path):
        file_path = os.path.join(os.getcwd(), file_path)

    if not (file_path.endswith('.py') and os.path.isfile(file_path)):
        return

    # 尝试多种编码读取
    content = None
    for enc in ('utf-8', 'gbk', 'gb2312', 'latin-1'):
        try:
            with open(file_path, encoding=enc) as f:
                content = f.read()
            break
        except (UnicodeDecodeError, LookupError):
            continue
        except (FileNotFoundError, PermissionError):
            sys.exit(0)

    if content is not None:
        try:
            ast.parse(content)
        except SyntaxError as e:
            report_syntax_error(
                f"Python 语法错误 in {file_path}: {e.msg} (行 {e.lineno})\n"
                f"为什么必须先修：Python 解释器碰到语法错误直接中止 import，"
                f"模块里其余所有逻辑对运行时完全不可见；"
                f"继续运行或改其他文件会在错误的执行图上叠加新改动，"
                f"根因反而更难定位。先把语法修干净再往下走。"
            )

try:
    data = read_input()
    CLIENT_NAME = str(data.get('client') or '')
    HOOK_EVENT_NAME = str(data.get('hook_event_name') or '')
    for path in candidate_paths(data):
        check_python_file(path)
except SystemExit:
    raise
except Exception as exc:
    log_maintenance_error(f"{type(exc).__name__}: {exc}")
    sys.exit(0)

sys.exit(0)
