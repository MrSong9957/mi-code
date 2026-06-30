// src/__tests__/ui/message-formatter.test.ts
// MessageFormatter 测试（已接入 block-format 统一契约）

import { describe, it, expect } from 'vitest';
import { MessageFormatter } from '../../ui/message-formatter.js';

describe('MessageFormatter', () => {
  describe('format', () => {
    it('thinking → ● Thinking… (magenta, indent 0)', () => {
      const lines = MessageFormatter.format('thinking', {});
      expect(lines[0].content).toBe('● Thinking…');
      expect(lines[0].style.fg).toBe('magenta');
      expect(lines[0].indent).toBe(0);
    });

    it('thinking_end → 委托 block-format.formatThinkingSummary', () => {
      const lines = MessageFormatter.format('thinking_end', { duration: 17, filesRead: 2 });
      expect(lines[0].content).toBe('Thought for 17s, read 2 files (ctrl+o to expand)');
      expect(lines[0].style.dim).toBe(true);
      expect(lines[0].indent).toBe(2);
    });

    it('thinking_end 无 filesRead', () => {
      const lines = MessageFormatter.format('thinking_end', { duration: 5 });
      expect(lines[0].content).toBe('Thought for 5s (ctrl+o to expand)');
    });

    it('assistant → ● + content (magenta)', () => {
      const lines = MessageFormatter.format('assistant', {}, '**我是一个AI助手**');
      expect(lines[0].content).toBe('● **我是一个AI助手**');
      expect(lines[0].style.fg).toBe('magenta');
    });

    // ─────────────── tool_call：从 toolInput 提取参数 ───────────────
    it('tool_call 用 toolInput 显示参数（run_bash → Bash(cmd)）', () => {
      const lines = MessageFormatter.format('tool_call', {
        toolName: 'run_bash',
        toolInput: { command: 'npm test' },
      });
      expect(lines[0].content).toBe('● Bash(npm test)');
      expect(lines[0].style.fg).toBe('magenta');
      expect(lines[0].indent).toBe(0);
    });

    it('tool_call 用 toolInput（edit_file → Update(path)）', () => {
      const lines = MessageFormatter.format('tool_call', {
        toolName: 'edit_file',
        toolInput: { path: 'src/index.ts' },
      });
      expect(lines[0].content).toBe('● Update(src/index.ts)');
    });

    it('tool_call 旧字段 toolArgs 仍兼容（当无 toolInput）', () => {
      const lines = MessageFormatter.format('tool_call', { toolName: 'Bash', toolArgs: 'cd ...' });
      expect(lines[0].content).toBe('● Bash(cd ...)');
    });

    it('tool_call 无参数时只显示 Name', () => {
      const lines = MessageFormatter.format('tool_call', { toolName: 'read_file' });
      expect(lines[0].content).toBe('● read_file');
    });

    // ─────────────── tool_result：多分支 ───────────────
    it('tool_result edit/write 有行数 → Added/removed', () => {
      const lines = MessageFormatter.format('tool_result', { linesAdded: 2, linesRemoved: 1 });
      expect(lines[0].content).toBe('⎿  Added 2 lines, removed 1 line');
      expect(lines[0].indent).toBe(2);
      expect(lines[0].style.dim).toBe(true);
    });

    it('tool_result edit 单数 line', () => {
      const lines = MessageFormatter.format('tool_result', { linesAdded: 1, linesRemoved: 0 });
      expect(lines[0].content).toBe('⎿  Added 1 line');
    });

    it('tool_result Bash 原始输出（短）→ 单行 preview', () => {
      const lines = MessageFormatter.format('tool_result', {
        toolName: 'run_bash',
        rawOutput: 'line1\nline2',
      });
      expect(lines.some(l => l.content.includes('⎿'))).toBe(true);
      expect(lines.some(l => l.content.includes('line1'))).toBe(true);
    });

    it('tool_result Bash 原始输出（长）→ preview + +N 行 折叠提示', () => {
      const lines = MessageFormatter.format('tool_result', {
        toolName: 'run_bash',
        rawOutput: 'l1\nl2\nl3\nl4\nl5\nl6\nl7',
      });
      // 应含截断提示
      const hasExpandHint = lines.some(l => l.content.includes('行') || l.content.includes('lines'));
      expect(hasExpandHint).toBe(true);
    });

    it('tool_result 无任何数据 → ⎿ Done 兜底', () => {
      const lines = MessageFormatter.format('tool_result', {});
      expect(lines[0].content).toBe('⎿  Done');
    });

    // ─────────────── 其他类型 ───────────────
    it('permission → ⎿ + 内容', () => {
      const lines = MessageFormatter.format('permission', { permission: 'Allowed by auto mode classifier' });
      expect(lines[0].content).toBe('⎿  Allowed by auto mode classifier');
      expect(lines[0].indent).toBe(2);
    });

    it('system', () => {
      const lines = MessageFormatter.format('system', {}, '[Hook] Session started');
      expect(lines[0].content).toBe('[Hook] Session started');
      expect(lines[0].indent).toBe(0);
    });

    it('error → red', () => {
      const lines = MessageFormatter.format('error', {}, '[Error] No API Key');
      expect(lines[0].content).toBe('[Error] No API Key');
      expect(lines[0].style.fg).toBe('red');
    });

    it('input → ❯ green bold', () => {
      const lines = MessageFormatter.format('input', {}, '你是谁？');
      expect(lines[0].content).toBe('❯ 你是谁？');
      expect(lines[0].style.fg).toBe('green');
      expect(lines[0].style.bold).toBe(true);
    });
  });
});
