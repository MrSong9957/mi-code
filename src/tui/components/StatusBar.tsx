// src/tui/components/StatusBar.tsx
// 状态栏：mode | model | dir | branch | [进度条] pct%
//
// 物理本质：footer 最底一行，会话元信息的「仪表盘」。
// 选区高亮：订阅 selectionStore，当选区覆盖状态栏行时整行用 SelectionText 切片
// （蓝底黑字覆盖原彩色）；无相交时保持多段彩色。

import React from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import { Text } from 'ink';
import type { StatusBarData } from '../types.js';
import { SelectionText } from './SelectionText.js';
import type { SelectionStore, Point } from '../state/selection-store.js';
import { useTheme } from '../state/theme-context.js';

const BAR_WIDTH = 10;

const _noopStore = createStore<{ anchor: Point | null; focus: Point | null }>(() => ({
  anchor: null, focus: null,
}));

function splitBar(pct: number): { filled: string; empty: string; label: string } {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * BAR_WIDTH);
  return {
    filled: '█'.repeat(filled),
    empty: '░'.repeat(BAR_WIDTH - filled),
    label: `${Math.round(clamped * 100)}%`,
  };
}

function statusBarContent(status: StatusBarData): string {
  const bar = splitBar(status.contextPct);
  return `${status.mode} │ ${status.model} │ ${status.dir} │ ${status.branch} │ ${bar.filled}${bar.empty} ${bar.label}`;
}

export interface StatusBarProps {
  status: StatusBarData;
  selectionStore?: SelectionStore;
  globalRow?: number;
}

export function StatusBar({ status, selectionStore, globalRow }: StatusBarProps): React.ReactElement {
  const t = useTheme();
  const sel = useStore(
    selectionStore ?? _noopStore,
    useShallow((s: { anchor: Point | null; focus: Point | null }) => ({ anchor: s.anchor, focus: s.focus })),
  );

  const intersects = globalRow !== undefined && sel.anchor && sel.focus
    && Math.min(sel.anchor.row, sel.focus.row) <= globalRow
    && Math.max(sel.anchor.row, sel.focus.row) >= globalRow;

  if (intersects) {
    return (
      <SelectionText
        content={statusBarContent(status)}
        globalRow={globalRow}
        selectionStore={selectionStore}
      />
    );
  }

  const bar = splitBar(status.contextPct);
  return (
    <Text>
      <Text color={t.statusMode} bold>{status.mode}</Text>
      <Text color={t.statusEmpty}> │ </Text>
      <Text color={t.statusModel} bold>{status.model}</Text>
      <Text color={t.statusEmpty}> │ </Text>
      <Text color={t.statusDir} bold>{status.dir}</Text>
      <Text color={t.statusEmpty}> │ </Text>
      <Text color={t.statusBranch} bold>{status.branch}</Text>
      <Text color={t.statusEmpty}> │ </Text>
      <Text color={t.statusFill} bold>{bar.filled}</Text>
      <Text color={t.statusEmpty}>{bar.empty}</Text>
      <Text color={t.statusEmpty}> {bar.label}</Text>
    </Text>
  );
}
