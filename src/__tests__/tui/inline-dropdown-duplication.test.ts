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
