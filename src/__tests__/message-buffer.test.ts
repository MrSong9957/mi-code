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

  // ─────────────── 统一块格式：● 首行前缀 + 全体 2 空格缩进 ───────────────
  describe('setStreamingRows 块格式（hanging indent：首行 ● 第0列，续行 2 空格）', () => {
    it('首行 ● 在第 0 列（无缩进），续行 2 空格缩进', () => {
      const buf = new MessageBuffer();
      // 模拟 renderMarkdown 输出：两行段落
      const rows = [stringToCells('你好！', {}), stringToCells('我可以：', {})];
      buf.setStreamingRows(rows, { indent: 2, firstLinePrefix: '● ' });
      const vp = buf.viewport(5);
      expect(vp).toHaveLength(2);
      // 首行：'● 你好！'（● 在第 0 列，无缩进）
      expect(cellsText(vp[0]!)).toBe('● 你好！');
      // 续行：'  我可以：'（2 空格缩进，对齐到 ● 后内容）
      expect(cellsText(vp[1]!)).toBe('  我可以：');
    });

    it('无选项时保持原行为（向后兼容）', () => {
      const buf = new MessageBuffer();
      buf.setStreamingRows([stringToCells('纯文本', {})]);
      const vp = buf.viewport(5);
      expect(cellsText(vp[0]!)).toBe('纯文本');
    });

    it('空行段落保留空结构（不补缩进，避免段落间出现纯空格行）', () => {
      const buf = new MessageBuffer();
      const rows = [stringToCells('第一段', {}), [], stringToCells('第二段', {})];
      buf.setStreamingRows(rows, { indent: 2, firstLinePrefix: '● ' });
      const vp = buf.viewport(5);
      // 空行（renderMarkdown 对空行返回 []）保持空
      expect(cellsText(vp[1]!)).toBe('');
      // 空行后的段落仍是续行（2 空格缩进，不再加 ● 前缀）
      expect(cellsText(vp[2]!)).toBe('  第二段');
    });

    it('firstLineStyle 给前缀（●）着色（如 magenta）', () => {
      const buf = new MessageBuffer();
      buf.setStreamingRows(
        [stringToCells('内容', {})],
        { indent: 2, firstLinePrefix: '● ', firstLineStyle: { fg: 'magenta' } },
      );
      const vp = buf.viewport(5);
      const line = vp[0]!;
      // 找到 ● 那个 cell，断言它是 magenta
      const bullet = line.cells.find(c => c.char === '●');
      expect(bullet).toBeDefined();
      expect(bullet!.style.fg).toBe('magenta');
      // 内容 cell 不应被染成 magenta
      const content = line.cells.find(c => c.char === '内');
      expect(content!.style.fg).toBeUndefined();
    });
  });

  // ─────────────── 续行缩进：wrapCells 折行时保留缩进 ───────────────
  describe('wrapCells 续行缩进（hangingIndent）', () => {
    it('软换行的续行也带 2 空格缩进（不顶到 0 列）；首行 ● 仍在第 0 列', () => {
      const buf = new MessageBuffer(10); // wrapCols=10
      // 一行长文本，会被折成多行
      buf.setStreamingRows(
        [stringToCells('ABCDEFGHIJ KLMNOP', {})],
        { indent: 2, firstLinePrefix: '● ' },
      );
      const vp = buf.viewport(5);
      expect(vp.length).toBeGreaterThanOrEqual(2);
      // 首行：● 在第 0 列（无缩进）
      expect(cellsText(vp[0]!).startsWith('● ')).toBe(true);
      expect(cellsText(vp[0]!).startsWith('  ●')).toBe(false);
      // 续行：2 空格开头（不是顶到 0 列）
      expect(cellsText(vp[1]!).startsWith('  ')).toBe(true);
    });
  });
});

function cellsText(row: { cells: ReturnType<typeof stringToCells> }): string {
  return row.cells.map(c => c.char).join('');
}
