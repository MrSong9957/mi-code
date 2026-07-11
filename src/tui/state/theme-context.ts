// src/tui/state/theme-context.ts
// React Context：主题上下文，让任何组件都能获取当前主题
//
// 物理本质：一根从顶层垂下来的「主题电线」。
// bootstrap 在顶层注入 ThemeStoreProvider（订阅 theme-store），
// 子组件通过 useTheme() 接入，不需要层层传递 props。
// /theme 命令更新 store → Provider 重渲染 → 子组件拿到新主题。

import React, { createContext, useContext, useState, useEffect } from 'react';
import { getTheme as getDefaultTheme, type Theme, type ThemeName } from '../../utils/theme.js';
import type { ThemeStore } from './theme-store.js';

/** 默认 context 值：dark 主题（防止 Provider 缺失时崩溃） */
const ThemeContext = createContext<Theme>(getDefaultTheme('dark'));

/** Provider 组件：注入当前主题 */
export const ThemeProvider = ThemeContext.Provider;

/**
 * 获取当前主题（组件内使用）。
 *
 * @example
 * const t = useTheme();
 * return <Text color={t.brand}>Hello</Text>;
 */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * 从 themeName 获取主题（非组件场景，如测试/工具函数）。
 */
export { getDefaultTheme as getTheme };
export type { ThemeName };

// ─────────────── 运行时切换 Provider ───────────────

export interface ThemeStoreProviderProps {
  store: ThemeStore;
  children?: React.ReactNode;
}

/**
 * 订阅 theme-store 的 Provider 组件。
 * store.themeName 变化时自动重渲染子组件。
 */
export function ThemeStoreProvider({ store, children }: ThemeStoreProviderProps): React.ReactElement {
  const [themeName, setThemeName] = useState<ThemeName>(store.getState().themeName);

  useEffect(() => {
    return store.subscribe((state) => {
      setThemeName(state.themeName);
    });
  }, [store]);

  const theme = getDefaultTheme(themeName);
  return React.createElement(ThemeProvider, { value: theme }, children);
}
