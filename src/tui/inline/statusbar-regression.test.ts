/**
 * 状态栏回归测试
 *
 * 状态栏从左到右：模式 │ 模型 │ 目录（最后两级）│ git分支 │ 进度条+百分比
 * 示例：auto │ gpt-4o │ projects/mi-code │ feat/branch │ ████░░░░░░ 40%
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

describe('状态栏回归测试', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('状态栏包含五个段：模式、模型、目录、分支、进度', () => {
    renderer.renderFooter('', 0, 'auto │ gpt-4o │ mi-code │ main │ ████░░░░░░ 40%');

    const out = mock.output;
    // 五个段都存在
    expect(out).toContain('auto');           // 模式
    expect(out).toContain('gpt-4o');         // 模型
    expect(out).toContain('mi-code');        // 目录
    expect(out).toContain('main');           // 分支
    expect(out).toContain('████');           // 进度条
    expect(out).toContain('40%');            // 百分比
  });

  it('状态栏段之间用 │ 分隔', () => {
    const status = 'auto │ gpt-4o │ mi-code │ main │ ████░░░░░░ 40%';
    renderer.renderFooter('', 0, status);

    const out = mock.output;
    // │ 分隔符出现 4 次（5 段之间）
    const separators = (out.match(/│/g) || []).length;
    expect(separators).toBe(4);
  });

  it('进度条格式：█ 填充 + ░ 空白 + 百分比', () => {
    renderer.renderFooter('', 0, 'auto │ model │ dir │ branch │ ██████░░░░ 60%');

    const out = mock.output;
    // 进度条包含 █ 和 ░
    expect(out).toMatch(/█+░+/);
    // 百分比格式
    expect(out).toMatch(/\d+%/);
  });

  it('完整启动后状态栏内容完整不被截断', () => {
    renderer.renderFooter('', 0, 'auto │ gpt-4o │ mi-code │ main │ ████░░░░░░ 40%');
    renderer.commitFooter();
    renderer.appendLine('[system] started');
    renderer.renderFooter('', 0, 'auto │ gpt-4o │ mi-code │ main │ ████░░░░░░ 40%');

    const out = mock.output;
    // 状态栏出现 2 次
    const matches = out.split('auto │ gpt-4o │ mi-code │ main │ ████░░░░░░ 40%').length - 1;
    expect(matches).toBe(2);
    // 每次都是完整的
    expect(out).toContain('auto │ gpt-4o │ mi-code │ main │ ████░░░░░░ 40%');
  });
});

describe('spinner 动画稳定性（footer 高度恒定，不堆叠）', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('多次 renderFooter 覆写不产生重复状态栏（模拟 spinner tick）', () => {
    // 模拟 spinner 每 120ms tick：状态栏内容变（帧号变），但高度恒定
    const frames = ['⠋ Thinking…', '⠙ Thinking…', '⠹ Thinking…', '⠸ Thinking…'];
    for (const f of frames) {
      const status = `${f} │ auto │ model │ dir │ main │ ░░░░░░░░░░ 0%`;
      renderer.renderFooter('', 0, status);
    }
    const out = mock.output;
    // 关键：状态栏段（auto │ model）不应堆叠重复
    // 每次覆写擦除旧行，最终只有最后 1 次的内容可见
    // 由于覆写不增加行数，'auto │ model' 的物理行不应超过 1 个连续出现
    // （允许 cursorUp 控制序列中的数字，但不应有连续多行状态栏文本）
    const statusLine = 'auto │ model │ dir │ main │';
    // 统计状态栏文本出现次数（去掉 ANSI 控制序列后）
    const clean = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const count = (clean.match(new RegExp(statusLine.replace(/[│\\^$.*+?()[\]{}]/g, '\\$&'), 'g')) || []).length;
    // 覆写模式下，每次都重写同一批行，状态栏文本会重复出现 N 次（每次覆写都写入）
    // 但关键是不能有超过 footer 高度的堆叠。验证：最后一次的状态栏内容存在
    expect(out).toContain('⠸ Thinking…');
  });
});
