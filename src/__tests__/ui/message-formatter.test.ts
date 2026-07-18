// src/__tests__/ui/message-formatter.test.ts
// MessageFormatter 测试（已接入 block-format 统一契约）

import { describe, it, expect } from 'vitest';
import { MessageFormatter } from '../../ui/message-formatter.js';

describe('MessageFormatter', () => {
  describe('format', () => {
    it('thinking → ● Thinking… (magenta, indent 0)', () => {
      const lines = MessageFormatter.format('thinking', {});
      expect(lines[0].content).toBe('● Thinking…');
      expect(lines[0].style.fg).toBe('brand');
      expect(lines[0].indent).toBe(0);
    });

    it('thinking_end → 委托 block-format.formatThinkingSummary（2 空格缩进烤进 content）', () => {
      const lines = MessageFormatter.format('thinking_end', { duration: 17, filesRead: 2 });
      expect(lines[0].content).toBe('  thought for 17s, read 2 files (ctrl+o to expand)');
      expect(lines[0].style.dim).toBe(true);
      expect(lines[0].indent).toBe(2);
    });

    it('thinking_end 无 filesRead', () => {
      const lines = MessageFormatter.format('thinking_end', { duration: 5 });
      expect(lines[0].content).toBe('  thought for 5s (ctrl+o to expand)');
    });

    it('assistant → ● + content (magenta)', () => {
      const lines = MessageFormatter.format('assistant', {}, '**我是一个AI助手**');
      expect(lines[0].content).toBe('● **我是一个AI助手**');
      expect(lines[0].style.fg).toBe('brand');
    });

    // ─────────────── tool_call：从 toolInput 提取参数 ───────────────
    it('tool_call 用 toolInput 显示参数（run_bash → Bash(cmd)）', () => {
      const lines = MessageFormatter.format('tool_call', {
        toolName: 'run_bash',
        toolInput: { command: 'npm test' },
      });
      expect(lines[0].content).toBe('● Bash(npm test)');
      expect(lines[0].style.fg).toBe('brand');
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
      expect(lines[0].style.fg).toBe('error');
    });

    it('input → ❯ green bold', () => {
      const lines = MessageFormatter.format('input', {}, '你是谁？');
      expect(lines[0].content).toBe('❯ 你是谁？');
      expect(lines[0].style.fg).toBe('success');
      expect(lines[0].style.bold).toBe(true);
    });

    // ─────────────── input 多行：按 \n 拆成多条 FormattedLine ───────────────
    // 回归：含 \n 的 input 被塞进单条 FormattedLine 会导致渲染层 footerHeight
    // 账本错乱（content 内的 \n 提前断行，但账本只记 1 行 → 下一帧覆写丢失前面行）。
    // 修复：format('input') 按 \n 拆成多条，首行带 ❯，续行无前缀同色。
    it('input 多行 → 按行数返回多条 FormattedLine', () => {
      const lines = MessageFormatter.format('input', {}, '第一行\n第二行\n第三行');
      expect(lines.length).toBe(3);
    });

    it('input 多行首行带 ❯ 前缀，续行无前缀', () => {
      const lines = MessageFormatter.format('input', {}, '第一行\n第二行\n第三行');
      expect(lines[0].content).toBe('❯ 第一行');
      expect(lines[1].content).toBe('第二行');
      expect(lines[2].content).toBe('第三行');
    });

    it('input 多行所有行同样式（greenBold, indent 0）', () => {
      const lines = MessageFormatter.format('input', {}, '第一行\n第二行');
      for (const line of lines) {
        expect(line.style.fg).toBe('success');
        expect(line.style.bold).toBe(true);
        expect(line.indent).toBe(0);
      }
    });

    it('input 连续 \\n 产生空行 FormattedLine（content 为空）', () => {
      // 空行必须保留为独立 FormattedLine（content: ''），否则行数对不上 + 渲染错位
      const lines = MessageFormatter.format('input', {}, '第一行\n\n第三行');
      expect(lines.length).toBe(3);
      expect(lines[0].content).toBe('❯ 第一行');
      expect(lines[1].content).toBe('');
      expect(lines[2].content).toBe('第三行');
    });

    it('input 单行行为不变（返回长度 1，保护现有契约）', () => {
      const lines = MessageFormatter.format('input', {}, '单行文本');
      expect(lines.length).toBe(1);
      expect(lines[0].content).toBe('❯ 单行文本');
    });

    it('input 空字符串 → 单行（边界保护）', () => {
      const lines = MessageFormatter.format('input', {}, '');
      expect(lines.length).toBe(1);
      expect(lines[0].content).toBe('❯ ');
    });
  });
});
