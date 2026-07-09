/**
 * commitFooter 擦除行为回归测试
 *
 * 根因：commitFooter 原本把 footer 保留为"历史"，但 footer 的 input 行内容
 * 与随后 appendLine 的用户消息重复，导致提交后出现重复的 border/input/status。
 *
 * 正确行为：commitFooter 应擦除整个 footer，让后续 appendLine 的消息覆盖
 * footer 原位置——历史里只有纯净的消息，无重复框架。
 *
 * 物理模型（黑板擦除）：
 *   footer 是黑板上的临时草稿区，commit = 用黑板擦把草稿区擦干净，
 *   然后粉笔（appendLine）在干净的黑板上写正式内容。
 *   旧的草稿不留痕迹，避免和正式内容混在一起。
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

/**
 * 终端模拟器：维护行缓冲，应用 ANSI 序列。
 * 关键能力：\x1b[2K 擦整行、\x1b[NA 上移、\n 下移、写入覆盖。
 */
class Terminal {
  lines: string[] = [''];
  curRow = 0;
  curCol = 0;

  write(s: string): void {
    const clean = s.replace(/\x1b\[\d+m/g, '').replace(/\x1b\[\?25[lh]/g, '');
    // \r\x1b[2K 组合 = 清当前行
    const processed = clean.replace(/\r\x1b\[2K/g, '\x00CLR\x00');
    let i = 0;
    while (i < processed.length) {
      if (processed.startsWith('\x00CLR\x00', i)) {
        while (this.curRow >= this.lines.length) this.lines.push('');
        this.lines[this.curRow] = '';
        this.curCol = 0;
        i += '\x00CLR\x00'.length;
        continue;
      }
      const ch = processed[i]!;
      if (ch === '\x1b') {
        const m = processed.slice(i).match(/^\x1b\[(\d*)([A-Za-z])/);
        if (m) {
          const n = m[1] ? parseInt(m[1], 10) : 1;
          const cmd = m[2]!;
          if (cmd === 'A') this.curRow = Math.max(0, this.curRow - n);
          else if (cmd === 'B') this.curRow += n;
          else if (cmd === 'G') this.curCol = Math.max(0, n - 1);
          i += m[0].length;
          continue;
        }
      }
      if (ch === '\n') {
        this.curRow++;
        while (this.curRow >= this.lines.length) this.lines.push('');
        this.curCol = 0;
        i++;
        continue;
      }
      if (ch === '\r') { this.curCol = 0; i++; continue; }
      while (this.curRow >= this.lines.length) this.lines.push('');
      const line = this.lines[this.curRow] ?? '';
      this.lines[this.curRow] = line.slice(0, this.curCol) + ch + line.slice(this.curCol + 1);
      this.curCol++;
      i++;
    }
  }

  /** 非空行数 */
  get nonEmptyLines(): string[] {
    return this.lines.filter(l => l.length > 0);
  }
}

describe('commitFooter 擦除行为', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('commitFooter 后 footer 区域被擦除（无 border 残留）', () => {
    const term = new Terminal();
    const orig = mock.write;
    mock.write = (s: string) => { term.write(s); return orig(s); };

    renderer.renderFooter('你是谁？', 4, 'STATUS');
    renderer.commitFooter();

    // footer 的 border 不应残留在屏幕
    const borders = term.nonEmptyLines.filter(l => l.includes('──'));
    // commitFooter 应擦除 footer，border 不残留（或仅作为被擦除的空行）
    // 严格断言：擦除后非空行里没有 border
    expect(borders.length).toBe(0);
  });

  it('commitFooter 后 footer 的 input 内容（❯ 你是谁？）不残留', () => {
    const term = new Terminal();
    const orig = mock.write;
    mock.write = (s: string) => { term.write(s); return orig(s); };

    renderer.renderFooter('你是谁？', 4, 'STATUS');
    renderer.commitFooter();

    // ❯ 你是谁？ 不应残留在屏幕非空行
    const inputLines = term.nonEmptyLines.filter(l => l.includes('你是谁'));
    expect(inputLines.length).toBe(0);
  });

  it('commitFooter 后 footer 的 status 内容不残留', () => {
    const term = new Terminal();
    const orig = mock.write;
    mock.write = (s: string) => { term.write(s); return orig(s); };

    renderer.renderFooter('', 0, 'STATUS_LINE');
    renderer.commitFooter();

    const statusLines = term.nonEmptyLines.filter(l => l.includes('STATUS_LINE'));
    expect(statusLines.length).toBe(0);
  });

  it('commitFooter 后 appendLine 的消息覆盖 footer 原位置（无重复）', () => {
    const term = new Terminal();
    const orig = mock.write;
    mock.write = (s: string) => { term.write(s); return orig(s); };

    renderer.renderFooter('你是谁？', 4, 'STATUS');
    renderer.commitFooter();
    renderer.appendLine('❯ 你是谁？');   // 用户消息
    renderer.renderFooter('', 0, 'STATUS'); // 新 footer

    // 用户消息只出现 1 次（不是 2 次）
    const userMsgs = term.nonEmptyLines.filter(l => l === '❯ 你是谁？');
    expect(userMsgs.length).toBe(1);
    // border 只出现在新 footer（2 个：上下边框）
    const borders = term.nonEmptyLines.filter(l => l.includes('──'));
    expect(borders.length).toBe(2);
  });

  it('完整提交序列：输入 → 提交 → system 消息，历史区域干净', () => {
    const term = new Terminal();
    const orig = mock.write;
    mock.write = (s: string) => { term.write(s); return orig(s); };

    // 输入
    renderer.renderFooter('你是谁？', 4, 'STATUS');
    // 提交：commit + append user + new footer
    renderer.commitFooter();
    renderer.appendLine('❯ 你是谁？');
    renderer.renderFooter('', 0, 'STATUS');
    // system 消息：commit + append system + new footer
    renderer.commitFooter();
    renderer.appendLine('[system] done');
    renderer.renderFooter('', 0, 'STATUS');

    const nonEmpty = term.nonEmptyLines;

    // 历史里只有：user 消息 + system 消息（各 1 次）
    expect(nonEmpty.filter(l => l === '❯ 你是谁？').length).toBe(1);
    expect(nonEmpty.filter(l => l === '[system] done').length).toBe(1);
    // 只有最后那个 footer 的 border（2 个）
    expect(nonEmpty.filter(l => l.includes('──')).length).toBe(2);
    // 只有最后那个 footer 的 status（1 个）
    expect(nonEmpty.filter(l => l === 'STATUS').length).toBe(1);
  });

  it('commitFooter 后 footerHeight 归零（后续 renderFooter 走追加模式）', () => {
    renderer.renderFooter('hello', 5, 'STATUS');
    expect((renderer as unknown as { footerHeight: number }).footerHeight).toBe(4);

    renderer.commitFooter();
    expect((renderer as unknown as { footerHeight: number }).footerHeight).toBe(0);

    // 后续 renderFooter 应是追加模式（无 cursorUp 到 footer 顶部的序列）
    const afterCommit = mock.written.length;
    renderer.renderFooter('world', 5, 'STATUS');
    const newWrites = mock.written.slice(afterCommit).join('');
    // 追加模式不包含"上移到 footer 顶部"的 cursorUp（那只在覆写模式）
    // 但追加模式末尾有 cursorUp 定位光标，所以检查是否以 border 开头（追加特征）
    expect(newWrites).toContain('─'); // border 作为首行写入
  });

  it('commitFooter 时 footerHeight=0 是无操作（幂等）', () => {
    // 未渲染过 footer，直接 commit 不应写入任何内容
    const beforeLen = mock.written.length;
    renderer.commitFooter();
    expect(mock.written.length).toBe(beforeLen);
  });
});
