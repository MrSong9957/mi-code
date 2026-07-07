// src/tui/components/LogoBox.tsx
// 固定 LOGO 区（不随消息滚动，支持字符级选区高亮）。
//
// 物理本质：屏幕顶部的「铭牌」。3 行 ASCII art + 版本 + 当前目录。
// 选区高亮：每行用 SelectionText（自订阅 selectionStore，蓝底黑字切片）。

import React from 'react';
import { Box } from 'ink';
import type { LogoData } from '../types.js';
import { SelectionText } from './SelectionText.js';
import type { SelectionStore } from '../state/selection-store.js';

/** LOGO 行 0 起的全局行号（与 App.tsx LOGO_ROWS 一致） */
const LOGO_BASE_ROW = 0;

export interface LogoBoxProps {
  logo: LogoData;
  /** 选区 store（由 ConnectedApp 注入；SelectionText 自订阅） */
  selectionStore?: SelectionStore;
}

export function LogoBox({ logo, selectionStore }: LogoBoxProps): React.ReactElement {
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
          selectionStore={selectionStore}
          baseProps={{ color: 'magenta' }}
        />
      ))}
    </Box>
  );
}
