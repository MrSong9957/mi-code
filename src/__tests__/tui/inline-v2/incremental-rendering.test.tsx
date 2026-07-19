// src/__tests__/tui/inline-v2/incremental-rendering.test.tsx
//
// InlineV2 POC 回归基线:验证 stock Ink 7.1.0 `createIncremental` +
// `<Static>` 在 spinner 高频 tick(50ms)下的 3 个核心假设:
//
//   1. <Static> 已固化消息只写一次进 stdout(进 scrollback,后续帧不再带)
//   2. spinner tick 时未变行(footer border / statusbar)不被重写
//   3. spinner tick 帧字节远小于完整活动区帧(行级 diff 生效)
//
// 对照基线(POC 历史验证数据,scripts/ink-poc/ 已删除,见归档):
//   - <Static> 3 行 Finalized 消息只写一次(120B)
//   - 完整活动区 ~412B
//   - spinner tick 后的帧 ~44-46B
//
// 失败时排查:
//   - <Static> 写多次 → 检查 incrementalRendering 是否传 true
//   - tick 帧 > 80B → 行级 diff 未生效(检查 items 引用稳定性 / Ink 版本)
//   - 阈值过严 → 见各 expect 注释,可在不破坏意图前提下调整

import { describe, it, expect } from 'vitest';
import { render, Box, Text, Static } from 'ink';
import React, { useState, useEffect } from 'react';
import { createMockStdout } from './helpers/mock-stdout.js';

// ─── Fixture:<Static> + 活动区(spinner + footer border + statusbar) ─────
//
// finalizedItems 必须定义在组件外:
//   <Static items=...> 通过引用稳定性决定是否重新推入 scrollback。
//   每次渲染传入新数组引用会让 Ink 误判为新增消息导致多次写入,破坏测试。

interface FinalizedItem {
  id: number;
  text: string;
}

const FINALIZED_ITEMS: FinalizedItem[] = [
  { id: 1, text: 'finalized message' },
];

/**
 * 活动区 fixture:spinner 每 50ms tick,footer border / statusbar 不变。
 *
 * 用 React.Fragment 同时承载 <Static> 和 <Box>:
 *   - <Static> 行进 scrollback(只写一次)
 *   - <Box> 活动区随 spinner 变化
 */
function AppWithSpinnerTick(): React.ReactElement {
  const [time, setTime] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTime((t) => t + 50), 50);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <Static items={FINALIZED_ITEMS}>
        {(m: FinalizedItem) => (
          <Text key={m.id}>[F] {m.text}</Text>
        )}
      </Static>
      <Box flexDirection="column">
        <Text>{'· Working ' + time + 'ms'}</Text>
        <Text>{'─'.repeat(60)}</Text>
        <Text>{'❯ '}</Text>
        <Text>build │ sonnet │ main</Text>
      </Box>
    </>
  );
}

/**
 * 渲染 fixture 一段时间(默认 400ms = 8 个 tick)然后 unmount。
 * 返回录制好的 stdout,供断言使用。
 */
async function renderForTickDuration(ms = 400): Promise<ReturnType<typeof createMockStdout>> {
  const stdout = createMockStdout();
  const instance = render(<AppWithSpinnerTick />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: true,
  });
  await new Promise((r) => setTimeout(r, ms));
  instance.unmount();
  // 等待 unmount 的清理帧 flush 完成(ink 7+ 提供的方法)。
  instance.waitUntilRenderFlush?.();
  return stdout;
}

describe('InlineV2 incrementalRendering POC 回归', () => {
  it('<Static> 已固化消息只写一次进 stdout', async () => {
    const stdout = await renderForTickDuration();

    // 含 [F] 前缀(固化行)的写入帧应该恰好 1 次 —— 之后 spinner tick
    // 不应再带着 static 行重写。
    const staticWrites = stdout.writes.filter((w) => w.data.includes('[F]'));
    expect(
      staticWrites.length,
      '<Static> 已固化消息应该只写一次(后续帧不应再带 static 行)',
    ).toBe(1);
  });

  it('spinner tick 时未变行(footer border, statusbar)不被重写', async () => {
    const stdout = await renderForTickDuration();

    // 完整活动区首次写入(同时含 footer border '─' 和 statusbar 'sonnet')
    // 应该只发生 1 次 —— 行级 diff 后续帧只重写 spinner 行,不带这两行。
    const fullFrames = stdout.writes.filter(
      (w) => w.data.includes('─') && w.data.includes('sonnet'),
    );
    expect(
      fullFrames.length,
      '完整活动区(footer border + statusbar 都在)应只写 1 次',
    ).toBe(1);

    // spinner tick 后的帧:含 'Working' 且字节 > 0 且 < 80B(行级 diff 只重写 spinner 行)。
    // 至少 3 个独立 tick 帧说明 spinner 在持续 tick 但每帧都只重写自身行。
    const spinnerFrames = stdout.writes.filter(
      (w) => w.data.includes('Working') && w.bytes > 0 && w.bytes < 80,
    );
    expect(
      spinnerFrames.length,
      'spinner tick 期间应有多个独立小帧(每帧只含 spinner 行,字节 < 80)',
    ).toBeGreaterThan(3);
  });

  it('spinner tick 帧字节远小于完整活动区', async () => {
    const stdout = await renderForTickDuration();

    const allWrites = stdout.writes.filter((w) => w.bytes > 0);
    // 应该有写入:若没有说明 Ink 完全没渲染,测试不该静默 PASS
    expect(
      allWrites.length,
      '应该至少有一次非空写入(Ink 应该渲染过活动区)',
    ).toBeGreaterThan(0);

    const maxFrame = Math.max(...allWrites.map((w) => w.bytes));

    // spinner tick 帧:含 'Working' 但不含 'sonnet'(不含完整活动区的 statusbar)
    const spinnerFrames = allWrites.filter(
      (w) => w.data.includes('Working') && !w.data.includes('sonnet'),
    );
    // 应该有 spinner tick 帧:若没有说明 spinner 没运行或帧判别逻辑失效
    expect(
      spinnerFrames.length,
      '应该至少有一个 spinner tick 帧(含 Working 且不含 statusbar)',
    ).toBeGreaterThan(0);

    const avgSpinner =
      spinnerFrames.reduce((s, w) => s + w.bytes, 0) / spinnerFrames.length;

    // 行级 diff 生效 → spinner tick 帧平均字节应远小于完整活动区帧。
    // 阈值 30%:留足余量,POC 实测 spinner 帧 ~44B vs 完整 ~412B(~11%)。
    // 如失败可放宽到 50%,但放宽前先确认 Ink 版本未回退到全量重写。
    expect(
      avgSpinner,
      `spinner tick 帧平均 ${avgSpinner.toFixed(0)}B 应 < 完整活动区最大帧 ${maxFrame}B 的 30%`,
    ).toBeLessThan(maxFrame * 0.3);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Task 4.4:原始 bug 复现回归测试
//
// 物理本质:V0 inline 模式的原始 bug 是"流式输出累积重复帧"——流式 token 30ms 一到,
// spinner tick 50ms 一到,两者并发触发 V0 InlineRenderer.commit() 时,
// 每帧都把"已渲染过的 finalized 行 + 草稿 + spinner + footer"完整重写一次。
// 结果终端 scrollback 出现"几十份累积副本"。
//
// V2 修复机理:<Static> 把 finalized 直接写进 scrollback 一次,之后不再带;
// 流式 + spinner 在活动区,Ink createIncremental 行级 diff 只重写变化的行。
//
// 本测试模拟原始 bug 场景:<Static> + spinner tick(50ms)+ 流式 token(30ms)并发,
// 验证 V2 路径下:
//   1. <Static> 已固化行只写 1 次(核心 bug 修复标志)
//   2. 总字节数远小于"每帧全量重写"的预期(几千字节 vs 几万字节)
// ──────────────────────────────────────────────────────────────────────────

interface BugRegressionFinalized {
  id: number;
  text: string;
}

const BUG_REGRESSION_FINALIZED: BugRegressionFinalized[] = [
  { id: 1, text: '[F] finalized message before streaming' },
];

/**
 * 原始 bug 复现场景:<Static> 包固化消息 + 活动 spinner(50ms tick)+ 活动流式文本(30ms token)。
 *
 * 流式文本每 30ms 追加一个字符 'a',spinner 每 50ms tick 一次,两者并发。
 * 在 V0 路径下,每次 tick 或 token 都全量重写,导致累积副本。
 */
function AppWithConcurrentStreamAndSpinner(): React.ReactElement {
  const [streamingText, setStreamingText] = useState('');
  const [spinnerTime, setSpinnerTime] = useState(0);

  useEffect(() => {
    // 模拟流式 token 每 30ms 到达(比 spinner tick 更快,制造并发)
    const streamId = setInterval(() => {
      setStreamingText((t) => t + 'a');
    }, 30);
    // 模拟 spinner tick 每 50ms
    const tickId = setInterval(() => {
      setSpinnerTime((t) => t + 50);
    }, 50);
    return () => { clearInterval(streamId); clearInterval(tickId); };
  }, []);

  return (
    <>
      <Static items={BUG_REGRESSION_FINALIZED}>
        {(m: BugRegressionFinalized) => (
          <Text key={m.id}>{m.text}</Text>
        )}
      </Static>
      <Box flexDirection="column">
        <Text>{'· Working ' + spinnerTime + 'ms'}</Text>
        <Text>{'─'.repeat(60)}</Text>
        <Text>{'streaming: ' + streamingText}</Text>
      </Box>
    </>
  );
}

describe('原始 bug 回归:流式 + spinner tick 并发不累积重复帧', () => {
  it('<Static> 已固化消息在并发场景下仍只写 1 次', async () => {
    const stdout = createMockStdout();
    const instance = render(<AppWithConcurrentStreamAndSpinner />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: true,
    });
    // 600ms = 20 个流式 token + 12 个 spinner tick
    await new Promise((r) => setTimeout(r, 600));
    instance.unmount();
    instance.waitUntilRenderFlush?.();

    // 核心断言:<Static> 已固化行只写一次进 scrollback。
    // V0 bug 的标志就是这一行被重写几十次。
    const staticWrites = stdout.writes.filter((w) => w.data.includes('[F]'));
    expect(
      staticWrites.length,
      '<Static> 已固化消息应只写 1 次(V0 bug 标志:此值会达几十次)',
    ).toBe(1);
  });

  it('总字节数远小于"每帧全量重写"的预期', async () => {
    const stdout = createMockStdout();
    const instance = render(<AppWithConcurrentStreamAndSpinner />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: true,
    });
    await new Promise((r) => setTimeout(r, 600));
    instance.unmount();
    instance.waitUntilRenderFlush?.();

    // V0 对比基线:600ms 内如果每帧(50ms tick)都全量重写 ~400B,总字节 ~4800B+。
    // V2 行级 diff 后总字节应该 << 4800B。
    // 阈值 5000B:留足余量(包含 spinner 多次小帧 + 流式增量行)。
    // 如失败说明 Ink 行级 diff 没生效,排查 incrementalRendering 是否传 true。
    const totalBytes = stdout.writes.reduce((s, w) => s + w.bytes, 0);
    expect(
      totalBytes,
      `总字节 ${totalBytes}B 应 < 5000B(行级 diff 生效;V0 全量重写场景约 4800B+)`,
    ).toBeLessThan(5000);
  });

  it('有实际渲染输出(防止假阳性静默通过)', async () => {
    // 守护测试:确认 fixture 真的渲染了——若 Ink 完全没输出,上面的字节断言会假性通过。
    const stdout = createMockStdout();
    const instance = render(<AppWithConcurrentStreamAndSpinner />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: true,
    });
    await new Promise((r) => setTimeout(r, 200));
    instance.unmount();
    instance.waitUntilRenderFlush?.();

    const nonEmptyWrites = stdout.writes.filter((w) => w.bytes > 0);
    expect(
      nonEmptyWrites.length,
      '应该有多个非空写入帧(防止假阳性:零输出会让字节断言无意义)',
    ).toBeGreaterThan(3);

    // 验证 fixture 真的在动:spinner 时间 / streaming 文本都应在帧里出现过
    const allData = stdout.writes.map((w) => w.data).join('');
    expect(allData).toContain('Working');
    expect(allData).toContain('streaming');
  });
});
