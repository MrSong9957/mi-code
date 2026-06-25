#!/usr/bin/env tsx
// src/index.tsx
import React, { useState } from 'react';
import { render, Box, Text } from 'ink';
import TextInput from 'ink-text-input'; // 注：大厂通常会用这个标准的输入组件

const VERSION = "1.0.0";

// 状态栏项配置
interface StatusItem {
  label: string;
  color?: string;
}

// 状态栏组件：左 · 中 · 右 三栏
function StatusBar({ left, center, right }: { left?: StatusItem; center?: StatusItem; right?: StatusItem }) {
  return (
    <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
      <Text dimColor>{left ? <Text color={left.color as any}>{left.label}</Text> : ''}</Text>
      <Text dimColor>{center ? <Text color={center.color as any}>{center.label}</Text> : ''}</Text>
      <Text dimColor>{right ? <Text color={right.color as any}>{right.label}</Text> : ''}</Text>
    </Box>
  );
}

// 我们的极简 Banner 组件
function Banner() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan"> ▐▛███▜▌   <Text bold color="white">MiCode</Text> <Text dimColor>v{VERSION}</Text></Text>
      <Text color="cyan">▝▜█████▛▘  <Text dimColor>TypeScript CLI · Node.js Runtime</Text></Text>
      <Text color="cyan">  ▘▘ ▝▝    <Text dimColor>{process.cwd()}</Text></Text>
    </Box>
  );
}

// 核心大厂主应用组件
function App() {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState<string[]>([]);

  const handleSubmit = (value: string) => {
    if (value.trim() === 'exit') {
      process.exit(0);
    }
    if (value.trim()) {
      setMessages(prev => [...prev, `> ${value}`]);
    }
    setQuery('');
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* 1. 头部 Banner */}
      <Banner />

      {/* 2. 消息输出区 */}
      <Box flexDirection="column" marginBottom={1}>
        {messages.length === 0 ? (
          <Text dimColor>Welcome to MiCode. Type something to start.</Text>
        ) : (
          messages.map((msg, i) => (
            <Text key={i}>{msg}</Text>
          ))
        )}
      </Box>

      {/* 3. 输入框 */}
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

      {/* 4. 状态栏 */}
      <StatusBar
        left={{ label: 'Ready', color: 'green' }}
        center={{ label: `v${VERSION}` }}
        right={{ label: process.cwd(), color: 'gray' }}
      />
    </Box>
  );
}

// 启动大厂画布引擎
render(<App />);