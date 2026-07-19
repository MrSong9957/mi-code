// Ink createIncremental + React.memo POC
//
// 目标:验证 stock Ink 7.1.0 在 spinner 高频 tick(50ms)下:
//   1. <Static> 已固化行是否只写一次(进 scrollback)
//   2. createIncremental 行级 diff 是否只重写变化行(spinner 行)
//   3. React.memo 包裹的未变子组件是否跳过重渲染
//
// 测量:
//   - 每帧 stdout 写入字节数
//   - 每帧写入内容是否含未变行(footer/statusbar)
//   - spinner tick 次数 vs 实际 stdout write 次数

import { render, Box, Text, Static, useStdout } from 'ink';
import React, { memo, useState, useEffect } from 'react';

// ─── Mock stdout:捕获所有写入 ─────────────────────────────
class MockStdout {
  writes: { time: number; data: string; bytes: number }[] = [];
  columns = 80;
  rows = 24;
  isTTY = true; // 关键:必须 true,让 Ink 走交互路径(createIncremental/createStandard)

  constructor() {
    // 重置
    this.writes = [];
  }

  write(data: string | Uint8Array): boolean {
    const s = typeof data === 'string' ? data : Buffer.from(data).toString();
    this.writes.push({
      time: Date.now(),
      data: s,
      bytes: Buffer.byteLength(s),
    });
    return true;
  }

  on(): boolean { return false; }
  off(): boolean { return false; }
  resume(): void {}
  pause(): void {}
  end(): void {}
  cork(): void {}
  uncork(): void {}
  destroy(): void {}
  writev(): boolean { return true; }
  getDefaultHighWaterMark(): number { return 16384; }
  getBytesRead(): number { return 0; }
  getBytesWritten(): number { return 0; }
  isRaw?: boolean;
  setRawMode(): boolean { return false; }
  ref(): void {}
  unref(): void {}
  // NodeJS stream 必需
  readable = false;
  writable = true;
  destroyed = false;
  encoding: BufferEncoding | null = null;
  readonly readableLength = 0;
  readonly writableLength = 0;
  readonly readableHighWaterMark = 0;
  readonly writableHighWaterMark = 0;
  readonly readableFlowing: boolean | null = null;
  readonly readableObjectMode = false;
  readonly writableObjectMode = false;
  readonly readableEnded = false;
  readonly writableEnded = false;
  readonly writableFinished = false;
  readonly writableCorked = 0;
  readonly closed = false;
  readonly errored: Error | null = null;
  readonly writableNeedDrain = false;
  readonly writableObjectModeFlag = false;
  readonly autoDestroy = false;
  readonly emitClose = true;
  readonly highWaterMark = 16384;
  readonly objectMode = false;
  readonly decodeStrings = true;
  readonly signal: AbortSignal | undefined = undefined;
  // event emitter
  listeners(): (() => void)[] { return []; }
  rawListeners(): (() => void)[] { return []; }
  eventNames(): (string | symbol)[] { return []; }
  getMaxListeners(): number { return 10; }
  setMaxListeners(): this { return this; }
  addListener(): this { return this; }
  removeListener(): this { return this; }
  off(): this { return this; }
  removeAllListeners(): this { return this; }
  once(): this { return this; }
  prependListener(): this { return this; }
  prependOnceListener(): this { return this; }
  emit(): boolean { return false; }
  listenerCount(): number { return 0; }
  // write signature 兼容
  // @ts-expect-error - mock 简化
  constructor_private = 0;
}

// ─── Spinner 组件(每 50ms tick) ──────────────────────────
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽'] as const;

function SpinnerImpl({ time }: { time: number }) {
  const frame = FRAMES[Math.floor(time / 120) % FRAMES.length];
  return (
    <Text color="green">
      {frame} Working... ({time}ms)
    </Text>
  );
}

const Spinner = memo(SpinnerImpl);

// ─── Footer 组件(memo 包,props 不变则跳过重渲染) ────────
function FooterImpl({ input }: { input: string }) {
  return <Text color="gray">{'─'.repeat(60)}</Text>;
}
const FooterLine = memo(FooterImpl);

function StatusBarImpl({ model }: { model: string }) {
  return <Text color="cyan">build │ {model} │ main</Text>;
}
const StatusBar = memo(StatusBarImpl);

// ─── 主组件 ──────────────────────────────────────────────
interface AppProps {
  finalizedMessages: { id: number; text: string }[];
}

function App({ finalizedMessages }: AppProps) {
  const [time, setTime] = useState(0);
  const [tick, setTick] = useState(0);

  // 模拟 spinner clock:50ms tick
  useEffect(() => {
    const id = setInterval(() => {
      setTime(t => t + 50);
      setTick(t => t + 1);
    }, 50);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <Static items={finalizedMessages}>
        {(msg) => <Text key={msg.id}>[Finalized {msg.id}] {msg.text}</Text>}
      </Static>
      {/* 活动区:spinner + 未变 footer + 未变 statusbar */}
      <Box flexDirection="column">
        <Spinner time={time} />
        <FooterLine input="" />
        <Text color="green">{'❯ '}</Text>
        <FooterLine input="" />
        <StatusBar model="sonnet" />
      </Box>
    </>
  );
}

// ─── 主程序:跑 1 秒后分析输出 ────────────────────────────
async function main(): Promise<void> {
  const stdout = new MockStdout();

  const finalizedMessages = [
    { id: 1, text: 'Hello, this is message 1.' },
    { id: 2, text: 'Hello, this is message 2.' },
    { id: 3, text: 'Hello, this is message 3.' },
  ];

  // 关键:incrementalRendering=true
  const instance = render(
    <App finalizedMessages={finalizedMessages} />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: true,
    },
  );

  // 跑 600ms(12 个 spinner tick)
  await new Promise(r => setTimeout(r, 600));

  instance.unmount();
  instance.waitUntilRenderFlush?.();

  // ─── 分析输出 ───
  console.error('\n========== POC 分析结果 ==========\n');
  console.error(`总写入次数: ${stdout.writes.length}`);
  console.error(`总写入字节: ${stdout.writes.reduce((s, w) => s + w.bytes, 0)}`);

  // 分析每帧:是否含 "Finalized"(static 行)
  const framesWithStatic = stdout.writes.filter(w => w.data.includes('Finalized'));
  const framesWithSpinner = stdout.writes.filter(w => w.data.includes('Working'));
  const framesWithFooter = stdout.writes.filter(w => w.data.includes('─'));
  const framesWithStatus = stdout.writes.filter(w => w.data.includes('sonnet'));

  console.error(`\n含 'Finalized'(Static)的帧数: ${framesWithStatic.length}`);
  console.error(`含 'Working'(spinner)的帧数: ${framesWithSpinner.length}`);
  console.error(`含 '─'(footer border)的帧数: ${framesWithFooter.length}`);
  console.error(`含 'sonnet'(statusbar)的帧数: ${framesWithStatus.length}`);

  // 详细列出前 5 帧
  console.error('\n--- 前 5 帧详情 ---');
  for (let i = 0; i < Math.min(5, stdout.writes.length); i++) {
    const w = stdout.writes[i];
    console.error(`\n[帧 ${i}] ${w.bytes} bytes:`);
    // 转义控制字符方便阅读
    const printable = w.data
      .replace(/\x1b\[/g, '\\e[')
      .replace(/\n/g, '\\n\n');
    console.error(printable);
  }

  // 列出所有非 0 字节帧的简要信息
  console.error('\n--- 所有非空帧摘要 ---');
  for (let i = 0; i < stdout.writes.length; i++) {
    const w = stdout.writes[i];
    if (w.bytes === 0) continue;
    // 提取 spinner time
    const timeMatch = w.data.match(/\((\d+)ms\)/);
    const time = timeMatch ? timeMatch[1] : '-';
    const hasFinalized = w.data.includes('Finalized');
    const hasFooter = w.data.includes('─');
    const hasStatus = w.data.includes('sonnet');
    const hasSpinner = w.data.includes('Working');
    console.error(`[帧 ${i}] ${w.bytes}B | spinner time=${time} | F=${hasFinalized?'1':'0'} S=${hasSpinner?'1':'0'} B=${hasFooter?'1':'0'} St=${hasStatus?'1':'0'}`);
  }

  // 关键指标
  console.error('\n========== 关键指标 ==========');
  console.error(`预期 spinner tick 次数: ~12`);
  console.error(`实际 stdout 写入次数: ${stdout.writes.length}`);
  if (stdout.writes.length > 0) {
    const avgBytes = stdout.writes.reduce((s, w) => s + w.bytes, 0) / stdout.writes.length;
    console.error(`平均每帧字节: ${avgBytes.toFixed(0)}`);
    console.error(`最小帧字节: ${Math.min(...stdout.writes.map(w => w.bytes))}`);
    console.error(`最大帧字节: ${Math.max(...stdout.writes.map(w => w.bytes))}`);
  }
}

main().catch(e => {
  console.error('POC 失败:', e);
  process.exit(1);
});
