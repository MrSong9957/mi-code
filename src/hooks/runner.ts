// HookRunner：管理 hook 注册和执行
//
// 物理本质：电话转接台。
// 主循环拨号（事件名）→ 转接台找到对应插口（handler）→ 逐个转接 → 第一个说"停"的就停。

import type { HookEventName, HookEvent, HookResult, HookHandler } from './types.js';

export class HookRunner {
  private handlers = new Map<HookEventName, HookHandler[]>();

  /** 注册 hook handler */
  register(event: HookEventName, handler: HookHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  /** 注销 hook handler */
  unregister(event: HookEventName, handler: HookHandler): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  /** 执行 hooks，遇到 exitCode 1 或 2 立即返回 */
  async run(event: HookEvent): Promise<HookResult> {
    const list = this.handlers.get(event.name);
    if (!list || list.length === 0) {
      return { exitCode: 0, message: '' };
    }

    let lastResult: HookResult = { exitCode: 0, message: '' };
    for (const handler of list) {
      const result = await handler(event);
      if (result.exitCode === 1 || result.exitCode === 2) {
        return result;
      }
      lastResult = result;
    }

    return lastResult;
  }
}
