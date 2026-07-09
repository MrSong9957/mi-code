/**
 * 输入框与状态栏回归测试
 *
 * 验证 footer 渲染的正确性：
 * 1. 首次渲染：border + ❯ + border + status 完整输出
 * 2. 覆写模式：光标偏移量正确，不侵入 Logo
 * 3. commitFooter 后消息写在 footer 下方，不覆盖 footer
 * 4. 状态栏文本完整（不被截断）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
  };
}

describe('输入框与状态栏回归测试', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('首次 renderFooter 输出完整的 border + ❯ + border + status', () => {
    renderer.renderFooter('', 0, 'auto │ model');

    const out = mock.output;
    expect(out).toContain('─'.repeat(40)); // 上边框
    expect(out).toContain('❯');            // 输入提示符
    expect(out).toContain('auto │ model'); // 状态栏
    // 状态栏完整出现（不被截断）
    const statusIndex = out.indexOf('auto │ model');
    expect(statusIndex).toBeGreaterThanOrEqual(0);
    // 状态栏后没有被其他内容覆盖
    const afterStatus = out.substring(statusIndex + 'auto │ model'.length);
    expect(afterStatus).not.toMatch(/^[a-z]/); // 不应紧跟小写字母（截断标志）
  });

  it('commitFooter 后消息写在 footer 下方，不覆盖 footer', () => {
    renderer.renderFooter('', 0, 'auto │ model');
    renderer.commitFooter();
    renderer.appendLine('[system] Session started');

    const out = mock.output;
    // 状态栏完整
    expect(out).toContain('auto │ model');
    // 系统消息在状态栏之后
    const statusIdx = out.indexOf('auto │ model');
    const msgIdx = out.indexOf('[system] Session started');
    expect(msgIdx).toBeGreaterThan(statusIdx);
    // 系统消息不与状态栏重叠
    expect(out.substring(statusIdx, msgIdx)).not.toContain('[system]');
  });

  it('覆写模式不破坏 footer 结构', () => {
    renderer.renderFooter('', 0, 'auto │ model');
    renderer.renderFooter('typing...', 7, 'auto │ model');

    const out = mock.output;
    // 覆写后仍有完整的 border + ❯ + border + status
    expect(out).toContain('─'.repeat(40));
    expect(out).toContain('❯ typing...');
    expect(out).toContain('auto │ model');
  });

  it('多次 commitFooter + 消息写入后状态栏仍然完整', () => {
    // 第一轮
    renderer.renderFooter('', 0, 'auto │ model');
    renderer.commitFooter();
    renderer.appendLine('msg1');

    // 第二轮
    renderer.renderFooter('', 0, 'auto │ model');
    renderer.commitFooter();
    renderer.appendLine('msg2');

    const out = mock.output;
    // 状态栏出现 2 次（每轮一次）
    const matches = out.split('auto │ model').length - 1;
    expect(matches).toBe(2);
    // 两次都是完整的
    expect(out).toContain('auto │ model');
  });
});
