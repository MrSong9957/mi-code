// cleanupOnExit 退出清理回归测试
//
// 验证：
// 1. writeResumeHint 输出包含 4 个 \r\n（推进出 footer + 隔行）
// 2. resume 命令只出现一次
// 3. 包含 sessionId
// 4. 包含 dim 样式（\x1b[2m）

import { describe, it, expect } from 'vitest';
import { writeResumeHint } from '../cli/resume-hint.js';

describe('writeResumeHint — 退出 resume 提示', () => {
  it('输出包含 4 个 \\r\\n（推进出 footer + 隔行）', () => {
    const writes: string[] = [];
    const mockStdout = { write: (s: string) => { writes.push(s); return true; } };
    writeResumeHint(mockStdout, 'test-session-id');
    const output = writes.join('');
    // 4 个 \r\n 推进（出 footer + 隔行）
    const crlfCount = (output.match(/\r\n/g) ?? []).length;
    expect(crlfCount).toBe(4);
  });

  it('resume 命令只出现一次', () => {
    const writes: string[] = [];
    const mockStdout = { write: (s: string) => { writes.push(s); return true; } };
    writeResumeHint(mockStdout, 'test-session-id');
    const output = writes.join('');
    // "micode --resume" 只出现一次
    const count = (output.match(/micode --resume/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('包含 sessionId', () => {
    const writes: string[] = [];
    const mockStdout = { write: (s: string) => { writes.push(s); return true; } };
    writeResumeHint(mockStdout, 'abc-123-def');
    const output = writes.join('');
    expect(output).toContain('abc-123-def');
  });

  it('包含 dim 样式（\\x1b[2m）', () => {
    const writes: string[] = [];
    const mockStdout = { write: (s: string) => { writes.push(s); return true; } };
    writeResumeHint(mockStdout, 'test-id');
    const output = writes.join('');
    expect(output).toContain('\x1b[2m');
    expect(output).toContain('\x1b[0m');
  });
});
