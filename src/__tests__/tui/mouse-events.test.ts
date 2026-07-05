// src/__tests__/tui/mouse-events.test.ts
// SGR 鼠标事件解析器（?1003h 全追踪：press/drag/release/wheel + 多序列/分块累加）

import { describe, it, expect } from 'vitest';
import { createMouseParser, type MouseEvent } from '../../tui/input/mouse-events.js';

/** 单次喂入完整序列，返回解析结果 */
function parse(data: string): MouseEvent[] {
  const p = createMouseParser();
  return p.feed(data);
}

describe('createMouseParser（SGR 鼠标解析，单序列）', () => {
  it('左键按下：\\x1b[<0;col;rowM → mousedown', () => {
    const e = parse('\x1b[<0;10;5M');
    expect(e).toEqual([{ type: 'mousedown', button: 0, col: 10, row: 5 }]);
  });

  it('左键释放：\\x1b[<0;col;rowm → mouseup', () => {
    const e = parse('\x1b[<0;10;5m');
    expect(e).toEqual([{ type: 'mouseup', button: 0, col: 10, row: 5 }]);
  });

  it('拖拽（motion bit & 32，?1003h 全追踪）：\\x1b[<32;col;rowM → mousedrag', () => {
    // button=32 = motion event（无按键位，纯移动）；SGR M 表示按下态移动
    const e = parse('\x1b[<32;10;6M');
    expect(e).toEqual([{ type: 'mousedrag', button: 32, col: 10, row: 6 }]);
  });

  it('左键按下并拖拽（button=0+motion=32=32）：识别为 mousedrag', () => {
    // 左键按下 + motion bit: 0 | 32 = 32
    const e = parse('\x1b[<32;10;6M');
    expect(e[0]?.type).toBe('mousedrag');
  });

  it('滚轮上：\\x1b[<64;col;rowM → wheelup', () => {
    const e = parse('\x1b[<64;10;5M');
    expect(e).toEqual([{ type: 'wheelup', button: 64, col: 10, row: 5 }]);
  });

  it('滚轮下：\\x1b[<65;col;rowM → wheeldown', () => {
    const e = parse('\x1b[<65;10;5M');
    expect(e).toEqual([{ type: 'wheeldown', button: 65, col: 10, row: 5 }]);
  });

  it('非鼠标数据 → 空数组（不崩，不误报）', () => {
    expect(parse('hello')).toEqual([]);
    expect(parse('')).toEqual([]);
    expect(parse('\x1b[A')).toEqual([]); // 方向键，非鼠标
  });

  it('col/row 为 1-origin 原样保留（调用方负责转 0-based）', () => {
    const e = parse('\x1b[<0;1;1M');
    expect(e[0]?.col).toBe(1);
    expect(e[0]?.row).toBe(1);
  });
});

describe('createMouseParser（多序列 + 分块累加）', () => {
  it('一次喂入多个序列：全部解析', () => {
    const e = parse('\x1b[<0;10;5M\x1b[<32;10;6M\x1b[<0;10;7m');
    expect(e).toHaveLength(3);
    expect(e[0]?.type).toBe('mousedown');
    expect(e[1]?.type).toBe('mousedrag');
    expect(e[2]?.type).toBe('mouseup');
  });

  it('序列跨 chunk 分裂：累加缓冲，到齐才解析', () => {
    const p = createMouseParser();
    expect(p.feed('\x1b[<0;10')).toEqual([]); // 不完整，无输出
    expect(p.feed(';5M')).toHaveLength(1); // 补齐，解析出 1 个
    expect(p.feed('').length).toBe(0);
  });

  it('序列后跟非鼠标文本：序列解析 + 文本忽略', () => {
    const e = parse('\x1b[<0;10;5Mabc');
    expect(e).toHaveLength(1);
    expect(e[0]?.type).toBe('mousedown');
  });

  it('连续两次完整拖拽手势（press→drag→release ×2）', () => {
    const data = [
      '\x1b[<0;1;1M', '\x1b[<32;1;2M', '\x1b[<0;1;3m',
      '\x1b[<0;5;5M', '\x1b[<32;5;6M', '\x1b[<0;5;7m',
    ].join('');
    const e = parse(data);
    expect(e).toHaveLength(6);
    expect(e.map(x => x.type)).toEqual([
      'mousedown', 'mousedrag', 'mouseup',
      'mousedown', 'mousedrag', 'mouseup',
    ]);
  });

  it('残留缓冲在后续 feed 中补齐', () => {
    const p = createMouseParser();
    p.feed('\x1b[<0;1;1M'); // 完整 1 个
    p.feed('\x1b[<32;2');   // 不完整
    const e2 = p.feed(';2M'); // 补齐
    expect(e2).toHaveLength(1);
    expect(e2[0]?.type).toBe('mousedrag');
  });
});
