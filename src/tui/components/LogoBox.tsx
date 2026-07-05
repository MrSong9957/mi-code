// src/tui/components/LogoBox.tsx
// 固定 LOGO 区（不随消息滚动）
//
// 物理本质：屏幕底部、Footer 上方的「铭牌」。
// charter §顶层布局示例里没有独立 LOGO 区，但 LOGO 需要固定可见（不随 ScrollBox 滚走），
// 故在 App 布局的 ScrollBox 与 Footer 之间插入此 flexShrink=0 区块。
//
// 内容：3 行 ASCII art + 版本 + 当前目录。mode/model/branch 在 StatusBar 显示，不在此重复。

import React from 'react';
import { Box, Text } from 'ink';
import type { LogoData } from '../types.js';

export function LogoBox({ logo }: { logo: LogoData }): React.ReactElement {
  return (
    <Box flexShrink={0} flexDirection="column">
      <Text color="magenta"> ▐▛███▜▌   MiCode v{logo.version}</Text>
      <Text color="magenta">▝▜█████▛▘  TypeScript CLI · Node.js Runtime</Text>
      <Text color="magenta">  ▘▘ ▝▝    {logo.dir}</Text>
    </Box>
  );
}
