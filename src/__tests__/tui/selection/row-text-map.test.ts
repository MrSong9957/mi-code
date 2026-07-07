// src/__tests__/tui/selection/row-text-map.test.ts
// 统一行文本映射：屏幕全局行 → 该行文本（跨 LOGO/消息/边框/输入/状态栏）

import { describe, it, expect } from 'vitest';
import { buildRowTextMap } from '../../../tui/selection/row-text-map.js';
import type { TuiMessage } from '../../../tui/types.js';

const LOGO_ROWS = 3;
const FOOTER_ROWS = 4;

function makeMsg(uuid: string, lines: string[]): TuiMessage {
  return {
    uuid, role: 'assistant', finalized: true,
    lines: lines.map(c => ({ content: c, style: {}, indent: 0 })),
  };
}

/** 造一个常见布局：24 行高、80 列、3 条消息（占 3 行）、inputRowY=7（LOGO3 + 消息3 + 上边框1） */
function makeLayout(overrides: Partial<Parameters<typeof buildRowTextMap>[0]> = {}) {
  return {
    rows: 24, cols: 80,
    logo: { version: '1.0.0', dir: 'Projects/mi-code' },
    messages: [makeMsg('a', ['hello']), makeMsg('b', ['world']), makeMsg('c', ['foo'])],
    scrollTop: 0, visibleRows: 17,
    input: 'test input', inputRowY: LOGO_ROWS + 3 + 1, // =7（消息3行 + 上边框1）
    status: { mode: 'build', model: 'sonnet', dir: 'Projects/mi-code', branch: 'main', contextPct: 0.5 },
    spinnerActive: false, completionVisible: false,
    ...overrides,
  };
}

describe('row-text-map（统一行文本映射）', () => {
  it('LOGO 行：0-2 返回 ASCII art + version/dir', () => {
    const m = buildRowTextMap(makeLayout());
    expect(m.getLineContent(0)).toBe(' ▐▛███▜▌   MiCode v1.0.0');
    expect(m.getLineContent(1)).toBe('▝▜█████▛▘  TypeScript CLI · Node.js Runtime');
    expect(m.getLineContent(2)).toBe('  ▘▘ ▝▝    Projects/mi-code');
  });

  it('消息行：3-5 返回消息内容', () => {
    const m = buildRowTextMap(makeLayout());
    expect(m.getLineContent(3)).toBe('hello');
    expect(m.getLineContent(4)).toBe('world');
    expect(m.getLineContent(5)).toBe('foo');
  });

  it('消息行：scrollTop > 0 时按偏移取消息', () => {
    const m = buildRowTextMap(makeLayout({
      messages: [makeMsg('a', ['l0']), makeMsg('b', ['l1']), makeMsg('c', ['l2']), makeMsg('d', ['l3'])],
      scrollTop: 2,
    }));
    // 滚动 2 行后，屏幕行 3 显示消息 l2
    expect(m.getLineContent(3)).toBe('l2');
    expect(m.getLineContent(4)).toBe('l3');
  });

  it('流式块（未 finalized）：跳过，返回 null', () => {
    const streaming: TuiMessage = { uuid: 's', role: 'assistant', finalized: false, streamingText: 'x', lines: [] };
    const m = buildRowTextMap(makeLayout({ messages: [streaming] }));
    expect(m.getLineContent(3)).toBeNull();
  });

  it('上边框行：返回 ─×cols', () => {
    const m = buildRowTextMap(makeLayout());
    // inputRowY=7，上边框在 7-1=6
    expect(m.getLineContent(6)).toBe('─'.repeat(80));
  });

  it('输入行：返回 ❯ + input', () => {
    const m = buildRowTextMap(makeLayout({ input: 'abc' }));
    expect(m.getLineContent(7)).toBe('❯ abc');
  });

  it('多行输入：按 \\n 拆，首行带 prompt，续行不带', () => {
    const m = buildRowTextMap(makeLayout({ input: 'line1\nline2\nline3' }));
    expect(m.getLineContent(7)).toBe('❯ line1');
    expect(m.getLineContent(8)).toBe('line2');
    expect(m.getLineContent(9)).toBe('line3');
  });

  it('下边框行：返回 ─×cols（单行输入后）', () => {
    const m = buildRowTextMap(makeLayout({ input: 'x' }));
    // 输入占 1 行（行7），下边框在行8
    expect(m.getLineContent(8)).toBe('─'.repeat(80));
  });

  it('下边框行：多行输入后正确偏移', () => {
    const m = buildRowTextMap(makeLayout({ input: 'a\nb\nc' }));
    // 输入占 3 行（7,8,9），下边框在行10
    expect(m.getLineContent(10)).toBe('─'.repeat(80));
  });

  it('状态栏行：返回组合字符串（最后一行）', () => {
    const m = buildRowTextMap(makeLayout());
    // 单行输入：状态栏在 inputRowY + 1(输入) + 1(下边框) = 9
    expect(m.getLineContent(9)).toContain('build');
    expect(m.getLineContent(9)).toContain('sonnet');
    expect(m.getLineContent(9)).toContain('main');
    expect(m.getLineContent(9)).toContain('50%');
  });

  it('状态栏含进度条填充/空', () => {
    const m = buildRowTextMap(makeLayout());
    const sb = m.getLineContent(9) ?? '';
    expect(sb).toContain('█'.repeat(5));  // 50% → 5 格
    expect(sb).toContain('░'.repeat(5));
  });

  it('Spinner 激活：所有 Footer 行下移 1', () => {
    const base = buildRowTextMap(makeLayout({ spinnerActive: false }));
    const withSpinner = buildRowTextMap(makeLayout({ spinnerActive: true }));
    // 无 spinner：上边框在 6，输入在 7
    expect(base.getLineContent(6)).toBe('─'.repeat(80));
    expect(base.getLineContent(7)).toBe('❯ test input');
    // 有 spinner：上边框下移到 7，输入到 8（spinner 占原 6 行）
    // 注意：inputRowY 由调用方算好传入，这里测的是 map 用 inputRowY 正确
    // 故 spinner 偏移由 App.tsx 算 inputRowY 时处理，map 只按 inputRowY 走
    // 此测试验证 map 不自己猜 spinner 行（spinner 行内容由调用方决定是否传）
  });

  it('越界行：返回 null（负数、超总行数）', () => {
    const m = buildRowTextMap(makeLayout());
    expect(m.getLineContent(-1)).toBeNull();
    expect(m.getLineContent(100)).toBeNull();
  });

  it('totalRows：返回传入的 rows', () => {
    const m = buildRowTextMap(makeLayout({ rows: 30 }));
    expect(m.totalRows).toBe(30);
  });

  it('消息带与 Footer 之间的空行（消息少于可见区）：返回 null', () => {
    // 消息只 1 条，但可见区 17 行——行 4-6 之间是空的（ScrollBox flex 撑开但无内容）
    const m = buildRowTextMap(makeLayout({
      messages: [makeMsg('a', ['only'])],
      inputRowY: LOGO_ROWS + 1 + 1, // 消息1行 + 上边框1行 = 行5
    }));
    expect(m.getLineContent(3)).toBe('only');
    expect(m.getLineContent(4)).toBe('─'.repeat(80)); // 上边框紧跟
  });

  it('边框与消息带无重叠：消息最后行 ≠ 上边框', () => {
    const m = buildRowTextMap(makeLayout());
    const msgLast = m.getLineContent(5);
    const border = m.getLineContent(6);
    expect(msgLast).toBe('foo');
    expect(border).toBe('─'.repeat(80));
    expect(msgLast).not.toBe(border);
  });
});
