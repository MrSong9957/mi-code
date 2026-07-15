// src/tui/hooks/useTerminalSize.ts
// 终端尺寸 hook：响应 resize，返回 { rows, cols }
//
// 物理本质：终端窗口大小变化的「传感器」。
// Ink + Yoga 会自动响应 stdout 的 columns/rows 变化重排，但应用层（如 ScrollBox
// 的 visibleRows、Footer 的边框宽度）需要显式拿到尺寸，故提供此 hook。
//
// 数据源：useStdout().stdout（NodeJS.WriteStream，含 columns/rows）。
// 监听 'resize' 事件，setState 触发重渲染。
// 默认值：columns 80 / rows 24（无 TTY 时）。

import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  rows: number;
  cols: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => ({
    rows: stdout?.rows ?? 24,
    cols: stdout?.columns ?? 80,
  }));

  useEffect(() => {
    if (!stdout) return;
    const handler = (): void => {
      const next = { rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 };
      // 同尺寸去重：连续 resize 事件如果尺寸相同则跳过（ink.tsx:314-315 同策略）。
      // 防止拖拽窗口时相同尺寸的中间事件重复触发重渲染。
      setSize(prev => {
        if (prev.rows === next.rows && prev.cols === next.cols) return prev;
        return next;
      });
    };
    handler(); // 初始化同步一次
    stdout.on('resize', handler);
    return () => {
      stdout.off('resize', handler);
    };
  }, [stdout]);

  return size;
}
