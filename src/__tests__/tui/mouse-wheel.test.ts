// src/__tests__/tui/mouse-wheel.test.ts
// SGR 鼠标滚轮解析（charter §核心模块 1）

import { describe, it, expect } from 'vitest';
import { parseMouseWheel } from '../../tui/input/mouse-wheel.js';

describe('parseMouseWheel（SGR 鼠标滚轮序列解析）', () => {
  it('滚轮上：\\x1b[<64;col;rowM → up（SGR 编码 button 64 = wheel up）', () => {
    expect(parseMouseWheel('\x1b[<64;10;5M')).toBe('up');
  });

  it('滚轮下：\\x1b[<65;col;rowM → down（button 65 = wheel down）', () => {
    expect(parseMouseWheel('\x1b[<65;10;5M')).toBe('down');
  });

  it('非鼠标序列 → null', () => {
    expect(parseMouseWheel('hello')).toBeNull();
    expect(parseMouseWheel('')).toBeNull();
    expect(parseMouseWheel('\x1b[A')).toBeNull(); // 方向键，非鼠标
  });

  it('鼠标按下（非滚轮）→ null（本期只处理滚轮）', () => {
    expect(parseMouseWheel('\x1b[<0;10;5M')).toBeNull(); // button 0 = 左键按下
    expect(parseMouseWheel('\x1b[<2;10;5M')).toBeNull(); // button 2 = 右键
  });

  it('鼠标释放（M → m）→ null', () => {
    expect(parseMouseWheel('\x1b[<0;10;5m')).toBeNull();
  });

  it('带修饰键的滚轮（button+修饰位）仍识别为滚轮', () => {
    // Ctrl+滚轮：button 64 + 16(修饰) = 80
    expect(parseMouseWheel('\x1b[<80;10;5M')).toBe('up');
  });
});
