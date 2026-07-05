// src/tui/components/LogoBox.tsx
// 固定 LOGO 区（不随消息滚动）
//
// 物理本质：屏幕底部、Footer 上方的「铭牌」。
// charter §顶层布局示例里没有独立 LOGO 区，但 LOGO 需要固定可见（不随 ScrollBox 滚走），
// 故在 App 布局的 ScrollBox 与 Footer 之间插入此 flexShrink=0 区块。
//
// 内容：3 行 ASCII art + 1 行 model/dir/branch/mode 信息（dimColor）。
// 这些静态信息原在 StatusBar，charter L89 把 StatusBar 简化为 tokens|elapsed 后，
// model/dir/branch/mode 移到此处常驻显示。

import React from 'react';
import { Box, Text } from 'ink';
import type { LogoData } from '../types.js';

export function LogoBox({ logo }: { logo: LogoData }): React.ReactElement {
  return (
    <Box flexShrink={0} flexDirection="column">
      <Text color="magenta"> ▐▛███▜▌   MiCode v{logo.version}</Text>
      <Text color="magenta">▝▜█████▛▘  TypeScript CLI · Node.js Runtime</Text>
      <Text color="magenta">  ▘▘ ▝▝    {logo.dir}</Text>
      <Text dimColor>model: {logo.model}  ·  branch: {logo.branch}  ·  mode: {logo.mode}</Text>
    </Box>
  );
}
