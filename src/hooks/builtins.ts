// 内置 hooks：安全检查 + 日志
//
// 物理本质：门卫（安全检查）+ 监控摄像头（日志记录）。
// 危险命令模式从 permission/patterns.ts 共享导入，避免两处漂移。

import type { HookEvent, HookResult } from './types.js';
import { isDangerousBash } from '../permission/patterns.js';

/** PreToolUse：检测危险 bash 命令 */
export function preToolSafetyCheck(event: HookEvent): HookResult {
  const toolName = event.payload.tool_name as string;
  const input = event.payload.input as Record<string, unknown>;

  if (toolName !== 'run_bash') {
    return { exitCode: 0, message: '' };
  }

  const command = (input.command as string) || '';
  if (isDangerousBash(command)) {
    return { exitCode: 1, message: 'Dangerous command blocked by built-in policy' };
  }

  return { exitCode: 0, message: '' };
}

/** PostToolUse：记录工具执行结果（把日志作为 message 返回，由调用方决定如何展示）
 *  注意：不直接写终端——在备用屏画布渲染下，所有输出必须经渲染器，否则会冲乱布局。 */
export function postToolLogger(event: HookEvent): HookResult {
  const toolName = event.payload.tool_name as string;
  const output = event.payload.output as string;
  const preview = output.length > 100 ? output.slice(0, 100) + '...' : output;
  return { exitCode: 0, message: `[Hook] ${toolName} → ${preview}` };
}

/** SessionStart：记录会话开始（把日志作为 message 返回，由调用方决定如何展示） */
export function sessionStartLogger(): HookResult {
  return { exitCode: 0, message: `[Hook] Session started at ${new Date().toISOString()}` };
}
