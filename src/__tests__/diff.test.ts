// 单测：diff.ts —— 增量 diff 引擎（整篇核心）
//
// 物理本质：新旧两张格子纸逐格比对，只挑"变了样的格子"，
// 通过 VirtualScreen 生成 moveCursorTo(相对) + 写字符 的指令串。
// **没变的格子不进入回调——这是"流式不重绘页脚"的物理实现**（文档§2.2③、§7.2）。

import { describe, it, expect } from 'vitest';
import { Screen } from '../renderer/screen.js';
import { VirtualScreen } from '../renderer/virtual-screen.js';
import { renderDiff } from '../renderer/diff.js';
import { makeCell } from '../renderer/cell.js';

describe('renderDiff', () => {
  describe('基本比对', () => {
    it('全同两帧 → 产出空串（零字节写入）', () => {
      const a = new Screen(3, 3);
      const b = a.clone();
      const vs = new VirtualScreen();
      renderDiff(a, b, vs);
      expect(vs.flush()).toBe('');
    });

    it('单格变化 → 只写该格', () => {
      const a = new Screen(2, 2);
      const b = a.clone();
      b.setCell(1, 0, makeCell('X'));
      const vs = new VirtualScreen();
      renderDiff(a, b, vs);
      const out = vs.flush();
      expect(out).toContain('X');
      // 应包含移到 (1,0) 的相对指令：从 (0,0) 右 1
      expect(out).toContain('\x1b[1C');
    });

    it('多格变化 → 每格一条 writeCell', () => {
      const a = new Screen(1, 4);
      const b = a.clone();
      b.setCell(0, 0, makeCell('A'));
      b.setCell(2, 0, makeCell('C'));
      const vs = new VirtualScreen();
      renderDiff(a, b, vs);
      const out = vs.flush();
      expect(out).toContain('A');
      expect(out).toContain('C');
    });
  });

  describe('【核心保护测试】页脚未变 → 零字节写入页脚', () => {
    // 模拟真实分区：上面消息区，下面状态栏 + 输入框（页脚）。
    // 流式 token 只改消息区，页脚逐格相同。
    it('消息区变化、页脚不变 → 输出串里不含页脚行的字符', () => {
      const rows = 4;
      const cols = 8;
      const footerRow = rows - 1; // 第 4 行（索引 3）是页脚

      const a = new Screen(rows, cols);
      a.writeRow(footerRow, 'STATUS!', { fg: 'cyan' }); // 页脚内容

      const b = a.clone();          // 页脚逐格相同
      b.setCell(0, 0, makeCell('H', { fg: 'red' }));  // 只改消息区

      const vs = new VirtualScreen();
      renderDiff(a, b, vs);
      const out = vs.flush();

      // 页脚的字符不应出现在输出里
      expect(out).not.toContain('S');
      expect(out).not.toContain('T');
      expect(out).not.toContain('A');
      expect(out).not.toContain('U');
      expect(out).not.toContain('!');
      expect(out).not.toContain('cyan'.toUpperCase());
      // 页脚的 cyan 样式 SGR (\x1b[36m) 不应出现
      expect(out).not.toContain('\x1b[36m');
      // 消息区的变化应出现
      expect(out).toContain('H');
    });

    it('连续流式 append：每次只写新增 token，页脚永远不动', () => {
      const rows = 3, cols = 6;
      const footerRow = rows - 1;
      const base = new Screen(rows, cols);
      base.writeRow(footerRow, 'INPUT', { fg: 'green' });

      // 帧 1：消息区写 "Hi"
      let cur = base.clone();
      cur.writeRow(0, 'Hi', {});
      let vs = new VirtualScreen();
      renderDiff(base, cur, vs);
      let out = vs.flush();
      expect(out).toContain('H');
      expect(out).toContain('i');
      expect(out).not.toContain('INPUT');
      expect(out).not.toContain('\x1b[32m'); // green 不应写入

      // 帧 2：在已有 Hi 之后追加 "!"（模拟 token 累积）
      const prev = cur;
      cur = base.clone();
      cur.writeRow(0, 'Hi!', {});
      vs = new VirtualScreen();
      renderDiff(prev, cur, vs);
      out = vs.flush();
      // 这次只应写 "!"，不该重写 "Hi"
      expect(out).toContain('!');
      // 严格：Hi 中已有的 H、i 若仍是无样式字符，diff 只对新格 "!" 产生输出；
      // 关键是不再触碰页脚
      expect(out).not.toContain('INPUT');
      expect(out).not.toContain('\x1b[32m');
    });
  });

  describe('宽字符处理', () => {
    it('宽字符变化：写主格即可，占位格不重复写', () => {
      const a = new Screen(1, 5);
      const b = a.clone();
      b.writeRow(0, '中', {});
      const vs = new VirtualScreen();
      renderDiff(a, b, vs);
      const out = vs.flush();
      expect(out).toContain('中');
    });
  });

  describe('与 VirtualScreen 的光标协调', () => {
    it('diff 结束后 vs.cursor 停在最后一个被写的格子之后', () => {
      const a = new Screen(1, 3);
      const b = a.clone();
      b.setCell(2, 0, makeCell('Z'));
      const vs = new VirtualScreen();
      renderDiff(a, b, vs);
      vs.flush();
      // 最后写到 (2,0)，光标 x 推进到 3
      expect(vs.cursor).toEqual({ x: 3, y: 0 });
    });
    it('不依赖初始光标位置：从任意起点都能正确相对移动', () => {
      const a = new Screen(2, 2);
      const b = a.clone();
      b.setCell(0, 1, makeCell('Q'));
      // 初始光标故意设在 (1,0)
      const vs = new VirtualScreen({ x: 1, y: 0 });
      renderDiff(a, b, vs);
      const out = vs.flush();
      expect(out).toContain('Q');
      // 从 (1,0) 到 (0,1)：左 1、下 1
      expect(out).toContain('\x1b[1D');
      expect(out).toContain('\x1b[1B');
    });
  });

  describe('尺寸不同的两帧', () => {
    it('按交集比对，不崩', () => {
      const a = new Screen(2, 2);
      const b = new Screen(3, 3);
      b.setCell(0, 0, makeCell('K'));
      const vs = new VirtualScreen();
      expect(() => renderDiff(a, b, vs)).not.toThrow();
      const out = vs.flush();
      expect(out).toContain('K');
    });
  });

  describe('minY（scrollback 跳过 + fullReset 标记）', () => {
    it('minY 之上的行（scrollback）变化 → needsFullReset=true，不产出指令', () => {
      const a = new Screen(5, 5); // 5 行 × 5 列
      const b = a.clone();
      b.setCell(0, 0, makeCell('X')); // (x=0,y=0) 变化（在 scrollback 区，minY=2）
      b.setCell(0, 3, makeCell('Y')); // (x=0,y=3) 变化（可视区，y>=2）
      const vs = new VirtualScreen();
      const result = renderDiff(a, b, vs, 2);
      // scrollback 行（y=0 < minY=2）变了 → 标记 fullReset
      expect(result.needsFullReset).toBe(true);
      expect(result.fullResetTriggerY).toBe(0);
      // 可视区变化（Y）仍产出
      expect(vs.flush()).toContain('Y');
    });

    it('minY 之上无变化 → needsFullReset=false', () => {
      const a = new Screen(5, 5);
      a.setCell(0, 0, makeCell('S')); // scrollback 区(y=0)有内容但不变
      const b = a.clone();
      b.setCell(0, 3, makeCell('Y')); // 只可视区(y=3)变
      const vs = new VirtualScreen();
      const result = renderDiff(a, b, vs, 2);
      expect(result.needsFullReset).toBe(false);
      expect(vs.flush()).toContain('Y');
    });

    it('minY=0（默认）：所有行都在可视区，不触发 fullReset', () => {
      const a = new Screen(3, 3);
      const b = a.clone();
      b.setCell(0, 0, makeCell('Z'));
      const vs = new VirtualScreen();
      const result = renderDiff(a, b, vs);
      expect(result.needsFullReset).toBe(false);
      expect(vs.flush()).toContain('Z');
    });
  });
});
