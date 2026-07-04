// 单测：virtual-screen.ts —— 虚拟光标记账
//
// 物理本质：自己手里备一张小地图，记下"我认为打印头现在在 (x,y)"。
// 每次发指令让它动了，就在小地图上同步更新坐标。下次让它去别处，
// 只在小地图上算"从当前位置相对走几步"，然后只发相对指令（CUU/CUD/CUF/CUB），
// 绝不发绝对坐标——对起点不敏感（文档§2.3 铁律、§3.1）。

import { describe, it, expect } from 'vitest';
import { VirtualScreen } from '../renderer/virtual-screen.js';
import { makeCell } from '../renderer/cell.js';

describe('VirtualScreen', () => {
  describe('初始状态', () => {
    it('默认光标在 (0,0)', () => {
      const vs = new VirtualScreen();
      expect(vs.cursor).toEqual({ x: 0, y: 0 });
    });
    it('可指定初始坐标', () => {
      const vs = new VirtualScreen({ x: 2, y: 3 });
      expect(vs.cursor).toEqual({ x: 2, y: 3 });
    });
  });

  describe('moveTo —— 只发相对指令', () => {
    it('从 (0,0) 移到 (3,2) → 发相对 \\x1b[3C\\x1b[2B', () => {
      const vs = new VirtualScreen();
      vs.moveTo(3, 2);
      expect(vs.flush()).toBe('\x1b[3C\x1b[2B');
      expect(vs.cursor).toEqual({ x: 3, y: 2 });
    });
    it('从 (5,5) 移到 (2,1) → 发相对左 3、上 4', () => {
      const vs = new VirtualScreen({ x: 5, y: 5 });
      vs.moveTo(2, 1);
      expect(vs.flush()).toBe('\x1b[3D\x1b[4A');
      expect(vs.cursor).toEqual({ x: 2, y: 1 });
    });
    it('目标已在当前位置 → 不发任何指令', () => {
      const vs = new VirtualScreen({ x: 3, y: 3 });
      vs.moveTo(3, 3);
      expect(vs.flush()).toBe('');
    });
    it('连续 moveTo 累积指令、坐标正确', () => {
      const vs = new VirtualScreen();
      vs.moveTo(2, 0);  // 右 2
      vs.moveTo(2, 5);  // 下 5
      vs.moveTo(0, 5);  // 左 2
      expect(vs.cursor).toEqual({ x: 0, y: 5 });
      expect(vs.flush()).toBe('\x1b[2C\x1b[5B\x1b[2D');
    });
    it('绝不发绝对坐标（CUP \\x1b[r;cH 不应出现）', () => {
      const vs = new VirtualScreen();
      vs.moveTo(10, 10);
      const out = vs.flush();
      // eslint-disable-next-line no-control-regex
      expect(out).not.toMatch(/\x1b\[\d+;\d+H/);
    });
  });

  describe('writeCell —— 写一格并推进光标', () => {
    it('写入字符 + 样式，光标右移 1', () => {
      const vs = new VirtualScreen();
      vs.moveTo(0, 0);
      vs.writeCell(makeCell('A', { fg: 'red' }));
      const out = vs.flush();
      expect(out).toContain('A');
      expect(out).toContain('\x1b[31m'); // fg red
      expect(out).toContain('\x1b[0m');   // reset
      expect(vs.cursor.x).toBe(1);
    });
    it('宽字符写入后光标右移 2', () => {
      const vs = new VirtualScreen();
      vs.writeCell(makeCell('中', {}));
      expect(vs.cursor.x).toBe(2);
    });
    it('同位置连写两个 cell：第二条发"右1"相对移动再写', () => {
      const vs = new VirtualScreen();
      vs.writeCell(makeCell('A', {}));
      vs.writeCell(makeCell('B', {}));
      const out = vs.flush();
      // 第二次写前光标已在 x=1，无需再 moveTo
      expect(out).toContain('A');
      expect(out).toContain('B');
    });
    it('无样式字符不包 SGR', () => {
      const vs = new VirtualScreen();
      vs.writeCell(makeCell('X', {}));
      const out = vs.flush();
      expect(out).not.toContain('\x1b[');
    });
  });

  describe('flush 与累积', () => {
    it('flush 后清空缓冲但光标坐标保留，后续从当前坐标继续累积', () => {
      const vs = new VirtualScreen();
      vs.moveTo(1, 0);
      const a = vs.flush();
      expect(a).toBe('\x1b[1C');
      expect(vs.cursor).toEqual({ x: 1, y: 0 });
      // 光标已在 (1,0)，再 moveTo(2,0) → 又右 1
      vs.moveTo(2, 0);
      const b = vs.flush();
      expect(b).toBe('\x1b[1C');
    });
    it('toString 等价于 flush 但不清空', () => {
      const vs = new VirtualScreen();
      vs.moveTo(1, 0);
      expect(vs.toString()).toBe('\x1b[1C');
      // toString 不清空
      expect(vs.toString()).toBe('\x1b[1C');
    });
  });

  describe('eraseLine —— 擦当前行（先回到行首再擦）', () => {
    it('在行中调用：发 \\r + eraseLine，光标 x 归 0', () => {
      const vs = new VirtualScreen({ x: 5, y: 2 });
      vs.eraseLine();
      const out = vs.flush();
      expect(out).toBe('\r\x1b[2K');
      expect(vs.cursor.x).toBe(0);
      expect(vs.cursor.y).toBe(2);
    });
  });

  describe('lineFeed —— 屏幕相对钳位（alt screen 模式）', () => {
    it('默认无 rows 限制：lineFeed 持续增 y（兼容旧行为）', () => {
      const vs = new VirtualScreen();
      for (let i = 0; i < 100; i++) vs.lineFeed();
      expect(vs.cursor.y).toBe(100);
      expect(vs.cursor.x).toBe(0);
    });

    it('指定 rows=5：y 增到 4（rows-1）后不再增（屏幕相对，物理光标钉底）', () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 5);
      for (let i = 0; i < 10; i++) vs.lineFeed();
      expect(vs.cursor.y).toBe(4); // 钳位在 rows-1，不脱钩
    });

    it('指定 rows=5：从 y=2 起 lineFeed，到 y=4 停', () => {
      const vs = new VirtualScreen({ x: 0, y: 2 }, 5);
      vs.lineFeed(); // y=3
      vs.lineFeed(); // y=4
      vs.lineFeed(); // 钳位：仍 y=4
      vs.lineFeed(); // 钳位：仍 y=4
      expect(vs.cursor.y).toBe(4);
    });

    it('rows=1（极小屏）：lineFeed 不增 y', () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 1);
      vs.lineFeed();
      expect(vs.cursor.y).toBe(0);
    });

    it('lineFeed 仍发 CR+LF 字节（触发终端滚动），只是 cursor.y 不增', () => {
      const vs = new VirtualScreen({ x: 0, y: 4 }, 5);
      vs.lineFeed();
      const out = vs.flush();
      expect(out).toBe('\r\n');
      expect(vs.cursor.y).toBe(4); // 钳位
    });
  });

  describe('reset —— 重置光标与缓冲', () => {
    it('清空缓冲并把光标设回指定点', () => {
      const vs = new VirtualScreen({ x: 9, y: 9 });
      vs.moveTo(1, 1);
      vs.reset({ x: 0, y: 0 });
      expect(vs.cursor).toEqual({ x: 0, y: 0 });
      expect(vs.flush()).toBe('');
    });
  });
});
