// src/__tests__/tui/selection/flatten-messages.test.ts
// 行列表展开：单行/多行/流式跳过/空

import { describe, it, expect } from 'vitest';
import { flattenMessages } from '../../../tui/selection/flatten-messages.js';
import { createTurnDurationMessage } from '../../../tui/state/turn-duration-message.js';
import type { TuiMessage } from '../../../tui/types.js';

function makeMsg(uuid: string, lines: string[], finalized = true): TuiMessage {
  return {
    uuid, role: 'assistant', finalized,
    lines: lines.map(c => ({ content: c, style: {}, indent: 0 })),
    ...(finalized ? {} : { streamingText: 'x' }),
  };
}

describe('flattenMessages', () => {
  it('空数组：返回空', () => {
    expect(flattenMessages([])).toEqual([]);
  });

  it('单条单行消息：1 个 FlatLine', () => {
    const r = flattenMessages([makeMsg('a', ['hello'])]);
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({ messageUuid: 'a', lineIndex: 0, line: { content: 'hello', style: {}, indent: 0 } });
  });

  it('单条多行消息：每行一个 FlatLine，lineIndex 递增', () => {
    const r = flattenMessages([makeMsg('a', ['l0', 'l1', 'l2'])]);
    expect(r).toHaveLength(3);
    expect(r.map(x => x.lineIndex)).toEqual([0, 1, 2]);
    expect(r.map(x => x.line.content)).toEqual(['l0', 'l1', 'l2']);
    expect(r.every(x => x.messageUuid === 'a')).toBe(true);
  });

  it('多条消息：顺序拼接，各自 lineIndex 从 0 开始', () => {
    const r = flattenMessages([makeMsg('a', ['a0', 'a1']), makeMsg('b', ['b0'])]);
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ messageUuid: 'a', lineIndex: 0 });
    expect(r[1]).toMatchObject({ messageUuid: 'a', lineIndex: 1 });
    expect(r[2]).toMatchObject({ messageUuid: 'b', lineIndex: 0 });
  });

  it('流式块（!finalized）：跳过', () => {
    const streaming = makeMsg('s', [], false);
    const r = flattenMessages([makeMsg('a', ['x']), streaming, makeMsg('b', ['y'])]);
    expect(r).toHaveLength(2);
    expect(r.map(x => x.messageUuid)).toEqual(['a', 'b']);
  });

  it('全是流式块：返回空', () => {
    const r = flattenMessages([makeMsg('s1', [], false), makeMsg('s2', [], false)]);
    expect(r).toEqual([]);
  });

  it('保留 indent/style', () => {
    const r = flattenMessages([makeMsg('a', [])]).length === 0
      ? flattenMessages([{
          uuid: 'a', role: 'assistant', finalized: true,
          lines: [{ content: '  indented', style: { fg: 'brand' }, indent: 2 }],
        }])
      : [];
    expect(r[0]?.line.indent).toBe(2);
    expect(r[0]?.line.style.fg).toBe('brand');
  });

  it('turn-duration 消息按普通固化行进入滚动列表', () => {
    // 完成消息是 finalized 的 TuiMessage 子类型，flatten 应作为普通固化行展开，
    // 保留前导空行 + dim 主行，不调用任何专用渲染分支。
    const message = createTurnDurationMessage({
      uuid: 'duration-1', durationMs: 9_000,
      prependBlankLine: true, random: () => 0.5,
    });
    const flat = flattenMessages([message]);
    expect(flat.map(line => line.line.content)).toEqual(['', '✻ Cooked for 9s']);
    expect(flat.map(line => line.line.style)).toEqual([
      {}, { dim: true },
    ]);
    expect(flat.every(line => line.messageUuid === 'duration-1')).toBe(true);
  });
});
