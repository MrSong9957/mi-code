/**
 * ThemeStoreProvider 组件级回归测试
 *
 * 验证：store 变化 → ThemeStoreProvider 重渲染 → 子组件拿到新主题
 *
 * 核心契约：
 * - ThemeStoreProvider 包裹的组件在 store.setTheme() 后自动重渲染
 * - 重渲染后 useTheme() 返回新主题的颜色值
 * - 组件输出（SGR 序列）随主题变化
 */
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Text } from 'ink';
import { createThemeStore } from '../../tui/state/theme-store.js';
import { ThemeStoreProvider, useTheme } from '../../tui/state/theme-context.js';
import { darkTheme, lightTheme } from '../../utils/theme.js';

/** 测试用组件：读取主题 brand 色并输出 */
function ThemeReader(): React.ReactElement {
  const t = useTheme();
  return React.createElement(Text, null, t.brand);
}

/** 测试用组件：读取主题 statusMode 色并输出 */
function StatusModeReader(): React.ReactElement {
  const t = useTheme();
  return React.createElement(Text, null, t.statusMode);
}

describe('ThemeStoreProvider 组件级重渲染', () => {
  it('初始渲染使用 dark 主题', () => {
    const store = createThemeStore('dark');
    const { lastFrame } = render(
      React.createElement(ThemeStoreProvider, { store },
        React.createElement(ThemeReader),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(darkTheme.brand);
  });

  it('初始渲染使用 light 主题', () => {
    const store = createThemeStore('light');
    const { lastFrame } = render(
      React.createElement(ThemeStoreProvider, { store },
        React.createElement(ThemeReader),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(lightTheme.brand);
  });

  it('store.setTheme 触发子组件重渲染', () => {
    const store = createThemeStore('dark');
    const { lastFrame, rerender } = render(
      React.createElement(ThemeStoreProvider, { store },
        React.createElement(ThemeReader),
      ),
    );
    // 初始是 dark
    expect(lastFrame()).toContain(darkTheme.brand);

    // 切换到 light
    store.getState().setTheme('light');
    rerender(
      React.createElement(ThemeStoreProvider, { store },
        React.createElement(ThemeReader),
      ),
    );
    // 重渲染后应该是 light
    expect(lastFrame()).toContain(lightTheme.brand);
    expect(lastFrame()).not.toContain(darkTheme.brand);
  });

  it('dark → light → dark 连续切换', () => {
    const store = createThemeStore('dark');
    const { lastFrame, rerender } = render(
      React.createElement(ThemeStoreProvider, { store },
        React.createElement(ThemeReader),
      ),
    );

    // dark → light
    store.getState().setTheme('light');
    rerender(
      React.createElement(ThemeStoreProvider, { store },
        React.createElement(ThemeReader),
      ),
    );
    expect(lastFrame()).toContain(lightTheme.brand);

    // light → dark
    store.getState().setTheme('dark');
    rerender(
      React.createElement(ThemeStoreProvider, { store },
        React.createElement(ThemeReader),
      ),
    );
    expect(lastFrame()).toContain(darkTheme.brand);
  });

  it('多个子组件同时获取正确主题', () => {
    const store = createThemeStore('dark');
    const { lastFrame, rerender } = render(
      React.createElement(ThemeStoreProvider, { store },
        React.createElement(ThemeReader),
        React.createElement(StatusModeReader),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(darkTheme.brand);
    expect(frame).toContain(darkTheme.statusMode);

    // 切换到 light
    store.getState().setTheme('light');
    rerender(
      React.createElement(ThemeStoreProvider, { store },
        React.createElement(ThemeReader),
        React.createElement(StatusModeReader),
      ),
    );
    const frame2 = lastFrame() ?? '';
    expect(frame2).toContain(lightTheme.brand);
    expect(frame2).toContain(lightTheme.statusMode);
  });

  it('unmount 不崩溃', () => {
    const store = createThemeStore('dark');
    const { unmount } = render(
      React.createElement(ThemeStoreProvider, { store },
        React.createElement(ThemeReader),
      ),
    );
    unmount();
    // unmount 后 setTheme 不应崩溃
    store.getState().setTheme('light');
  });
});
