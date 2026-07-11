/**
 * 着色护栏测试：输入框不被着色
 *
 * 核心契约：LOGO 和状态栏着色，但输入框（❯ + 用户输入）保持默认色。
 * 这防止颜色"泄漏"到输入框——一旦输入框被着色，光标定位、选区、
 * 擦除重绘的列宽计算都会因 ANSI 序列占位而出错。
 *
 * 物理模型（无色隔离区）：
 *   输入框是终端里的「无菌操作台」——任何颜色（SGR 序列）都是污染物。
 *   renderer 透传字符串时，输入框行的内容必须只有可见字符，
 *   不能有 \x1b[...m 这种不可见控制序列。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';
import { colorizeStatus } from './colors.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
  };
}

/** SGR 序列正则：\x1b[<params>m（支持单数字如 96 和 TrueColor 如 38;2;R;G;B） */
const SGR_RE = /\x1b\[[\d;]+m/;
/** 提取某一行的「擦除重写」内容（\r\x1b[2K 后的部分） */
function extractErasedLine(output: string, lineIndex: number): string {
  // 覆写模式下，每行以 \r\x1b[2K 开头。收集所有这样的片段。
  const erased = output.split('\r\x1b[2K').filter(s => s.length > 0);
  // 每个 erased 片段可能含 \n 分隔，取第一段作为该行内容
  const lines: string[] = [];
  for (const chunk of erased) {
    // 片段可能是 "内容\n" 或纯 "内容"
    const idx = chunk.indexOf('\n');
    lines.push(idx >= 0 ? chunk.slice(0, idx) : chunk);
  }
  return lines[lineIndex] ?? '';
}

describe('着色护栏：输入框不被着色', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('首次渲染：输入框行（❯ + input）不含任何 SGR 序列', () => {
    const coloredStatus = colorizeStatus({
      mode: 'auto', model: 'gpt-4o', dir: 'mi-code',
      branch: 'main', context: '████░░░░░░ 40%',
    });
    renderer.renderFooter('hello', 5, coloredStatus);

    // footer 结构：border(0) + input(1) + border(2) + status(3)
    // 输入框是第 1 行（含 ❯ 前缀）
    const out = mock.output;
    // 找到 ❯ 所在行的完整内容
    const promptIdx = out.indexOf('❯');
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    // 从 ❯ 到下一个 \n 之间的内容（即输入框行）
    const lineEnd = out.indexOf('\n', promptIdx);
    const inputLine = out.slice(promptIdx, lineEnd);
    // 输入框行不应有任何 SGR 序列
    expect(SGR_RE.test(inputLine)).toBe(false);
    expect(inputLine).toBe('❯ hello');
  });

  it('状态栏行含 SGR 序列（确认着色生效）', () => {
    const coloredStatus = colorizeStatus({
      mode: 'auto', model: 'gpt-4o', dir: 'mi-code',
      branch: 'main', context: '████░░░░░░ 40%',
    });
    renderer.renderFooter('hello', 5, coloredStatus);

    const out = mock.output;
    // 状态栏文本应被 SGR 包裹（TrueColor 模式）
    expect(out).toContain('auto');
    expect(SGR_RE.test(out.slice(out.indexOf('auto') - 20, out.indexOf('auto') + 20))).toBe(true);
    expect(out).toContain('gpt-4o');
    // 但输入框 ❯ hello 不含 SGR
    const promptIdx = out.indexOf('❯');
    const lineEnd = out.indexOf('\n', promptIdx);
    const inputLine = out.slice(promptIdx, lineEnd);
    expect(SGR_RE.test(inputLine)).toBe(false);
  });

  it('覆写模式下输入框行仍不含 SGR（多次重绘）', () => {
    const coloredStatus = colorizeStatus({
      mode: 'auto', model: 'gpt-4o', dir: 'mi-code',
      branch: 'main', context: '████░░░░░░ 40%',
    });
    // 首次
    renderer.renderFooter('a', 1, coloredStatus);
    // 覆写（输入字符）
    renderer.renderFooter('ab', 2, coloredStatus);
    // 再次覆写
    renderer.renderFooter('abc', 3, coloredStatus);

    // 在所有覆写片段中，输入框行都不应含 SGR
    const out = mock.output;
    // 提取所有 "❯ ..." 的输入框片段
    const inputFragments = out.match(/❯[^❯\n\x1b]*?(?=\x1b|\n|\r|$)/g) ?? [];
    for (const frag of inputFragments) {
      expect(SGR_RE.test(frag)).toBe(false);
    }
  });

  it('空输入时输入框行只有 ❯ 和空格，无 SGR', () => {
    const coloredStatus = colorizeStatus({
      mode: 'auto', model: 'gpt-4o', dir: 'mi-code',
      branch: 'main', context: '░░░░░░░░░░ 0%',
    });
    renderer.renderFooter('', 0, coloredStatus);

    const out = mock.output;
    const promptIdx = out.indexOf('❯');
    const lineEnd = out.indexOf('\n', promptIdx);
    const inputLine = out.slice(promptIdx, lineEnd);
    expect(SGR_RE.test(inputLine)).toBe(false);
    expect(inputLine).toBe('❯ ');
  });
});
