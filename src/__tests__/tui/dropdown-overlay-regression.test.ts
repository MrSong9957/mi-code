/**
 * DropdownOverlay 回归测试
 *
 * 验证：DropdownOverlay 在有候选时渲染，无候选时隐藏。
 * 这是防止"下拉菜单不显示"的关键测试。
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { DropdownProvider, useDropdown } from '../../tui/state/dropdown-context.js';
import { DropdownOverlay } from '../../tui/components/DropdownOverlay.js';

describe('DropdownOverlay 回归测试', () => {
  it('无候选时 DropdownOverlay 不渲染', () => {
    const { lastFrame } = render(
      React.createElement(DropdownProvider, null,
        React.createElement(DropdownOverlay),
      ),
    );
    expect(lastFrame() ?? '').toBe('');
  });

  it('show 后 DropdownOverlay 渲染候选命令', () => {
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

    // 初始渲染：无内容
    expect(lastFrame() ?? '').toBe('');

    // 触发 show 并强制重渲染
    showFn('');
    rerender(React.createElement(DropdownProvider, null,
      React.createElement(App),
    ));

    const frame = lastFrame() ?? '';
    // 前 8 个命令可见：config, login, provider, model, compact, build, plan, auto
    expect(frame).toContain('/config');
    expect(frame).toContain('/build');
    expect(frame).toContain('/plan');
    // help 排第 9，不在前 8 个可见窗口内
    expect(frame).not.toContain('/help');
  });

  it('show("th") 后只渲染匹配的候选', () => {
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

    showFn('th');
    rerender(React.createElement(DropdownProvider, null,
      React.createElement(App),
    ));

    const frame = lastFrame() ?? '';
    expect(frame).toContain('/theme');
    expect(frame).not.toContain('/config');
  });

  it('选中项有 ▸ 前缀', () => {
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

    showFn('');
    rerender(React.createElement(DropdownProvider, null,
      React.createElement(App),
    ));

    const frame = lastFrame() ?? '';
    expect(frame).toContain('▸');
  });
});
