// src/__tests__/tui/connected-app-clear-screen.test.tsx
//
// 计划批准后清屏(auto+clear 模式)信号通道测试。
//
// 物理本质:applyPlanApproval(clearContext=true) 调 clearScreenStore.triggerClearScreen()
// 自增 tick;ConnectedApp 订阅 tick 变化 → 清屏 ANSI + 重挂载 <InlineAppV2>。
// 本测试验证信号层的真实行为:store tick 自增 + 通过 useStore 订阅的组件能感知变化。
// (真实 ConnectedApp 清屏+重挂载路径与 resize 共用,已由 v2-resize.test.tsx 覆盖。)

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Text } from 'ink';
import { useStore } from 'zustand/react';
import { createClearScreenStore } from '../../tui/state/clear-screen-store.js';

// 最小组件:订阅 clearScreenStore 的 tick(与 ConnectedApp 中的订阅方式一致)
function TickSubscriber({ store }: { store: ReturnType<typeof createClearScreenStore> }) {
  const tick = useStore(store, (s) => s.tick);
  return React.createElement(Text, null, `tick=${tick}`);
}

describe('clearScreenStore signal', () => {
  it('triggerClearScreen increments tick from 0 to 1', () => {
    const store = createClearScreenStore();
    expect(store.getState().tick).toBe(0);
    store.getState().triggerClearScreen();
    expect(store.getState().tick).toBe(1);
  });

  it('ConnectedApp-style subscriber sees tick change', () => {
    const store = createClearScreenStore();
    const { lastFrame, rerender } = render(React.createElement(TickSubscriber, { store }));
    expect(lastFrame()).toContain('tick=0');
    store.getState().triggerClearScreen();
    rerender(React.createElement(TickSubscriber, { store }));
    expect(lastFrame()).toContain('tick=1');
  });
});
