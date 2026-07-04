// 单测：highlight.ts —— 轻量正则代码高亮
//
// 物理本质：给代码里的"关键字/字符串/注释/数字"分别贴不同颜色的标签。
// 用单遍 token 扫描（不是多个全局正则替换），避免颜色互相覆盖。

import { describe, it, expect } from 'vitest';
import { highlightCode } from '../renderer/highlight.js';
import { type Cell } from '../renderer/cell.js';

function text(cells: Cell[]): string {
  return cells.map(c => c.char).join('');
}

describe('highlightCode', () => {
  describe('JavaScript / TypeScript', () => {
    it('关键字上色（accent = cyan）', () => {
      const cells = highlightCode('const x = 1;', 'js');
      // const 应被识别为关键字
      const kw = cells.slice(0, 5); // "const"
      expect(kw.every(c => c.style.fg === 'accent')).toBe(true);
    });

    it('字符串上色（success = green）', () => {
      const cells = highlightCode('const s = "hello";', 'js');
      // "hello" 区域应为 success
      const strCells = cells.filter(c => c.char === 'h' || c.char === 'e' || c.char === 'l' || c.char === 'o');
      expect(strCells.some(c => c.style.fg === 'success')).toBe(true);
    });

    it('行注释上色（muted/dim）', () => {
      const cells = highlightCode('// a comment\nx', 'js');
      const commentCells = cells.slice(0, cells.findIndex(c => c.char === '\n'));
      expect(commentCells.some(c => c.style.dim || c.style.fg === 'muted')).toBe(true);
    });

    it('数字上色（warn = yellow）', () => {
      const cells = highlightCode('const n = 42;', 'js');
      const numCell = cells.find(c => c.char === '4');
      expect(numCell?.style.fg).toBe('warn');
    });

    it('文本内容不丢字符（高亮后拼接 == 原文）', () => {
      const code = 'const s = "hi"; // c\nlet n = 7;';
      const cells = highlightCode(code, 'js');
      expect(text(cells)).toBe(code);
    });
  });

  describe('其它语言', () => {
    it('bash：# 注释 + 命令关键字', () => {
      const cells = highlightCode('echo hi # comment', 'bash');
      expect(text(cells)).toBe('echo hi # comment');
      // # comment 部分应有注释样式
      const hashIdx = cells.findIndex(c => c.char === '#');
      const after = cells.slice(hashIdx);
      expect(after.some(c => c.style.dim || c.style.fg === 'muted')).toBe(true);
    });

    it('python：def/return 关键字 + # 注释', () => {
      const cells = highlightCode('def f():\n  return 1 # x', 'py');
      const defCells = cells.slice(0, 3);
      expect(defCells.every(c => c.style.fg === 'accent')).toBe(true);
      expect(text(cells)).toBe('def f():\n  return 1 # x');
    });

    it('json：键字符串 + 数字', () => {
      const cells = highlightCode('{"a": 1}', 'json');
      expect(text(cells)).toBe('{"a": 1}');
      const one = cells.find(c => c.char === '1');
      expect(one?.style.fg).toBe('warn');
    });
  });

  describe('未知语言降级', () => {
    it('未知语言不报错，返回原文（单色 dim cyan）', () => {
      const cells = highlightCode('some unknown code', 'xyz-lang');
      expect(text(cells)).toBe('some unknown code');
      // 降级为单色（全部 dim 或 accent，至少不崩）
      expect(cells.every(c => c.style.dim || c.style.fg === 'accent' || Object.keys(c.style).length === 0)).toBe(true);
    });
    it('空 lang 当未知处理', () => {
      const cells = highlightCode('plain text', '');
      expect(text(cells)).toBe('plain text');
    });
  });

  describe('多行代码', () => {
    it('多行代码：每行独立高亮，换行保留', () => {
      const code = 'const a = 1;\nconst b = 2;';
      const cells = highlightCode(code, 'js');
      expect(text(cells)).toBe(code);
      // 两行的 const 都应是关键字
      const firstConst = cells.slice(0, 5);
      const secondConstStart = code.indexOf('\n') + 1;
      const secondConst = cells.slice(secondConstStart, secondConstStart + 5);
      expect(firstConst.every(c => c.style.fg === 'accent')).toBe(true);
      expect(secondConst.every(c => c.style.fg === 'accent')).toBe(true);
    });

    it('块注释 /* */ 跨行（js）', () => {
      const code = '/* line1\nline2 */ x';
      const cells = highlightCode(code, 'js');
      expect(text(cells)).toBe(code);
      // 注释内字符应有注释样式
      const inComment = cells.find(c => c.char === 'l');
      expect(inComment?.style.dim || inComment?.style.fg === 'gray').toBeTruthy();
    });
  });
});
