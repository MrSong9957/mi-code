// src/tui/components/StatusBar.tsx
// 状态栏：tokens + elapsed（charter §顶层布局 L89）
//
// 物理本质：footer 最底一行，本次 agent turn 的「计数器」。
// 严格对齐 charter L89：`tokens: {tokenCount} | {elapsed}s`（dimColor 单行）。
// mode/model/branch/dir 等静态信息在 LogoBox（固定 LOGO 区），不在状态栏。

import React from 'react';
import { Text } from 'ink';
import type { StatusBarData } from '../types.js';

export function StatusBar({ status }: { status: StatusBarData }): React.ReactElement {
  return (
    <Text dimColor>tokens: {status.tokenCount} | {status.elapsedSec}s</Text>
  );
}
