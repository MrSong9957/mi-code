// src/tui/components/Overlay.tsx
// 全屏覆盖层：visible 时替换 <App>，显示可折叠块完整内容
//
// 物理本质：charter 铁律「禁止手动 CUP」，故用 React 条件渲染 <Overlay> 替代 <App>，
// 而非旧实现的 saveCursor + eraseScreen 原生 ANSI。
// Yoga 自动重算布局；dismiss 后 overlay.visible=false → <App> 回归。
//
// 关闭键（在 use-input-handler 的 overlay 分支处理）：q / Ctrl+O / Esc / Ctrl+C（退出）。

import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import stringWidth from 'string-width';
import type { OverlayStore } from '../state/overlay-store.js';
import { styleToInkProps } from '../types.js';
import { useTheme } from '../state/theme-context.js';

export interface OverlayProps {
  store: OverlayStore;
  /** 终端列数（行截断用） */
  cols: number;
}

export function Overlay({ store, cols }: OverlayProps): React.ReactElement | null {
  const t = useTheme();
  const visible = useStore(store, (s) => s.visible);
  const title = useStore(store, (s) => s.title);
  const lines = useStore(store, (s) => s.lines);

  if (!visible) return null;
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text color={t.border}>{'━'.repeat(Math.min(cols, 60))}</Text>
      {lines.map((l, i) => {
        const indentNum = l.indent ?? 0;
        const indent = ' '.repeat(indentNum);
        // 按显示宽度截断（CJK 全角=2 列），与 cursorScreenPos 同源。
        // 逐码点累加，直到下一个码点会让显示宽度超过剩余列宽。
        const maxDisplayWidth = Math.max(0, cols - indentNum);
        let used = 0;
        let truncated = '';
        for (const ch of l.content) {
          const w = stringWidth(ch);
          if (used + w > maxDisplayWidth) break;
          truncated += ch;
          used += w;
        }
        const props = styleToInkProps(l.style);
        return (
          <Text key={i} {...props}>{indent}{truncated}</Text>
        );
      })}
      <Text> </Text>
      <Text dimColor>按 q / Ctrl+O / Esc 返回</Text>
    </Box>
  );
}
