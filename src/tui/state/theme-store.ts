// src/tui/state/theme-store.ts
// 主题状态 store：持有当前主题名，支持运行时切换
//
// 物理本质：一根可以随时换颜色的「主题电线」的开关。
// zustand store 持有 themeName，/theme 命令调用 setTheme()，
// ThemeStoreProvider 订阅 store 自动重渲染子组件。

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ThemeName } from '../../utils/theme.js';

interface ThemeState {
  themeName: ThemeName;
  setTheme: (name: ThemeName) => void;
}

export type ThemeStore = StoreApi<ThemeState>;

export function createThemeStore(initial: ThemeName = 'dark'): ThemeStore {
  return createStore<ThemeState>((set) => ({
    themeName: initial,
    setTheme: (name) => set({ themeName: name }),
  }));
}
