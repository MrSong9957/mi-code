// 单测：markdown.ts —— 轻量 Markdown→cells 解析器
//
// 物理本质：把 Markdown 源码（# 标题、**粗**、代码块等）翻译成"带样式的格子行"。
// 逐行状态机：代码围栏切换 code 状态；其余按行类型（标题/列表/引用/段落）解析，
// 段落行再做行内解析（粗/斜/行内代码/链接）。

import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../renderer/markdown.js';
import { type Cell } from '../renderer/cell.js';

function lineText(cells: Cell[]): string {
  return cells.map(c => c.char).join('');
}
/** 该行是否有任一 cell 满足样式条件 */
function hasStyle(cells: Cell[], pred: (s: Cell['style']) => boolean): boolean {
  return cells.some(c => pred(c.style));
}

describe('renderMarkdown', () => {
  describe('标题', () => {
    it('# 一级标题：bold + brand(cyan)，去掉 # 符号', () => {
      const lines = renderMarkdown('# Title');
      expect(lines).toHaveLength(1);
      expect(lineText(lines[0]!)).toBe('Title');
      expect(hasStyle(lines[0]!, s => s.bold === true && s.fg === 'brand')).toBe(true);
    });
    it('## 二级标题：bold + warning(yellow)', () => {
      const lines = renderMarkdown('## Sub');
      expect(lineText(lines[0]!)).toBe('Sub');
      expect(hasStyle(lines[0]!, s => s.bold === true && s.fg === 'warning')).toBe(true);
    });
    it('### 三级及以上：bold + success(green)', () => {
      const lines = renderMarkdown('### Deep');
      expect(lineText(lines[0]!)).toBe('Deep');
      expect(hasStyle(lines[0]!, s => s.bold === true && s.fg === 'success')).toBe(true);
    });
    it('# 后必须有空格才算标题（#word 不算）', () => {
      const lines = renderMarkdown('#word');
      expect(lineText(lines[0]!)).toBe('#word'); // 原样
    });
  });

  describe('行内标记', () => {
    it('**粗体** → bold，去掉 **', () => {
      const lines = renderMarkdown('this is **bold** text');
      expect(lineText(lines[0]!)).toBe('this is bold text');
      // 'b','o','l','d' 应是 bold
      const bCell = lines[0]!.find(c => c.char === 'b');
      expect(bCell?.style.bold).toBe(true);
    });
    it('*斜体* → italic，去掉 *', () => {
      const lines = renderMarkdown('a *italic* b');
      expect(lineText(lines[0]!)).toBe('a italic b');
      const iCell = lines[0]!.find(c => c.char === 'i');
      expect(iCell?.style.italic).toBe(true);
    });
    it('`行内代码` → fg warning(yellow)，去掉反引号', () => {
      const lines = renderMarkdown('use `map` here');
      expect(lineText(lines[0]!)).toBe('use map here');
      const mCell = lines[0]!.find(c => c.char === 'm');
      expect(mCell?.style.fg).toBe('warning');
    });
    it('混合行内标记', () => {
      const lines = renderMarkdown('**a** and `b` and *c*');
      expect(lineText(lines[0]!)).toBe('a and b and c');
    });
  });

  describe('代码块（围栏）', () => {
    it('```js 代码块：进入 code 状态，内容走高亮，围栏行不显示', () => {
      const md = '```js\nconst x = 1;\n```';
      const lines = renderMarkdown(md);
      // 围栏行应被吃掉（或显示为空/边框），代码内容保留
      const codeLine = lines.find(l => lineText(l).includes('const'));
      expect(codeLine).toBeDefined();
      expect(lineText(codeLine!)).toBe('const x = 1;');
      // const 应被高亮成关键字（codeKeyword bold）
      const cCell = codeLine!.find(c => c.char === 'c');
      expect(cCell?.style.fg).toBe('codeKeyword');
    });
    it('无 lang 的代码块也能渲染', () => {
      const md = '```\nplain code\n```';
      const lines = renderMarkdown(md);
      const codeLine = lines.find(l => lineText(l).includes('plain'));
      expect(lineText(codeLine!)).toBe('plain code');
    });
    it('代码块内的 # 不是标题', () => {
      const md = '```\n# not a title\n```';
      const lines = renderMarkdown(md);
      const line = lines.find(l => lineText(l).includes('not a title'));
      expect(lineText(line!)).toBe('# not a title'); // 原样
      // 且不是标题样式
      expect(hasStyle(line!, s => s.bold === true && s.fg === 'cyan')).toBe(false);
    });
  });

  describe('列表', () => {
    it('- 无序列表项：缩进 + 项目符号', () => {
      const lines = renderMarkdown('- item one\n- item two');
      expect(lines).toHaveLength(2);
      const t0 = lineText(lines[0]!);
      expect(t0).toContain('item one');
      // 应有项目符号（• 或 -）
      expect(t0.startsWith('•') || t0.includes('•') || t0.includes('-')).toBe(true);
    });
    it('1. 有序列表项：保留序号', () => {
      const lines = renderMarkdown('1. first\n2. second');
      expect(lineText(lines[0]!)).toContain('first');
      expect(lineText(lines[0]!)).toMatch(/1/);
      expect(lineText(lines[1]!)).toContain('second');
    });
  });

  describe('引用与分隔线', () => {
    it('> 引用：dim + 缩进 + 左侧标记', () => {
      const lines = renderMarkdown('> a quote');
      const t = lineText(lines[0]!);
      expect(t).toContain('a quote');
      expect(hasStyle(lines[0]!, s => s.dim === true)).toBe(true);
    });
    it('--- 分隔线：一行横线', () => {
      const lines = renderMarkdown('---');
      expect(lines).toHaveLength(1);
      const t = lineText(lines[0]!);
      expect(t.length).toBeGreaterThan(0);
      expect(t.split('').every(c => c === '─' || c === '-' || c === ' ')).toBe(true);
    });
  });

  describe('空行与普通段落', () => {
    it('空行 → 空 cells', () => {
      const lines = renderMarkdown('a\n\nb');
      // 中间应有空行
      expect(lines.some(l => l.length === 0)).toBe(true);
    });
    it('普通段落原样保留（去行内标记符号）', () => {
      const lines = renderMarkdown('just plain text');
      expect(lineText(lines[0]!)).toBe('just plain text');
    });
  });

  describe('多元素组合', () => {
    it('完整 Markdown 文档：标题 + 段落 + 代码块 + 列表', () => {
      const md = [
        '# Guide',
        '',
        'Some **bold** text.',
        '',
        '```js',
        'const x = 1;',
        '```',
        '',
        '- item',
      ].join('\n');
      const lines = renderMarkdown(md);
      // 应有多行，标题、代码、列表各自成型
      expect(lines.length).toBeGreaterThan(5);
      expect(lines.some(l => lineText(l) === 'Guide')).toBe(true);
      expect(lines.some(l => lineText(l).includes('const x = 1;'))).toBe(true);
      expect(lines.some(l => lineText(l).includes('item'))).toBe(true);
    });
  });

  describe('流式友好（未闭合标记）', () => {
    it('未闭合的 ** 不崩，按原始文本处理', () => {
      const lines = renderMarkdown('this is **unclosed');
      expect(lineText(lines[0]!)).toContain('unclosed');
    });
    it('未闭合的代码围栏（只有开头 ```）也能渲染已输入的内容', () => {
      const lines = renderMarkdown('```js\nconst x');
      // 不崩，const x 出现
      expect(lines.some(l => lineText(l).includes('const x'))).toBe(true);
    });
  });
});
