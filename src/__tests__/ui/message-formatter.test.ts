import { describe, it, expect } from 'vitest';
import { MessageFormatter } from '../../ui/message-formatter.js';

describe('MessageFormatter', () => {
  describe('format', () => {
    it('should format thinking with purple dot', () => {
      const lines = MessageFormatter.format('thinking', {});
      expect(lines[0].content).toBe('● Thinking…');
      expect(lines[0].style.fg).toBe('magenta');
      expect(lines[0].indent).toBe(0);
    });

    it('should format thinking_content with 2-space indent', () => {
      const lines = MessageFormatter.format('thinking_content', {}, '用户问"你是谁？"');
      expect(lines[0].content).toBe('  用户问"你是谁？"');
      expect(lines[0].indent).toBe(2);
      expect(lines[0].style.dim).toBe(true);
    });

    it('should format thinking_end with duration', () => {
      const lines = MessageFormatter.format('thinking_end', { duration: 17, filesRead: 2 });
      expect(lines[0].content).toBe('  Thought for 17s, read 2 files (ctrl+o to expand)');
      expect(lines[0].style.dim).toBe(true);
      expect(lines[0].indent).toBe(2);
    });

    it('should format thinking_end without filesRead', () => {
      const lines = MessageFormatter.format('thinking_end', { duration: 5 });
      expect(lines[0].content).toBe('  Thought for 5s (ctrl+o to expand)');
    });

    it('should format assistant with purple dot', () => {
      const lines = MessageFormatter.format('assistant', {}, '**我是一个AI助手**');
      expect(lines[0].content).toBe('● **我是一个AI助手**');
      expect(lines[0].style.fg).toBe('magenta');
    });

    it('should format tool_call with name and args', () => {
      const lines = MessageFormatter.format('tool_call', { toolName: 'Bash', toolArgs: 'cd ...' });
      expect(lines[0].content).toBe('● Bash(cd ...)');
      expect(lines[0].style.fg).toBe('magenta');
    });

    it('should format tool_call without args', () => {
      const lines = MessageFormatter.format('tool_call', { toolName: 'read_file' });
      expect(lines[0].content).toBe('● read_file');
    });

    it('should format tool_result with lines', () => {
      const lines = MessageFormatter.format('tool_result', { linesAdded: 2, linesRemoved: 1 });
      expect(lines[0].content).toBe('  ⎿  Added 2 lines, removed 1 line');
      expect(lines[0].indent).toBe(2);
      expect(lines[0].style.dim).toBe(true);
    });

    it('should format tool_result Done', () => {
      const lines = MessageFormatter.format('tool_result', {});
      expect(lines[0].content).toBe('  ⎿  Done');
    });

    it('should format tool_output', () => {
      const lines = MessageFormatter.format('tool_output', { output: '> npm test ...' });
      expect(lines[0].content).toBe('  ⎿  > npm test ...');
      expect(lines[0].indent).toBe(2);
    });

    it('should format permission', () => {
      const lines = MessageFormatter.format('permission', { permission: 'Allowed by auto mode classifier' });
      expect(lines[0].content).toBe('  ⎿  Allowed by auto mode classifier');
      expect(lines[0].indent).toBe(2);
    });

    it('should format system', () => {
      const lines = MessageFormatter.format('system', {}, '[Hook] Session started');
      expect(lines[0].content).toBe('[Hook] Session started');
      expect(lines[0].indent).toBe(0);
    });

    it('should format error with red color', () => {
      const lines = MessageFormatter.format('error', {}, '[Error] No API Key');
      expect(lines[0].content).toBe('[Error] No API Key');
      expect(lines[0].style.fg).toBe('red');
    });

    it('should format input with green bold', () => {
      const lines = MessageFormatter.format('input', {}, '你是谁？');
      expect(lines[0].content).toBe('❯ 你是谁？');
      expect(lines[0].style.fg).toBe('green');
      expect(lines[0].style.bold).toBe(true);
    });
  });
});
