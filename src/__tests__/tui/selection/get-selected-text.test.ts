// src/__tests__/tui/selection/get-selected-text.test.ts
// 选区→文本（区域无关）：L 型提取 + scrolledOff 拼接 + 流式块跳过
// 通过 buildRowTextMap 构造映射，验证跨区域提取

import { describe, it, expect } from 'vitest';
import { getSelectedText } from '../../../tui/selection/get-selected-text.js';
import { buildRowTextMap } from '../../../tui/selection/row-text-map.js';
import { createSelectionStore } from '../../../tui/state/selection-store.js';
import type { TuiMessage, StatusBarData } from '../../../tui/types.js';

function makeMsg(uuid: string, lines: string[]): TuiMessage {
  return {
    uuid, role: 'assistant', finalized: true,
    lines: lines.map(c => ({ content: c, style: {}, indent: 0 })),
  };
}

const STATUS: StatusBarData = {
  mode: 'build', model: 'sonnet', dir: 'Projects/mi-code', branch: 'main', contextPct: 0.5,
};

/** 造一个 3 消息布局：LOGO(0-2) + 消息 hello@3/world@4/foo@5 + 上边框@6 + 输入@7 + 下边框@8 + 状态栏@9 */
function makeMap(overrides: Partial<Parameters<typeof buildRowTextMap>[0]> = {}) {
  return buildRowTextMap({
    rows: 24, cols: 80,
    logo: { version: '1.0.0', dir: 'Projects/mi-code' },
    messages: [makeMsg('a', ['hello']), makeMsg('b', ['world']), makeMsg('c', ['foo'])],
    scrollTop: 0, visibleRows: 17,
    input: 'test', inputRowY: 7,
    status: STATUS,
    spinnerActive: false, completionVisible: false,
    ...overrides,
  });
}

describe('getSelectedText（区域无关）', () => {
  it('无选区：返回空串', () => {
    const store = createSelectionStore();
    const text = getSelectedText({ rowTextMap: makeMap(), selection: store.getState() });
    expect(text).toBe('');
  });

  it('单行消息选区：取选中片段', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 1 });
    store.getState().dragTo({ row: 3, col: 4 });
    const text = getSelectedText({ rowTextMap: makeMap(), selection: store.getState() });
    expect(text).toBe('ell');
  });

  it('多行消息 L 型：首行片段 + 中间整行 + 末行片段', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 5, col: 3 });
    const text = getSelectedText({ rowTextMap: makeMap(), selection: store.getState() });
    // row3 hello[2..]='llo'，row4 world 整行，row5 foo[:3]='foo'
    expect(text).toBe('llo\nworld\nfoo');
  });

  it('LOGO 区域可选：选中 LOGO 第 0 行片段', () => {
    const store = createSelectionStore();
    // LOGO 行 0：' ▐▛███▜▌   MiCode v1.0.0'（box 字符占 2 显示列，'M' 在显示列 11）
    store.getState().startDrag({ row: 0, col: 11 });
    store.getState().dragTo({ row: 0, col: 16 });
    const text = getSelectedText({ rowTextMap: makeMap(), selection: store.getState() });
    // 显示列 [11,16) = 'MiCod'
    expect(text).toBe('MiCod');
  });

  it('跨区域选区：LOGO 末行 + 消息首行', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 2, col: 10 });
    store.getState().dragTo({ row: 3, col: 3 });
    const text = getSelectedText({ rowTextMap: makeMap(), selection: store.getState() });
    // row2 ' Projects/mi-code'[10..] 含 'mi-code'，row3 'hel'[:3]
    expect(text).toContain('mi-code');
    expect(text).toContain('hel');
    expect(text.includes('\n')).toBe(true);
  });

  it('输入框区域可选：选中输入行片段', () => {
    const store = createSelectionStore();
    // 输入行 7：'❯ test'
    store.getState().startDrag({ row: 7, col: 3 });
    store.getState().dragTo({ row: 7, col: 6 });
    const text = getSelectedText({ rowTextMap: makeMap(), selection: store.getState() });
    expect(text.length).toBeGreaterThan(0);
  });

  it('状态栏区域可选', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 9, col: 0 });
    store.getState().dragTo({ row: 9, col: 5 });
    const text = getSelectedText({ rowTextMap: makeMap(), selection: store.getState() });
    expect(text).toContain('build');
  });

  it('scrolledOffAbove + 选区 + scrolledOffBelow 拼接', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 0 });
    store.getState().dragTo({ row: 3, col: 5 });
    store.getState().pushScrolledOff('above', 'scrolled-up-line');
    store.getState().pushScrolledOff('below', 'scrolled-down-line');
    const text = getSelectedText({ rowTextMap: makeMap(), selection: store.getState() });
    expect(text).toBe('scrolled-up-line\nhello\nscrolled-down-line');
  });

  it('流式块（未 finalized）：RowTextMap 返回 null，跳过', () => {
    const streaming: TuiMessage = { uuid: 's', role: 'assistant', finalized: false, streamingText: 'x', lines: [] };
    const map = makeMap({ messages: [streaming] });
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 0 });
    store.getState().dragTo({ row: 3, col: 5 });
    const text = getSelectedText({ rowTextMap: map, selection: store.getState() });
    expect(text).toBe('');
  });

  it('边框行可选：上边框片段', () => {
    const store = createSelectionStore();
    // 上边框行 6：'─'×80
    store.getState().startDrag({ row: 6, col: 0 });
    store.getState().dragTo({ row: 6, col: 5 });
    const text = getSelectedText({ rowTextMap: makeMap(), selection: store.getState() });
    expect(text).toBe('─'.repeat(5));
  });
});
