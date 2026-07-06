// src/tui/state/overlay-store.ts
// Ctrl+O 全屏覆盖层 store
//
// 物理本质：一个「模态视图」开关。visible=true 时 <App> 被 <Overlay> 替换，
// 显示最后一个可折叠块（thinking/tool_result）的完整内容。
// 数据源：BlockPipeline.getLastExpandableFullLines()（已存在于新栈）。

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { FormattedLine } from '../../ui/types.js';

export interface OverlayState {
  visible: boolean;
  title: string;
  lines: FormattedLine[];
  open: (title: string, lines: FormattedLine[]) => void;
  close: () => void;
}

export type OverlayStore = StoreApi<OverlayState>;

export function createOverlayStore(): OverlayStore {
  return createStore<OverlayState>((set) => ({
    visible: false,
    title: '',
    lines: [],
    open: (title, lines) => set({ visible: true, title, lines }),
    close: () => set({ visible: false, title: '', lines: [] }),
  }));
}
