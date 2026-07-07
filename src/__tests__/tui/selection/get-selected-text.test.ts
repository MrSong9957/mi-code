// src/__tests__/tui/selection/get-selected-text.test.ts
// 选区→文本：L 型提取 + scrolledOff 拼接 + 流式块跳过

import { describe, it, expect } from 'vitest';
import { getSelectedText } from '../../../tui/selection/get-selected-text.js';
import { createSelectionStore } from '../../../tui/state/selection-store.js';
import type { TuiMessage } from '../../../tui/types.js';

const LOGO_ROWS = 3;

function makeMsg(uuid: string, lines: string[], role: 'assistant' | 'user' | 'system' = 'assistant'): TuiMessage {
  return {
    uuid, role, finalized: true,
    lines: lines.map(content => ({ content, style: {}, indent: 0 })),
  };
}

describe('getSelectedText', () => {
  it('无选区：返回空串', () => {
    const store = createSelectionStore();
    const text = getSelectedText({
      messages: [makeMsg('a', ['hello'])], scrollTop: 0, visibleRows: 10,
      viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    expect(text).toBe('');
  });

  it('单行选区：取选中片段', () => {
    const store = createSelectionStore();
    // messages: [hello] 在屏幕行 LOGO_ROWS+0=3
    store.getState().startDrag({ row: 3, col: 1 });
    store.getState().dragTo({ row: 3, col: 4 });
    const text = getSelectedText({
      messages: [makeMsg('a', ['hello'])], scrollTop: 0, visibleRows: 10,
      viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    expect(text).toBe('ell');
  });

  it('多行 L 型：首行片段 + 中间整行 + 末行片段', () => {
    const store = createSelectionStore();
    // 三条消息各 1 行：屏幕行 3/4/5
    // anchor row=3 col=2 'hello'[2..]='llo'
    // 中间 row=4 整行 'world'
    // 末行 row=5 col=3 'foo'[:3]='foo'
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 5, col: 3 });
    const text = getSelectedText({
      messages: [makeMsg('a', ['hello']), makeMsg('b', ['world']), makeMsg('c', ['foo'])],
      scrollTop: 0, visibleRows: 10, viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    expect(text).toBe('llo\nworld\nfoo');
  });

  it('向上拖（focus 在上）：首末按 anchor/focus 的 row 决定', () => {
    const store = createSelectionStore();
    // anchor row=5 col=3, focus row=3 col=2（向上拖）
    store.getState().startDrag({ row: 5, col: 3 });
    store.getState().dragTo({ row: 3, col: 2 });
    const text = getSelectedText({
      messages: [makeMsg('a', ['hello']), makeMsg('b', ['world']), makeMsg('c', ['foo'])],
      scrollTop: 0, visibleRows: 10, viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    // getSelectedText 按 row 升序遍历 [minRow=3 .. maxRow=5]：
    //   row=3 hello（focus 所在）：[0, focusCol=2) → 'he'
    //   row=4 world（中间）：整行 → 'world'
    //   row=5 foo（anchor 所在）：[anchorCol=3, width=3) → 空（col==width）
    // 空行仍占一行（join('\n') 保留），结果 'he\nworld\n'（末尾空行）
    expect(text).toBe('he\nworld\n');
  });

  it('scrolledOffAbove + 视口内 + scrolledOffBelow 拼接', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 0 });
    store.getState().dragTo({ row: 3, col: 5 });
    store.getState().pushScrolledOff('above', 'scrolled-up-line');
    store.getState().pushScrolledOff('below', 'scrolled-down-line');
    const text = getSelectedText({
      messages: [makeMsg('a', ['hello'])], scrollTop: 0, visibleRows: 10,
      viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    expect(text).toBe('scrolled-up-line\nhello\nscrolled-down-line');
  });

  it('流式块（未 finalized）：跳过返回空', () => {
    const store = createSelectionStore();
    const streaming: TuiMessage = {
      uuid: 's', role: 'assistant', finalized: false, streamingText: 'streaming...',
      lines: [],
    };
    store.getState().startDrag({ row: 3, col: 0 });
    store.getState().dragTo({ row: 3, col: 5 });
    const text = getSelectedText({
      messages: [streaming], scrollTop: 0, visibleRows: 10,
      viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    expect(text).toBe('');
  });

  it('选区跨多条消息（每条多行）', () => {
    const store = createSelectionStore();
    // 消息 A 2 行（屏幕 3,4），消息 B 2 行（屏幕 5,6）
    store.getState().startDrag({ row: 3, col: 0 }); // A 行1 首行 [0, width=5)
    store.getState().dragTo({ row: 6, col: 3 });    // B 行2 末行 [0,3)
    const text = getSelectedText({
      messages: [
        makeMsg('a', ['aaa11', 'aaa22']),
        makeMsg('b', ['bbb11', 'bbb22']),
      ],
      scrollTop: 0, visibleRows: 10, viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    // row3 A 行1 [0,5)='aaa11'，row4 A 行2 整行='aaa22'，
    // row5 B 行1 整行='bbb11'，row6 B 行2 [0,3)='bbb'
    expect(text).toBe('aaa11\naaa22\nbbb11\nbbb');
  });
});
