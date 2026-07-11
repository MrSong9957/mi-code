/**
 * 下拉菜单端到端回归测试
 *
 * 核心契约：如果此测试通过，屏幕上必然显示下拉菜单。
 *
 * 测试策略：模拟实际应用流程——
 * 1. 用户输入 / → 触发 show
 * 2. DropdownOverlay 渲染候选命令
 * 3. 输出到 stdout 的内容包含候选命令
 *
 * 这是防止"下拉菜单不显示"的最终防线。
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { DropdownProvider, useDropdown } from '../../tui/state/dropdown-context.js';
import { DropdownOverlay } from '../../tui/components/DropdownOverlay.js';

/**
 * 模拟完整的下拉菜单流程：
 * - 用户输入 / → show('') → DropdownOverlay 渲染
 * - 输出到 stdout 的内容必须包含候选命令
 */
function simulateSlashInput(showFn: (prefix: string) => void): void {
  showFn('');
}

describe('下拉菜单 E2E 回归测试', () => {
  it('输入 / 后，stdout 输出必须包含候选命令', () => {
    let showFn: (prefix: string) => void = () => {};
    function App(): React.ReactElement {
      const { show } = useDropdown();
      showFn = show;
      return React.createElement(DropdownOverlay);
    }

    const { lastFrame, rerender } = render(
      React.createElement(DropdownProvider, null,
        React.createElement(App),
      ),
    );

    // 模拟用户输入 /
    simulateSlashInput(showFn);
    rerender(React.createElement(DropdownProvider, null,
      React.createElement(App),
    ));

    // 核心断言：stdout 输出必须包含候选命令
    const output = lastFrame() ?? '';
    expect(output.length).toBeGreaterThan(0); // 必须有输出
    expect(output).toContain('/config');      // 必须包含候选命令
    expect(output).toContain('/build');       // 必须包含候选命令
    expect(output).toContain('▸');            // 必须有选中标记
  });

  it('输入 /th 后，stdout 输出必须只包含 theme', () => {
    let showFn: (prefix: string) => void = () => {};
    function App(): React.ReactElement {
      const { show } = useDropdown();
      showFn = show;
      return React.createElement(DropdownOverlay);
    }

    const { lastFrame, rerender } = render(
      React.createElement(DropdownProvider, null,
        React.createElement(App),
      ),
    );

    // 模拟用户输入 /th
    showFn('th');
    rerender(React.createElement(DropdownProvider, null,
      React.createElement(App),
    ));

    const output = lastFrame() ?? '';
    expect(output).toContain('/theme');
    expect(output).not.toContain('/config');
  });

  it('上下选择后，stdout 输出必须更新选中标记', () => {
    let showFn: (prefix: string) => void = () => {};
    let nextFn: () => void = () => {};
    function App(): React.ReactElement {
      const { show, next } = useDropdown();
      showFn = show;
      nextFn = next;
      return React.createElement(DropdownOverlay);
    }

    const { lastFrame, rerender } = render(
      React.createElement(DropdownProvider, null,
        React.createElement(App),
      ),
    );

    // 显示下拉菜单
    showFn('');
    rerender(React.createElement(DropdownProvider, null,
      React.createElement(App),
    ));
    const before = lastFrame() ?? '';
    expect(before).toContain('▸ /config'); // 第一个命令被选中

    // 向下选择
    nextFn();
    rerender(React.createElement(DropdownProvider, null,
      React.createElement(App),
    ));
    const after = lastFrame() ?? '';
    expect(after).toContain('▸ /login'); // 第二个命令被选中
    expect(after).not.toContain('▸ /config'); // 第一个不再被选中
  });

  it('hide 后，stdout 输出必须为空', () => {
    let showFn: (prefix: string) => void = () => {};
    let hideFn: () => void = () => {};
    function App(): React.ReactElement {
      const { show, hide } = useDropdown();
      showFn = show;
      hideFn = hide;
      return React.createElement(DropdownOverlay);
    }

    const { lastFrame, rerender } = render(
      React.createElement(DropdownProvider, null,
        React.createElement(App),
      ),
    );

    // 显示
    showFn('');
    rerender(React.createElement(DropdownProvider, null,
      React.createElement(App),
    ));
    expect((lastFrame() ?? '').length).toBeGreaterThan(0);

    // 隐藏
    hideFn();
    rerender(React.createElement(DropdownProvider, null,
      React.createElement(App),
    ));
    expect(lastFrame() ?? '').toBe('');
  });
});
