// src/permission/session-lifecycle.ts
//
// Session 生命周期 helper:sessionId 真正变化时,清空所有 session 级缓存。
//
// 物理本质:换班时撕掉小本子。只有 sessionId 真正变化(rotate/rewind/resume 切到新会话)
// 才清空;同 session 内跨 turn 不清(保留 "Allow this exact action for this session" 记忆)。
//
// 设计意图:把"sessionId 变化 → 清 session 级状态"这个契约集中到一处,
// 让 index.ts 的三处切换点(rotateSessionId / handleRewindLastTurn / --resume)
// 都调用同一个 helper,避免某处漏调 clear() 的 wiring 回归。
//
// 当前 session 级状态只有 SessionAllowlist。未来若增加其他 session 级缓存,
// 在此 helper 内统一清空,调用方无需改动。

import type { SessionAllowlist } from './session-allowlist.js';

/**
 * 切换 sessionId:若 newId 与 currentId 不同,清空 session 级缓存(allowlist)。
 *
 * @param currentId 当前 sessionId
 * @param newId 新 sessionId(可能是 randomUUID 或 resume 的目标 id)
 * @param allowlist session 级 allowlist(被清空对象)
 * @returns newId(供调用方赋值给 sessionId 变量)
 *
 * 不变量:
 *   - currentId === newId → 不 clear(同 session,保留跨 turn 记忆)
 *   - currentId !== newId → clear(切到新 session,丢弃旧记忆)
 */
export function transitionSessionId(
  currentId: string,
  newId: string,
  allowlist: SessionAllowlist,
): string {
  if (currentId !== newId) {
    allowlist.clear();
  }
  return newId;
}
