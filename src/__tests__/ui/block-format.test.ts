// src/__tests__/ui/block-format.test.ts
// 统一块格式化契约的纯函数测试

import { describe, it, expect } from 'vitest';
import {
  formatToolCallDisplay,
  computeEditDiff,
  computeWriteDiff,
  summarizeOutput,
  formatThinkingSummary,
  buildToolResultBlock,
} from '../../ui/block-format.js';

describe('block-format', () => {
  // ─────────────── formatToolCallDisplay ───────────────
  describe('formatToolCallDisplay', () => {
    it('run_bash → Bash(command)', () => {
      expect(formatToolCallDisplay('run_bash', { command: 'npm test' })).toBe('Bash(npm test)');
    });

    it('edit_file → Update(path)', () => {
      expect(formatToolCallDisplay('edit_file', { path: 'src/index.ts' })).toBe('Update(src/index.ts)');
    });

    it('write_file → Write(path)', () => {
      expect(formatToolCallDisplay('write_file', { path: 'src/new.ts' })).toBe('Write(src/new.ts)');
    });

    it('read_file → Read(path)', () => {
      expect(formatToolCallDisplay('read_file', { path: 'README.md' })).toBe('Read(README.md)');
    });

    it('其他工具 → Name(关键参数)，截断到 60 字符', () => {
      const result = formatToolCallDisplay('memory_write', { key: 'k', value: 'v' });
      expect(result).toBe('memory_write({"key":"k","value":"v"})');
    });

    it('超长命令截断到 60 字符（保留括号结构，参数部分以 … 收尾）', () => {
      const longCmd = 'x'.repeat(200);
      const result = formatToolCallDisplay('run_bash', { command: longCmd });
      // 视觉平衡：保留 Bash( … ) 结构，括号闭合
      expect(result.endsWith(')')).toBe(true);
      // 长度受控（≤ 60）
      expect(result.length).toBeLessThanOrEqual(60);
      expect(result.length).toBeLessThan(longCmd.length);
      // 含截断标记
      expect(result).toContain('…');
    });

    it('input 为空对象时只显示 Name', () => {
      expect(formatToolCallDisplay('todo_write', {})).toBe('todo_write');
    });

    it('input 为 undefined 时只显示 Name', () => {
      expect(formatToolCallDisplay('todo_write', undefined as unknown as Record<string, unknown>)).toBe('todo_write');
    });
  });

  // ─────────────── computeEditDiff ───────────────
  describe('computeEditDiff', () => {
    it('纯新增行', () => {
      expect(computeEditDiff('a', 'a\nb\nc')).toEqual({ added: 2, removed: 0 });
    });

    it('纯删除行', () => {
      expect(computeEditDiff('a\nb\nc', 'a')).toEqual({ added: 0, removed: 2 });
    });

    it('替换行', () => {
      expect(computeEditDiff('a\nb', 'a\nc')).toEqual({ added: 1, removed: 1 });
    });

    it('无变化', () => {
      expect(computeEditDiff('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
    });

    it('空 old_text → 全部算新增', () => {
      expect(computeEditDiff('', 'a\nb\nc')).toEqual({ added: 3, removed: 0 });
    });

    it('空 new_text → 全部算删除', () => {
      expect(computeEditDiff('a\nb', '')).toEqual({ added: 0, removed: 2 });
    });
  });

  // ─────────────── computeWriteDiff ───────────────
  describe('computeWriteDiff', () => {
    it('新文件（oldContent 为 undefined）→ 全部新增', () => {
      expect(computeWriteDiff(undefined, 'a\nb\nc')).toEqual({ added: 3, removed: 0 });
    });

    it('覆盖文件 → 按行 diff', () => {
      expect(computeWriteDiff('a\nb', 'a\nc\nd')).toEqual({ added: 2, removed: 1 });
    });

    it('内容相同 → 0 变化', () => {
      expect(computeWriteDiff('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
    });
  });

  // ─────────────── summarizeOutput ───────────────
  describe('summarizeOutput', () => {
    it('短输出 → 完整返回，不截断', () => {
      const out = summarizeOutput('line1\nline2', 5);
      expect(out.preview).toBe('line1\nline2');
      expect(out.totalLines).toBe(2);
      expect(out.truncated).toBe(false);
    });

    it('长输出 → 截断到 maxLines，truncated=true', () => {
      const raw = 'l1\nl2\nl3\nl4\nl5\nl6\nl7';
      const out = summarizeOutput(raw, 3);
      expect(out.preview.split('\n').length).toBe(3);
      expect(out.totalLines).toBe(7);
      expect(out.truncated).toBe(true);
    });

    it('空输出 → preview 空，0 行，不截断', () => {
      const out = summarizeOutput('', 5);
      expect(out.preview).toBe('');
      expect(out.totalLines).toBe(0);
      expect(out.truncated).toBe(false);
    });

    it('尾部空白行不计入 totalLines', () => {
      const out = summarizeOutput('a\nb\n\n\n', 5);
      expect(out.totalLines).toBe(2);
    });
  });

  // ─────────────── formatThinkingSummary ───────────────
  describe('formatThinkingSummary', () => {
    it('带 duration + filesRead', () => {
      expect(formatThinkingSummary(17, 2)).toBe('Thought for 17s, read 2 files (ctrl+o to expand)');
    });

    it('单数 file', () => {
      expect(formatThinkingSummary(5, 1)).toBe('Thought for 5s, read 1 file (ctrl+o to expand)');
    });

    it('无 filesRead', () => {
      expect(formatThinkingSummary(5, 0)).toBe('Thought for 5s (ctrl+o to expand)');
    });

    it('duration 为 0 也正常输出', () => {
      expect(formatThinkingSummary(0, 0)).toBe('Thought for 0s (ctrl+o to expand)');
    });
  });

  // ─────────────── buildToolResultBlock ───────────────
  describe('buildToolResultBlock', () => {
    it('edit_file → 算 +N/-M 行数', () => {
      const result = buildToolResultBlock('edit_file', {
        path: 'src/a.ts',
        old_text: 'line1\nline2',
        new_text: 'line1\nline3\nline4',
      }, 'File edited: src/a.ts');
      expect(result.linesAdded).toBe(2);
      expect(result.linesRemoved).toBe(1);
      expect(result.filePath).toBe('src/a.ts');
      expect(result.rawOutput).toBeUndefined();
    });

    it('write_file → 算行数（旧内容未知当全新增）', () => {
      const result = buildToolResultBlock('write_file', {
        path: 'src/new.ts',
        content: 'a\nb\nc',
      }, 'File written: src/new.ts');
      expect(result.linesAdded).toBe(3);
      expect(result.linesRemoved).toBe(0);
      expect(result.filePath).toBe('src/new.ts');
    });

    it('run_bash → 传 rawOutput（不计算行数）', () => {
      const result = buildToolResultBlock('run_bash', {
        command: 'npm test',
      }, '> vitest\n✓ 10 tests');
      expect(result.rawOutput).toBe('> vitest\n✓ 10 tests');
      expect(result.linesAdded).toBeUndefined();
      expect(result.linesRemoved).toBeUndefined();
    });

    it('未知工具 → 传 rawOutput', () => {
      const result = buildToolResultBlock('memory_write', {
        key: 'k', value: 'v',
      }, 'ok');
      expect(result.rawOutput).toBe('ok');
    });

    it('edit_file 但 input 为 undefined → 退化传 rawOutput', () => {
      const result = buildToolResultBlock('edit_file', undefined, 'some output');
      expect(result.rawOutput).toBe('some output');
      expect(result.linesAdded).toBeUndefined();
    });
  });
});
