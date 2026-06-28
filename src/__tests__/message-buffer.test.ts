// 单测：message-buffer.ts —— 消息存储 + 视口
//
// 物理本质：备用屏没有原生 scrollback，得自己管一叠"可以翻页的稿纸"。
// 消息存成"已折好行"的数组（每行带 cells + 样式）。视口 = 取最后 N 行。
// 新内容自动跟到底；超出部分滚出视口顶部。

import { describe, it, expect } from 'vitest';
import { MessageBuffer } from '../renderer/message-buffer.js';
import { stringToCells } from '../renderer/cell.js';

function rowFrom(text: string) {
  return { cells: stringToCells(text, {}), role: 'assistant' as const };
}

describe('MessageBuffer', () => {
  describe('push 与 viewport', () => {
    it('push 一行，viewport 取出该行', () => {
      const buf = new MessageBuffer();
      buf.push([{ cells: stringToCells('Hi', {}), role: 'assistant' }]);
      const vp = buf.viewport(5);
      expect(vp).toHaveLength(1);
    });

    it('push 超过 viewport 高度 → 取最后 N 行', () => {
      const buf = new MessageBuffer();
      buf.push([
        rowFrom('A'), rowFrom('B'), rowFrom('C'), rowFrom('D'), rowFrom('E'),
      ]);
      const vp = buf.viewport(3);
      expect(vp).toHaveLength(3);
      // 取最后 3 行：C D E
      expect(cellsText(vp[0]!)).toBe('C');
      expect(cellsText(vp[2]!)).toBe('E');
    });

    it('viewport 高度大于存量 → 返回全部实际行（不补空，对齐由渲染层处理）', () => {
      const buf = new MessageBuffer();
      buf.push([rowFrom('X')]);
      const vp = buf.viewport(4);
      expect(vp).toHaveLength(1);
      expect(cellsText(vp[0]!)).toBe('X');
    });
    it('viewportFit(h) → 按高度补齐前置空行（渲染层底部对齐用）', () => {
      const buf = new MessageBuffer();
      buf.push([rowFrom('X')]);
      const vp = buf.viewportFit(4);
      expect(vp).toHaveLength(4);
      // 最后一行是 X，前面 3 行空
      expect(cellsText(vp[3]!)).toBe('X');
    });
  });

  describe('自动滚到底', () => {
    it('新内容 push 后，viewport 自动跟到底', () => {
      const buf = new MessageBuffer();
      buf.push([rowFrom('first')]);
      buf.push([rowFrom('second')]);
      buf.push([rowFrom('third')]);
      const vp = buf.viewport(2);
      expect(cellsText(vp[1]!)).toBe('third');
    });
  });

  describe('appendText —— 流式 token 追加到最后一条消息', () => {
    it('空缓冲追加文本 → 新建一条消息', () => {
      const buf = new MessageBuffer();
      buf.appendText('Hello', 'assistant', {});
      const vp = buf.viewport(5);
      expect(vp).toHaveLength(1);
      expect(cellsText(vp[0]!)).toBe('Hello');
    });

    it('连续追加 → 累积进同一条消息', () => {
      const buf = new MessageBuffer();
      buf.appendText('Hel', 'assistant', {});
      buf.appendText('lo', 'assistant', {});
      buf.appendText('!', 'assistant', {});
      const vp = buf.viewport(5);
      expect(cellsText(vp[0]!)).toBe('Hello!');
    });

    it('不同 role 的追加 → 新建一条消息', () => {
      const buf = new MessageBuffer();
      buf.appendText('user1', 'user', {});
      buf.appendText('asst1', 'assistant', {});
      const vp = buf.viewport(5);
      expect(vp).toHaveLength(2);
      expect(cellsText(vp[0]!)).toBe('user1');
      expect(cellsText(vp[1]!)).toBe('asst1');
    });
  });

  describe('折行 wrap', () => {
    it('长文本按 cols 折成多行', () => {
      const buf = new MessageBuffer();
      buf.push([{ cells: stringToCells('ABCDEFGHIJ', {}), role: 'assistant' }], 5);
      const vp = buf.viewport(10);
      // 10 字符按宽度 5 折成 2 行
      expect(vp.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('clear', () => {
    it('清空后 viewport 全空', () => {
      const buf = new MessageBuffer();
      buf.push([rowFrom('A'), rowFrom('B')]);
      buf.clear();
      const vp = buf.viewport(5);
      expect(vp.every(r => cellsText(r).trim() === '')).toBe(true);
    });
  });

  describe('滚动控制', () => {
    it('默认 autoScroll=true，新内容跟到底', () => {
      const buf = new MessageBuffer();
      buf.push([rowFrom('1'), rowFrom('2'), rowFrom('3')]);
      const vp = buf.viewport(1);
      expect(cellsText(vp[0]!)).toBe('3');
    });
    it('行数计数正确', () => {
      const buf = new MessageBuffer();
      buf.push([rowFrom('a'), rowFrom('b'), rowFrom('c')]);
      expect(buf.lineCount).toBe(3);
    });
  });

  describe('手动滚动（scrollUp / scrollDown / isAtBottom / resetScroll）', () => {
    // 主屏行式模型：滚动交给终端原生 scrollback，buffer 不再自管滚动。
    // 这些 API 已移除，相关测试随之删除。
    it.skip('已移除：主屏用原生 scrollback', () => {});
  });
});

function cellsText(row: { cells: ReturnType<typeof stringToCells> }): string {
  return row.cells.map(c => c.char).join('');
}
