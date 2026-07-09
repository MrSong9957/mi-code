// src/__tests__/tui/selection/row-text-map.test.ts
// 统一行文本映射：屏幕全局行 → 该行文本（跨 LOGO/消息/边框/输入/状态栏）
// 精简版：保留各核心区域的映射正确性，删除越界/空行/spinner/进度条边界穷举

import { describe, it, expect } from 'vitest';
import { buildRowTextMap } from '../../../tui/selection/row-text-map.js';
import type { TuiMessage } from '../../../tui/types.js';

const LOGO_ROWS = 3;

function makeMsg(uuid: string, lines: string[]): TuiMessage {
  return {
    uuid, role: 'assistant', finalized: true,
    lines: lines.map(c => ({ content: c, style: {}, indent: 0 })),
  };
}

function makeLayout(overrides: Partial<Parameters<typeof buildRowTextMap>[0]> = {}) {
  return {
    rows: 24, cols: 80,
    logo: { version: '1.0.0', dir: 'Projects/mi-code' },
    messages: [makeMsg('a', ['hello']), makeMsg('b', ['world']), makeMsg('c', ['foo'])],
    scrollTop: 0, visibleRows: 17,
    input: 'test input', inputRowY: LOGO_ROWS + 3 + 1,
    status: { mode: 'build', model: 'sonnet', dir: 'Projects/mi-code', branch: 'main', contextPct: 0.5 },
    spinnerActive: false, completionVisible: false,
    ...overrides,
  };
}

describe('row-text-map（核心区域映射）', () => {
  it('LOGO 行 → ASCII art + version/dir', () => {
    const m = buildRowTextMap(makeLayout());
    expect(m.getLineContent(0)).toBe(' ▐▛███▜▌   MiCode v1.0.0');
    expect(m.getLineContent(2)).toBe('  ▘▘ ▝▝    Projects/mi-code');
  });

  it('消息行 → 消息内容', () => {
    const m = buildRowTextMap(makeLayout());
    expect(m.getLineContent(3)).toBe('hello');
    expect(m.getLineContent(5)).toBe('foo');
  });

  it('上边框行 → ─×cols', () => {
    const m = buildRowTextMap(makeLayout());
    expect(m.getLineContent(6)).toBe('─'.repeat(80));
  });

  it('输入行 → ❯ + input', () => {
    const m = buildRowTextMap(makeLayout({ input: 'abc' }));
    expect(m.getLineContent(7)).toBe('❯ abc');
  });

  it('状态栏行 → 含 mode/model/branch/pct', () => {
    const m = buildRowTextMap(makeLayout());
    const sb = m.getLineContent(9) ?? '';
    expect(sb).toContain('build');
    expect(sb).toContain('sonnet');
    expect(sb).toContain('main');
    expect(sb).toContain('50%');
  });

  it('流式块（未 finalized）：跳过返回 null', () => {
    const streaming: TuiMessage = { uuid: 's', role: 'assistant', finalized: false, streamingText: 'x', lines: [] };
    const m = buildRowTextMap(makeLayout({ messages: [streaming] }));
    expect(m.getLineContent(3)).toBeNull();
  });
});
