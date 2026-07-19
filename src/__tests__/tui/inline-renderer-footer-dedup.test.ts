// src/__tests__/tui/inline-renderer-footer-dedup.test.ts
// 回归测试：writeFooter 内容感知跳过
//
// 验证：footer 内容未变时，commit() 不写入 stdout。
// 防止流式期间每帧无条件重写 footer 导致 inline 模式终端累积重复输出。

import { describe, it, expect, vi } from 'vitest';
import { InlineRenderer } from '../../tui/inline/InlineRenderer.js';
import type { CommitFrame } from '../../tui/inline/InlineRenderer.js';

/** 创建 mock stdout */
function mockStdout(): NodeJS.WriteStream {
  const written: string[] = [];
  return {
    write: vi.fn((s: string) => { written.push(s); return true; }),
    _written: written,
  } as unknown as NodeJS.WriteStream & { _written: string[] };
}

/** 创建最小 CommitFrame */
function minimalFrame(overrides?: Partial<CommitFrame>): CommitFrame {
  return {
    prefix: undefined,
    newLines: [],
    streamingLines: null,
    footer: {
      lines: ['────────────', '❯ ', 'build │ sonnet │ main │ ████░░░░░░ 50%'],
      cursorRow: 1,
      cursorCol: 2,
      borderStyle: 'single',
    },
    hasNewFinalized: false,
    transitions: {
      justFinalized: false,
      needEraseDraft: false,
      forceFooterReset: false,
    },
    ...overrides,
  };
}

describe('InlineRenderer commit footer dedup', () => {
  it('footer 内容未变时，第二次 commit 不写入 stdout', () => {
    const stdout = mockStdout();
    const renderer = new InlineRenderer(stdout);

    // 第一次 commit：footer 首次写入
    renderer.commit(minimalFrame());
    const firstWriteCalls = (stdout.write as ReturnType<typeof vi.fn>).mock.calls.length;

    // 重置 mock
    (stdout.write as ReturnType<typeof vi.fn>).mockClear();

    // 第二次 commit：footer 内容相同，应跳过
    renderer.commit(minimalFrame());
    const secondWriteCalls = (stdout.write as ReturnType<typeof vi.fn>).mock.calls.length;

    // 第二次 commit 的 writeBuf 只有 BSU+ESU（2 个元素），应被 buf.length > 2 拦截
    expect(secondWriteCalls).toBe(0);
  });

  it('footer 内容变化时，commit 正常写入', () => {
    const stdout = mockStdout();
    const renderer = new InlineRenderer(stdout);

    // 第一次 commit
    renderer.commit(minimalFrame());
    (stdout.write as ReturnType<typeof vi.fn>).mockClear();

    // 第二次 commit：footer 内容变化
    renderer.commit(minimalFrame({
      footer: {
        lines: ['────────────', '❯ hello', 'build │ sonnet │ main │ ██████░░░░ 60%'],
        cursorRow: 1,
        cursorCol: 7,
        borderStyle: 'single',
      },
    }));
    const secondWriteCalls = (stdout.write as ReturnType<typeof vi.fn>).mock.calls.length;

    // footer 变化，应正常写入
    expect(secondWriteCalls).toBeGreaterThan(0);
  });

  it('streamingLines 变化时，即使 footer 未变也正常写入', () => {
    const stdout = mockStdout();
    const renderer = new InlineRenderer(stdout);

    // 第一次 commit：无 streaming
    renderer.commit(minimalFrame());
    (stdout.write as ReturnType<typeof vi.fn>).mockClear();

    // 第二次 commit：有 streamingLines
    renderer.commit(minimalFrame({
      streamingLines: ['正在思考...', '请稍候...'],
    }));
    const secondWriteCalls = (stdout.write as ReturnType<typeof vi.fn>).mock.calls.length;

    // streamingLines 变化，应正常写入
    expect(secondWriteCalls).toBeGreaterThan(0);
  });

  it('newLines 变化时，即使 footer 未变也正常写入', () => {
    const stdout = mockStdout();
    const renderer = new InlineRenderer(stdout);

    // 第一次 commit
    renderer.commit(minimalFrame());
    (stdout.write as ReturnType<typeof vi.fn>).mockClear();

    // 第二次 commit：有 newLines
    renderer.commit(minimalFrame({
      newLines: ['新的固化行'],
      hasNewFinalized: true,
    }));
    const secondWriteCalls = (stdout.write as ReturnType<typeof vi.fn>).mock.calls.length;

    // newLines 变化，应正常写入
    expect(secondWriteCalls).toBeGreaterThan(0);
  });

  it('连续多次相同 footer 的 commit，只有首次写入', () => {
    const stdout = mockStdout();
    const renderer = new InlineRenderer(stdout);

    const frame = minimalFrame();

    // 连续 5 次相同 commit
    for (let i = 0; i < 5; i++) {
      renderer.commit(frame);
    }

    // stdout.write 被调用多次（构造函数写 DECAWM OFF + 首次 commit 写 logo + footer），
    // 但后续 4 次 commit 应被跳过（writeBuf 只有 BSU+ESU，buf.length <= 2）
    const totalCalls = (stdout.write as ReturnType<typeof vi.fn>).mock.calls.length;

    // 构造函数: 1 次 write (\x1b[?7l)
    // 首次 commit: 1 次 flush (BSU + logo + footer + ESU join 后)
    // 后续 4 次: 0 次 (被 buf.length > 2 拦截)
    // 总计: 2 次
    expect(totalCalls).toBe(2);
  });
});
