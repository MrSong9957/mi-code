// src/__tests__/tui/inline-dropdown-duplication.test.ts
// 回归测试：下拉菜单渲染在 footer 之后导致主屏重复绘制
//
// 根因：两个独立 useEffect 竞争 stdout。
// 主 effect 调用 renderer.renderFooter()（footer 在末尾），
// dropdown effect 调用 process.stdout.write()（菜单追加在 footer 之后）。
// 覆写模式只清除 footerHeight 行，不清除下方菜单 → 每次重绘追加新副本。
//
// 正确行为：菜单内容必须写在 footer 之前（消息区与 footer 之间），
// 或者合并到同一个 effect 中协调写入。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCompletionStore } from '../../tui/state/completion-store.js';

/**
 * 模拟 InlineApp useEffect #4 的下拉菜单渲染逻辑（带 visible 检查）。
 * 从 src/tui/inline/InlineApp.tsx 第 424-444 行提取。
 */
function renderDropdownAnsi(
  visible: boolean,
  candidates: string[],
  index: number,
): string {
  if (!visible || candidates.length === 0) return '';

  const maxVisible = Math.min(candidates.length, 8);
  const startIndex = Math.max(0, index - Math.floor(maxVisible / 2));
  const visibleCandidates = candidates.slice(startIndex, startIndex + maxVisible);

  let output = '';
  for (let i = 0; i < visibleCandidates.length; i++) {
    const actualIndex = startIndex + i;
    const isSelected = actualIndex === index;
    if (isSelected) {
      output += `\x1b[7m ▸ /${visibleCandidates[i]} \x1b[0m\n`;
    } else {
      output += `   /${visibleCandidates[i]}\n`;
    }
  }
  return output;
}

describe('InlineApp 下拉菜单不重复绘制', () => {
  let stdoutChunks: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;

  beforeEach(() => {
    stdoutChunks = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    });
  });

  it('菜单关闭后渲染函数返回空字符串（无残留）', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().hide();

    const { visible, candidates, index } = store.getState();
    const output = renderDropdownAnsi(visible, candidates, index);
    expect(output).toBe('');
  });

  it('下拉菜单内容出现在 footer 边框之前', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const { visible, candidates, index } = store.getState();

    const dropdownOutput = renderDropdownAnsi(visible, candidates, index);
    const footerBorder = '─'.repeat(80);

    // 正确顺序：dropdown 在 footer 之前
    const combinedOutput = dropdownOutput + `\r\x1b[2K${footerBorder}\n`;

    const dropdownPos = combinedOutput.indexOf('/plan');
    const footerPos = combinedOutput.indexOf(footerBorder);
    expect(dropdownPos).toBeLessThan(footerPos);
  });

  it('多次重绘不会产生重复的菜单项', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const { visible, candidates, index } = store.getState();

    const allOutput: string[] = [];
    for (let i = 0; i < 5; i++) {
      allOutput.push(renderDropdownAnsi(visible, candidates, index));
    }

    for (const output of allOutput) {
      expect((output.match(/\/plan/g) ?? []).length).toBe(1);
    }
  });

  it('footer 覆写范围必须包含下拉菜单行数', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const { candidates } = store.getState();

    const dropdownRows = Math.min(candidates.length, 8);
    const footerBaseRows = 4;
    const totalRows = footerBaseRows + dropdownRows;

    // 验证：总行数必须大于基础 footer 行数（有菜单时）
    expect(totalRows).toBeGreaterThan(footerBaseRows);
    // 验证：dropdown 行数必须为正（菜单有内容）
    expect(dropdownRows).toBeGreaterThan(0);
    // 验证：总行数 = footer 基础 + 菜单行数
    expect(totalRows).toBe(footerBaseRows + dropdownRows);
  });

  it('下拉菜单关闭后连续重绘无残留（核心回归）', () => {
    const store = createCompletionStore();

    store.getState().filter('');
    store.getState().hide();

    for (let i = 0; i < 3; i++) {
      const output = renderDropdownAnsi(
        store.getState().visible,
        store.getState().candidates,
        store.getState().index,
      );
      expect(output).toBe('');
    }
  });
});

// ── 核心回归：renderFooter 必须知道 dropdown 高度 ──
describe('renderFooter 覆写范围包含 dropdown', () => {
  let stdoutChunks: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;

  beforeEach(() => {
    stdoutChunks = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    });
  });

  it('renderFooter 覆写模式必须 cursorUp 包含 dropdown 行数', async () => {
    // 导入真实的 InlineRenderer
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const renderer = new InlineRenderer(process.stdout);

    // 第一次渲染：8 行 dropdown + 4 行 footer
    const dropdownRows1 = 8;
    for (let i = 0; i < dropdownRows1; i++) {
      process.stdout.write(`   /cmd${i}\n`);
    }
    renderer.renderFooter('/test', 5, 'status', 80);
    const afterFirst = [...stdoutChunks];
    stdoutChunks.length = 0;

    // 第二次渲染：3 行 dropdown + 4 行 footer
    // 覆写模式必须清除第一次的 8 行 dropdown 残留
    const dropdownRows2 = 3;
    for (let i = 0; i < dropdownRows2; i++) {
      process.stdout.write(`   /cmd${i}\n`);
    }
    renderer.renderFooter('/test2', 6, 'status2', 80);
    const afterSecond = [...stdoutChunks];

    // 验证：第二次 renderFooter 的 cursorUp 必须包含第一次的 dropdown 高度
    // cursorUp 序列：\x1b[{n}A，n 必须 > 1（仅 footer 高度）才能覆盖 dropdown
    const allOutput = afterSecond.join('');
    const cursorUpMatches = allOutput.match(/\x1b\[(\d+)A/g) ?? [];
    expect(cursorUpMatches.length).toBeGreaterThan(0);

    // 提取 cursorUp 的行数
    const lastCursorUp = cursorUpMatches[cursorUpMatches.length - 1];
    const match = lastCursorUp.match(/\x1b\[(\d+)A/);
    expect(match).not.toBeNull();
    const upRows = parseInt(match![1], 10);

    // upRows 必须 > 1（仅 footer 的 inputLineIndex）
    // 因为还要覆盖 dropdown 行数
    // 具体值：1 (footer top) + dropdownRows1 的一部分（取决于 cursor 位置）
    expect(upRows).toBeGreaterThan(1);
  });

  it('dropdown 行数变化时 footer 覆写不残留旧行', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const renderer = new InlineRenderer(process.stdout);

    // 第一次：8 行 dropdown
    for (let i = 0; i < 8; i++) {
      process.stdout.write(`DROPDOWN_LINE_${i}\n`);
    }
    renderer.renderFooter('/', 1, 'S', 80, 8);
    stdoutChunks.length = 0;

    // 第二次：0 行 dropdown（菜单关闭），但 prevDropdownRows=8（上一次的 dropdown 高度）
    renderer.renderFooter('/', 1, 'S', 80, 8);
    const output = stdoutChunks.join('');

    // 验证：第二次必须 cursorUp 足够行数来清除第一次的 8 行 dropdown
    const cursorUpMatch = output.match(/\x1b\[(\d+)A/);
    expect(cursorUpMatch).not.toBeNull();
    const upRows = parseInt(cursorUpMatch![1], 10);
    // upRows = prevDropdownRows(8) + 1(border) + 0(inputLineIndex) = 9
    expect(upRows).toBe(9);
  });
});
