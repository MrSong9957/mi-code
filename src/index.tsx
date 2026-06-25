#!/usr/bin/env tsx
// src/index.tsx
import React, { useState } from 'react';
import { render, Box, Text } from 'ink';
import TextInput from 'ink-text-input'; // 注：大厂通常会用这个标准的输入组件

const VERSION = "1.0.0";

// 我们的极简 Banner 组件
function Banner() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan">▐▛███▜▌   <Text bold color="white">MiCode</Text> <Text dimColor>v{VERSION}</Text></Text>
      <Text color="cyan">▝▜█████▛▘  <Text dimColor>TypeScript CLI · Node.js Runtime</Text></Text>
      <Text color="cyan">  ▘▘ ▝▝    <Text dimColor>{process.cwd()}</Text></Text>
    </Box>
  );
}

// 核心大厂主应用组件
function App() {
  const [query, setQuery] = useState('');

  const handleSubmit = (value: string) => {
    if (value.trim() === 'exit') {
      process.exit(0);
    }
    // 这里处理你的业务逻辑...
    setQuery(''); // 敲完回车清空输入框
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* 1. 头部 Banner */}
      <Banner />

      {/* 2. 【大厂精髓】：工业级输入框 */}
      {/* borderStyle="single" 会自动画出完美的、怎么缩放都绝对不崩的上下左右边框 */}
      <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="row">
        <Box marginRight={1}>
          <Text bold color="white">❯</Text>
        </Box>
        <TextInput 
          value={query} 
          onChange={setQuery} 
          onSubmit={handleSubmit} 
          placeholder="Type 'help' to get started..."
        />
      </Box>
    </Box>
  );
}

// 启动大厂画布引擎
render(<App />);