// src/permission/session-state.ts
//
// SessionState:唯一的 session mutation boundary。
//
// 物理本质:sessionId 是一把"当前会话钥匙"。换钥匙时必须同步清空所有绑定这把钥匙
// 的 session 级缓存(当前是 SessionAllowlist)。本类把这把钥匙封装起来——
// 外部只能读 currentId,不能直接写;切换只能经 transitionTo,由它统一清缓存。
//
// 设计意图:结构上消除"调用方直接赋值 sessionId 而忘记 clear"的双写风险。
// rotate / hard rewind / resume 三条生产路径都只能调 transitionTo,
// 不存在绕过 transitionTo 直接改 id 的旁路。
//
// 不变量:
//   - currentId 只读(getter,无 setter);TypeScript 编译期禁止外部赋值
//   - transitionTo(newId):newId !== currentId → clear + 更新;相同 → 不 clear
//   - 同 session 跨 turn(transitionTo 相同 id)→ 保留 allowlist 记忆

import type { SessionAllowlist } from './session-allowlist.js';

export class SessionState {
  private _currentId: string;
  private readonly allowlist: SessionAllowlist;

  constructor(allowlist: SessionAllowlist, initialId: string) {
    this.allowlist = allowlist;
    this._currentId = initialId;
  }

  /** 当前 sessionId(只读)。外部不可直接赋值。 */
  get currentId(): string {
    return this._currentId;
  }

  /**
   * 切换到新 sessionId。唯一允许的 session 变更入口。
   * newId !== currentId → 清空 session 级缓存(allowlist)+ 更新 id。
   * newId === currentId → 不清空(同 session 跨 turn 保留记忆)。
   */
  transitionTo(newId: string): void {
    if (newId !== this._currentId) {
      this.allowlist.clear();
    }
    this._currentId = newId;
  }
}
