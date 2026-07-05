// src/tui/state/logo-store.ts
// 固定 LOGO 区数据（zustand vanilla）
//
// 物理本质：LOGO 铭牌的「内容表」。
// 只承载 version + dir（静态，启动时定）。mode/model/branch 在 StatusBar 显示，不在此重复。
// LogoBox 订阅此 store 渲染 ASCII art + 版本 + 目录。

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { LogoData } from '../types.js';

export type LogoStore = StoreApi<LogoData>;

export function createLogoStore(init: LogoData): LogoStore {
  return createStore<LogoData>(() => ({
    version: init.version,
    dir: init.dir,
  }));
}
