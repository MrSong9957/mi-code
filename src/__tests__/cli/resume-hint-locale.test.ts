// writeResumeHint 本地化测试（RED → GREEN）
//
// 验证：
// 1. 提示文案 'Resume this session with:' / 中文译文跟随语言切换
// 2. 命令 'micode --resume session-123' 始终保持 RAW 不变
// 3. 不传 translator 时（向后兼容）保持英文默认

import { describe, expect, it } from 'vitest';
import { writeResumeHint } from '../../cli/resume-hint.js';
import { createLanguageStore, createTranslator } from '../../locale/index.js';

function capture(): { writes: string[]; stdout: { write: (s: string) => boolean } } {
  const writes: string[] = [];
  const stdout = { write: (s: string) => { writes.push(s); return true; } };
  return { writes, stdout };
}

describe('writeResumeHint 本地化', () => {
  it('中文：使用本地化 label，命令保持 RAW', () => {
    const { writes, stdout } = capture();
    const translator = createTranslator(createLanguageStore('zh-CN'));
    writeResumeHint(stdout, 'session-123', translator);
    const output = writes.join('');

    // 命令保持 RAW
    expect(output).toContain('micode --resume session-123');
    // 中文 label（具体译文由资源决定，断言关键中文 token）
    expect(output).toContain('使用以下命令恢复本次会话：');
    // 不应残留英文 label
    expect(output).not.toContain('Resume this session with:');
  });

  it('英文：使用英文 label，命令保持 RAW', () => {
    const { writes, stdout } = capture();
    const translator = createTranslator(createLanguageStore('en-US'));
    writeResumeHint(stdout, 'session-123', translator);
    const output = writes.join('');

    expect(output).toContain('micode --resume session-123');
    expect(output).toContain('Resume this session with:');
  });

  it('不传 translator 时保持英文默认（向后兼容）', () => {
    const { writes, stdout } = capture();
    // 仅传 stdout + sessionId，省略 translator
    writeResumeHint(stdout, 'session-123');
    const output = writes.join('');

    expect(output).toContain('micode --resume session-123');
    expect(output).toContain('Resume this session with:');
  });
});
