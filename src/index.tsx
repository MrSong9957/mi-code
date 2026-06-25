#!/usr/bin/env node
// src/index.tsx
import React, { useState, useEffect } from 'react';
import { render, Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { execSync } from 'child_process';

const VERSION = "1.0.0";
const MODEL = "mimo-v2.5-pro";

// 获取 git 分支名
function getGitBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'no-git';
  }
}

// 获取目录最后 2 层
function getShortDir(): string {
  const cwd = process.cwd();
  const parts = cwd.replace(/\\/g, '/').split('/');
  return parts.slice(-2).join('/');
}

// 状态栏项配置
interface StatusItem {
  label: string;
  color?: string;
}

// 状态栏组件：左侧用户自定义（始终显示），右侧系统消息（自动消失）
function StatusBar({ leftItems, systemMessage, systemColor }: {
  leftItems: StatusItem[];
  systemMessage?: string;
  systemColor?: string;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!systemMessage) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(timer);
  }, [systemMessage]);

  return (
    <Box flexDirection="row" justifyContent="space-between" marginTop={0}>
      <Box flexDirection="row">
        {leftItems.map((item, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Text color="gray"> | </Text>}
            <Text bold color={item.color as any}>{item.label}</Text>
          </React.Fragment>
        ))}
      </Box>
      {visible && systemMessage && (
        <Text color={systemColor as any}>{systemMessage}</Text>
      )}
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
      <Box borderStyle="single" borderColor="white" paddingX={1} flexDirection="row">
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
        leftItems={[
          { label: 'Plan', color: 'yellow' },
          { label: MODEL, color: 'cyan' },
          { label: getShortDir(), color: 'blue' },
          { label: getGitBranch(), color: 'magenta' },
        ]}
        systemMessage="Ready"
        systemColor="green"
      />
    </Box>
  );
}

// 启动大厂画布引擎
render(<App />);