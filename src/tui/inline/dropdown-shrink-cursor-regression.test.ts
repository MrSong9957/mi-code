// src/tui/inline/dropdown-shrink-cursor-regression.test.ts
// 下拉菜单高度收缩时的光标漂移回归测试
//
// 复现 bug：footer 块从 N 行（带下拉）收缩到 4 行（无下拉）时，覆写循环
// 写 max(旧,新) 行带 \n，把光标推到旧块底之外；删除分支多余的 cursorUp(1)
// 加剧漂移。下一帧 cursorUp(offsetToTop) 从错误位置开始，footer 在新位置重画，
// 旧位置残留（用户截图：每个斜杠字符都重绘一次输入框）。
//
// 物理本质（录像带模型）：覆写模式写完内容后磁头（光标）必须停在素材最后帧。
// 素材从 12 帧缩到 4 帧时，磁头若停在旧 12 帧位置（行11），而定位公式假设
// 磁头在新 4 帧位置（行3），磁头漂了 7 行——下次录制从错位开始，旧帧擦不掉。

import { describe, it, expect, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';

/** 复用自 cursor-drift-regression.test.ts（纯解析工具，保持测试自包含） */
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
 * 复用自 cursor-drift-regression.test.ts（查字典翻页模型）。
 */
class CursorTracker {
  row = 0;

  reset(startRow: number): void {
    this.row = startRow;
  }

  apply(s: string): void {
    const upMatches = s.match(/\x1b\[(\d+)A/g);
    if (upMatches) {
      for (const m of upMatches) this.row -= parseInt(m.match(/\d+/)![0], 10);
    }
    const downMatches = s.match(/\x1b\[(\d+)B/g);
    if (downMatches) {
      for (const m of downMatches) this.row += parseInt(m.match(/\d+/)![0], 10);
    }
    const newlines = (s.match(/\n/g) || []).length;
    this.row += newlines;
  }
}

/** 八个候选（模拟输入 / 时 completionStore.filter('') 的前 8 条） */
const EIGHT_CANDIDATES = ['config', 'login', 'provider', 'model', 'compact', 'build', 'plan', 'auto'];

describe('下拉菜单高度收缩时光标不漂移', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('8 候选 → 0 候选：光标必须回到输入框行（行3），不漂移', () => {
    const tracker = new CursorTracker();
    tracker.reset(0);

    // 首帧：8 候选，追加模式，footerHeight 0 → 12（含 1 行间隔位）
    renderer.renderFooter('/', 1, 'S', 80, EIGHT_CANDIDATES, 0);
    for (const s of mock.written) tracker.apply(s);
    const rowAfterFirst = tracker.row;
    // 首帧后光标在输入框行（行2：1 行间隔位 + 输入行）
    expect(rowAfterFirst).toBe(2);
    mock.written.length = 0;

    // 第二帧：0 候选（收缩 12 → 5）
    renderer.renderFooter('/w', 2, 'S', 80, [], 0);
    for (const s of mock.written) tracker.apply(s);

    // 光标必须回到输入框行（行2），不能漂移
    expect(tracker.row).toBe(2);
  });

  it('连续 8候选→0候选→8候选 三次循环：累计漂移为 0', () => {
    const tracker = new CursorTracker();
    tracker.reset(0);

    // 首帧建立 baseline
    renderer.renderFooter('/', 1, 'S', 80, EIGHT_CANDIDATES, 0);
    for (const s of mock.written) tracker.apply(s);
    const baselineRow = tracker.row;
    expect(baselineRow).toBe(2);
    mock.written.length = 0;

    // 三次开-关循环
    for (let cycle = 0; cycle < 3; cycle++) {
      // 关闭下拉（8 → 0）
      renderer.renderFooter('/w', 2, 'S', 80, [], 0);
      for (const s of mock.written) tracker.apply(s);
      expect(tracker.row, `cycle ${cycle} 关闭后光标漂移`).toBe(baselineRow);
      mock.written.length = 0;

      // 重新打开下拉（0 → 8）
      renderer.renderFooter('/', 1, 'S', 80, EIGHT_CANDIDATES, 0);
      for (const s of mock.written) tracker.apply(s);
      expect(tracker.row, `cycle ${cycle} 重新打开后光标漂移`).toBe(baselineRow);
      mock.written.length = 0;
    }

    // 最终累计漂移必须为 0
    expect(tracker.row - baselineRow).toBe(0);
  });

  it('0 候选 → 8 候选（扩张 6→13）：光标回到输入框行，双向保护', () => {
    const tracker = new CursorTracker();
    tracker.reset(0);

    // 首帧：无下拉，追加模式，footerHeight 0 → 5（含 1 行间隔位）
    renderer.renderFooter('', 0, 'S', 80, [], 0);
    for (const s of mock.written) tracker.apply(s);
    const rowAfterFirst = tracker.row;
    expect(rowAfterFirst).toBe(2);
    mock.written.length = 0;

    // 第二帧：8 候选（扩张 5 → 12）
    renderer.renderFooter('/', 1, 'S', 80, EIGHT_CANDIDATES, 0);
    for (const s of mock.written) tracker.apply(s);

    // 扩张场景光标也必须回到输入框行
    expect(tracker.row).toBe(2);
  });

  it('候选数 18→3→18 剧烈跳变：光标始终回到输入框行（不漂移）', () => {
    // 场景：用户输入 /c（2条）→ Backspace 到 /（18条）→ 再输入。
    // footerHeight 在 12↔7 间跳变（18 候选可见窗口限制为 8），考验覆写状态机在非零中间值的稳定性。
    const tracker = new CursorTracker();
    tracker.reset(0);
    const eighteen = ['cmd0','cmd1','cmd2','cmd3','cmd4','cmd5','cmd6','cmd7','cmd8','cmd9','cmd10','cmd11','cmd12','cmd13','cmd14','cmd15','cmd16','cmd17'];
    const three = ['cmdA', 'cmdB', 'cmdC'];

    // 首帧：18 候选（可见8条，footerHeight 0 → 12）
    renderer.renderFooter('/', 1, 'S', 80, eighteen, 0);
    for (const s of mock.written) tracker.apply(s);
    expect(tracker.row, '18候选后').toBe(2);
    mock.written.length = 0;

    // 第二帧：缩到 3 候选（footerHeight 12 → 7）
    renderer.renderFooter('/c', 2, 'S', 80, three, 0);
    for (const s of mock.written) tracker.apply(s);
    expect(tracker.row, '缩到3候选后').toBe(2);
    mock.written.length = 0;

    // 第三帧：扩回 18 候选（footerHeight 7 → 12）
    renderer.renderFooter('/', 1, 'S', 80, eighteen, 5);
    for (const s of mock.written) tracker.apply(s);
    expect(tracker.row, '扩回18候选后').toBe(2);
    mock.written.length = 0;

    // 第四帧：再次缩到 3 候选
    renderer.renderFooter('/c', 2, 'S', 80, three, 2);
    for (const s of mock.written) tracker.apply(s);
    expect(tracker.row, '再次缩到3候选后').toBe(2);
  });
});
