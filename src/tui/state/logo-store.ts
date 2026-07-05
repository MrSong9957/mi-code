// src/tui/state/logo-store.ts
// 固定 LOGO 区数据（zustand vanilla）
//
// 物理本质：LOGO 铭牌的「内容表」。
// version/dir/model/branch 基本静态（启动时定）；mode 随权限切换（plan/build/auto）变。
// LogoBox 订阅此 store 渲染，mode 变化时 LOGO 行自动刷新。

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { LogoData } from '../types.js';

export interface LogoState extends LogoData {
  /** 更新权限模式（plan/build/auto 切换时调用） */
  setMode: (mode: string) => void;
}

export type LogoStore = StoreApi<LogoState>;

export function createLogoStore(init: LogoData): LogoStore {
  return createStore<LogoState>((set) => ({
    ...init,
    setMode: (mode) => set({ mode }),
  }));
}
