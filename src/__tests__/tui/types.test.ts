// src/__tests__/tui/types.test.ts
// TUI 数据模型 + 样式映射测试

import { describe, it, expect } from 'vitest';
import { styleToInkProps } from '../../tui/types.js';
import type { UIMessageStyle } from '../../ui/types.js';

describe('styleToInkProps（语义 token → Ink <Text> props）', () => {
  it('undefined → 空 props', () => {
    expect(styleToInkProps(undefined)).toEqual({});
  });

  it('空对象 → 空 props', () => {
    expect(styleToInkProps({})).toEqual({});
  });

  it('fg=brand → color=magenta（● 标题/assistant 前缀）', () => {
    expect(styleToInkProps({ fg: 'brand' })).toEqual({ color: 'magenta' });
  });

  it('fg=success → color=green（❯ 用户输入）', () => {
    expect(styleToInkProps({ fg: 'success', bold: true })).toEqual({ color: 'green', bold: true });
  });

  it('fg=error → color=red', () => {
    expect(styleToInkProps({ fg: 'error' })).toEqual({ color: 'red' });
  });

  it('fg=border → color=gray（footer 边框）', () => {
    expect(styleToInkProps({ fg: 'border' })).toEqual({ color: 'gray' });
  });

  it('dim=true → dimColor=true（⎿ 结果行/摘要）', () => {
    expect(styleToInkProps({ dim: true })).toEqual({ dimColor: true });
  });

  it('bg=gray → backgroundColor=gray（用户输入高亮底）', () => {
    expect(styleToInkProps({ fg: 'success', bold: true, bg: 'gray' }))
      .toEqual({ color: 'green', bold: true, backgroundColor: 'gray' });
  });

  it('italic/underline 透传', () => {
    expect(styleToInkProps({ italic: true, underline: true }))
      .toEqual({ italic: true, underline: true });
  });

  it('未知 fg token 透传（可能是 hex 或具名色）', () => {
    expect(styleToInkProps({ fg: '#ff8800' })).toEqual({ color: '#ff8800' });
  });

  it('完整 BLOCK_STYLES.magenta 等价样式', () => {
    const style: UIMessageStyle = { fg: 'brand' };
    expect(styleToInkProps(style)).toEqual({ color: 'magenta' });
  });

  it('完整 BLOCK_STYLES.dim 等价样式', () => {
    const style: UIMessageStyle = { dim: true };
    expect(styleToInkProps(style)).toEqual({ dimColor: true });
  });

  it('完整 BLOCK_STYLES.greenBold 等价样式（❯ 输入）', () => {
    const style: UIMessageStyle = { fg: 'success', bold: true, bg: 'gray' };
    expect(styleToInkProps(style))
      .toEqual({ color: 'green', bold: true, backgroundColor: 'gray' });
  });
});
