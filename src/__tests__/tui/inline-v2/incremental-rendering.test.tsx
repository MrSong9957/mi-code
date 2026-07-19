// src/__tests__/tui/inline-v2/incremental-rendering.test.tsx
//
// InlineV2 POC 回归基线:验证 stock Ink 7.1.0 `createIncremental` +
// `<Static>` 在 spinner 高频 tick(50ms)下的 3 个核心假设:
//
//   1. <Static> 已固化消息只写一次进 stdout(进 scrollback,后续帧不再带)
//   2. spinner tick 时未变行(footer border / statusbar)不被重写
//   3. spinner tick 帧字节远小于完整活动区帧(行级 diff 生效)
//
// 对照基线:scripts/ink-poc/poc-inline-diff.tsx 手动跑过的结果
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
