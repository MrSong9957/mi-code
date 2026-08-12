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

/** PostToolUse：常规成功在源头抑制（design spec §3）。
 *
 *  常规 `[Hook] xxx done` 没有用户价值也没有未来诊断价值：返回空 message,
 *  index.ts 的 `if (hookResult.message)` 门不会 emit,任何 store/channel 都收不到。
 *  仍绝不返回 output 预览——输出内容已由 BlockPipeline 的 tool_result 块统一渲染
 *  (带 ⎿ 前缀、摘要、ctrl+o 折叠);hook 二次输出会导致同一内容被画两遍(症状 C 根因)。
 *  不直接写终端——在备用屏画布渲染下,所有输出必须经渲染器,否则会冲乱布局。 */
export function postToolLogger(event: HookEvent): HookResult {
  void event;
  return { exitCode: 0, message: '' };
}

/** SessionStart：记录会话开始（把日志作为 message 返回，由调用方决定如何展示） */
export function sessionStartLogger(): HookResult {
  return { exitCode: 0, message: `[Hook] Session started at ${new Date().toISOString()}` };
}
