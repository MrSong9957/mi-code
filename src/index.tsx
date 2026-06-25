#!/usr/bin/env node
import React, { useState, useEffect } from 'react';
import { render, Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { execSync } from 'child_process';

const VERSION = "1.0.0";
const MODEL = "mimo-v2.5-pro";

function getGitBranch(): string {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); }
  catch { return 'no-git'; }
}

function getShortDir(): string {
  return process.cwd().replace(/\\/g, '/').split('/').slice(-2).join('/');
}

// 启动时缓存，避免每次渲染 spawn 子进程
const GIT_BRANCH = getGitBranch();
const SHORT_DIR = getShortDir();

// --- Components ---

const Banner = React.memo(() => (
  <Box flexDirection="column" marginBottom={1}>
    <Text color="cyan"> ▐▛███▜▌   <Text bold color="white">MiCode</Text> <Text dimColor>v{VERSION}</Text></Text>
    <Text color="cyan">▝▜█████▛▘  <Text dimColor>TypeScript CLI · Node.js Runtime</Text></Text>
    <Text color="cyan">  ▘▘ ▝▝    <Text dimColor>{process.cwd()}</Text></Text>
  </Box>
));

interface StatusItem { label: string; color?: string }

const STATUS_LEFT_ITEMS: StatusItem[] = [
  { label: 'Plan', color: 'yellow' },
  { label: MODEL, color: 'cyan' },
  { label: SHORT_DIR, color: 'blue' },
  { label: GIT_BRANCH, color: 'magenta' },
];

const StatusBar = React.memo(({ leftItems, systemMessage, systemColor }: {
  leftItems: StatusItem[];
  systemMessage?: string;
  systemColor?: string;
}) => {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!systemMessage) { setVisible(false); return; }
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
            <Text bold color={item.color}>{item.label}</Text>
          </React.Fragment>
        ))}
      </Box>
      {visible && systemMessage && (
        <Text color={systemColor}>{systemMessage}</Text>
      )}
    </Box>
  );
});

function App() {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState<string[]>([]);

  const handleSubmit = (value: string) => {
    if (value.trim() === 'exit') process.exit(0);
    if (value.trim()) setMessages(prev => [...prev, `> ${value}`]);
    setQuery('');
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Banner />

      <Box flexDirection="column" marginBottom={1}>
        {messages.length === 0 ? (
          <Text dimColor>Welcome to MiCode. Type something to start.</Text>
        ) : messages.map((msg, i) => <Text key={i}>{msg}</Text>)}
      </Box>

      <Box borderStyle="single" borderColor="white" paddingX={1} flexDirection="row">
        <Box marginRight={1}>
          <Text bold color="white">❯</Text>
        </Box>
        <TextInput value={query} onChange={setQuery} onSubmit={handleSubmit} placeholder="Type 'help' to get started..." />
      </Box>

      <StatusBar leftItems={STATUS_LEFT_ITEMS} systemMessage="Ready" systemColor="green" />
    </Box>
  );
}

render(<App />);
