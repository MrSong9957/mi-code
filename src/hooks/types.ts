// Hook 系统类型定义
//
// 物理本质：预留插口。
// 主循环运行到固定时机 → 把上下文交给 hook → hook 返回结果 → 主循环决定下一步。
// exitCode: 0=继续, 1=阻止, 2=注入消息再继续

/** Hook 事件名 */
export type HookEventName = 'SessionStart' | 'PreToolUse' | 'PostToolUse';

/** Hook 事件 */
export interface HookEvent {
  name: HookEventName;
  payload: Record<string, unknown>;
}

/** Hook 返回结果 */
export interface HookResult {
  exitCode: 0 | 1 | 2;
  message: string;
}

/** Hook 处理函数 */
export type HookHandler = (event: HookEvent) => HookResult | Promise<HookResult>;

/** 常量：exitCode 别名 */
export const HOOK_CONTINUE = 0 as const;
export const HOOK_BLOCK = 1 as const;
export const HOOK_INJECT = 2 as const;
