/**
 * 光标漂移回归测试
 *
 * 复现 bug：每次 renderFooter 后光标向上漂移 1 行，导致旧 footer 内容
 * 未被擦除，状态栏重复绘制（用户截图中的 4 行状态栏现象）。
 *
 * 根因：覆写模式下，写完 4 行后光标停在 footer 最后一行（status 行），
 * 但 upFromBottom 公式按"光标在 footer 下方一行"（追加模式的基准）计算，
 * 导致多上移 1 行。
 *
 * 物理模型（像录像机的暂停键）：
 *   追加模式 = 录像带前进，写完一段后磁头停在素材**后面**（footer 下方）
 *   覆写模式 = 录像带倒带重录，写完一段后磁头停在素材**最后帧**（status 行）
 *   两种模式回到输入框的距离不同，不能套用同一个公式。
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
 * 终端光标模拟器：解析 ANSI 序列追踪光标行号。
 *
 * 用生活类比（查字典翻页）：
 * - \n = 翻到下一页（行号 +1）
 * - \x1b[NA = 往回翻 N 页（行号 -N）
 * - \x1b[NG / \r = 在当前页内移动列，不翻页
 */
class CursorTracker {
  row = 0;

  /** 重置到指定起始行，记录本轮写入 */
  reset(startRow: number): void {
    this.row = startRow;
  }

  /** 应用一个写入片段，更新光标行 */
  apply(s: string): void {
    // 光标上移：\x1b[NA
    const upMatches = s.match(/\x1b\[(\d+)A/g);
    if (upMatches) {
      for (const m of upMatches) this.row -= parseInt(m.match(/\d+/)![0], 10);
    }
    // 光标下移：\x1b[NB
    const downMatches = s.match(/\x1b\[(\d+)B/g);
    if (downMatches) {
      for (const m of downMatches) this.row += parseInt(m.match(/\d+/)![0], 10);
    }
    // 换行：行号 +1（\n 在大多数终端等价于 CR+LF）
    const newlines = (s.match(/\n/g) || []).length;
    this.row += newlines;
  }
}

describe('光标漂移回归测试', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('覆写模式下光标每次应稳定回到输入框行（不漂移）', () => {
    const tracker = new CursorTracker();
    tracker.reset(0); // 从屏幕第 0 行开始（footer 顶部）

    // 首次渲染（追加模式）
    renderer.renderFooter('', 0, 'STATUS');
    const writes1 = [...mock.written];
    mock.written.length = 0;
    for (const s of writes1) tracker.apply(s);
    const rowAfterFirst = tracker.row;
    // 首次渲染后光标应稳定停在输入框行附近（不漂移）。
    // 新 footer 结构：行0=间隔行, 行1=input, 行2=border, 行3=status。
    // 追加 4 行后光标在第 4 行（status 行 + \n），writeFooter 上移
    // upFromBottom = writtenLineCount(4) - cursorToTop(2) = 2 → 第 2 行。
    // 无 spinner 时 reserveRows = 1（仅一个间隔空行）。
    expect(rowAfterFirst).toBe(2);

    // 第二次渲染（覆写模式）—— 光标应回到同一位置
    renderer.renderFooter('a', 1, 'STATUS');
    const writes2 = [...mock.written];
    mock.written.length = 0;
    for (const s of writes2) tracker.apply(s);
    expect(tracker.row).toBe(rowAfterFirst); // 不应漂移

    // 第三次渲染
    renderer.renderFooter('ab', 2, 'STATUS');
    const writes3 = [...mock.written];
    mock.written.length = 0;
    for (const s of writes3) tracker.apply(s);
    expect(tracker.row).toBe(rowAfterFirst); // 仍然不应漂移

    // 第四次渲染
    renderer.renderFooter('abc', 3, 'STATUS');
    const writes4 = [...mock.written];
    mock.written.length = 0;
    for (const s of writes4) tracker.apply(s);
    expect(tracker.row).toBe(rowAfterFirst); // 持续不漂移
  });

  it('覆写多次后光标累计漂移量应为 0', () => {
    const tracker = new CursorTracker();
    tracker.reset(0);

    renderer.renderFooter('', 0, 'STATUS');
    for (const s of mock.written) tracker.apply(s);
    const baselineRow = tracker.row;
    mock.written.length = 0;

    // 连续覆写 5 次
    for (let i = 1; i <= 5; i++) {
      renderer.renderFooter('x'.repeat(i), i, 'STATUS');
      for (const s of mock.written) tracker.apply(s);
      mock.written.length = 0;
    }

    // 5 次覆写后，光标应仍在 baselineRow（无累计漂移）
    const drift = tracker.row - baselineRow;
    expect(drift).toBe(0);
  });
});
