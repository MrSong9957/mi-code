// src/tui/components/LogoBox.tsx
// 固定 LOGO 区（不随消息滚动，支持字符级选区高亮）。
//
// 物理本质：屏幕顶部的「铭牌」。3 行 ASCII art + 版本 + 当前目录。
// 选区高亮：每行订阅 selectionStore，复用 SelectionText 蓝底黑字切片。

import React from 'react';
import { Box } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import type { LogoData } from '../types.js';
import { SelectionText } from './SelectionText.js';
import type { SelectionStore, Point } from '../state/selection-store.js';

/** selectionStore 缺省时的占位 store（与 MessageRow 同模式） */
const _noopStore = createStore<{ anchor: Point | null; focus: Point | null }>(() => ({
  anchor: null,
  focus: null,
}));

/** LOGO 行 0 起的全局行号（与 App.tsx LOGO_ROWS 一致） */
const LOGO_BASE_ROW = 0;

export interface LogoBoxProps {
  logo: LogoData;
  /** 选区 store（由 ConnectedApp 注入，支持选区高亮） */
  selectionStore?: SelectionStore;
}

export function LogoBox({ logo, selectionStore }: LogoBoxProps): React.ReactElement {
  // 订阅选区 anchor/focus
  const sel = useStore(
    selectionStore ?? _noopStore,
    useShallow((s: { anchor: Point | null; focus: Point | null }) => ({ anchor: s.anchor, focus: s.focus })),
  );

  const lines = [
    ` ▐▛███▜▌   MiCode v${logo.version}`,
    '▝▜█████▛▘  TypeScript CLI · Node.js Runtime',
    `  ▘▘ ▝▝    ${logo.dir}`,
  ];

  return (
    <Box flexShrink={0} flexDirection="column">
      {lines.map((text, i) => (
        <SelectionText
          key={i}
          content={text}
          globalRow={LOGO_BASE_ROW + i}
          anchor={sel.anchor}
          focus={sel.focus}
          baseProps={{ color: 'magenta' }}
        />
      ))}
    </Box>
  );
}
