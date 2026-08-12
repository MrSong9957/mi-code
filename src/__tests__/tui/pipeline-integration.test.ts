// src/__tests__/tui/pipeline-integration.test.ts
// 端到端:BlockPipeline + PipelineToStoreAdapter + messages-store
//
// 物理本质:整条数据流的「联调验收」。
// 真实 BlockPipeline(不经 mock)emit 各种 Block,PipelineToStoreAdapter 实现 PipelineRenderer
// 接口把数据推进 store。验证 store 的语义时间线(model.items)符合预期——这是 Phase 4 的交付证据。
//
// 语义模型说明:store 不再存 FormattedLine 字符串行,而是存生命周期安全的 TimelineItem:
// - 已固化块(TranscriptBlock):user / assistant / tool / ask / system / turn-duration
// - 活动项(ActivityItem):streaming-assistant / pending-tool / pending-thinking
// 本文件断言这些语义字段(kind / toolName / entries / text / presentations)。

import { describe, it, expect } from 'vitest';
import { BlockPipeline } from '../../ui/block-pipeline.js';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';
import { selectCommittedTranscript } from '../../tui/state/transcript-reducer.js';
import type { AgentBlock, PendingAgent, PendingTool, ToolBlock } from '../../tui/transcript-types.js';

describe('tool lifecycle visibility', () => {
  it('\u8c03\u7528\u4e8b\u4ef6\u5355\u72ec\u5230\u8fbe\u65f6\u7acb\u5373\u663e\u793a pending agent', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: { task: 'inspect' }, toolUseId: 't1' });

    const items = store.getState().model.items;
    // Task 4: spawn_agent 现在路由到 agent 生命周期 → PendingAgent(非 PendingTool)。
    // input 无 description/prompt → label 回退到 subagent.agentFallback(zh-CN: '代理')。
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'pending-agent',
        id: 't1',
        label: '代理',
      }),
    ]));
    // 契约:无 pending-tool 残留(spawn_agent 不再走 tool 路径)
    expect(items.some(i => i.kind === 'pending-tool')).toBe(false);
  });

  it('\u4e24\u4e2a pending tool \u7ed3\u679c\u5012\u5e8f\u5230\u8fbe\u4ecd\u4fdd\u6301\u8c03\u7528\u987a\u5e8f', () => {
    const { pipeline, store } = setup();
    // read_file 是可分组工具:两次同名调用合并进同一个 PendingTool(两项 entries)。
    // 语义不变量:entries 顺序 = 调用顺序;结果按任意顺序到达时,presentation 挂到对应 entry。
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'one.ts' }, toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'two.ts' }, toolUseId: 't2' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'two-result', toolUseId: 't2' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'one-result', toolUseId: 't1' });

    const items = store.getState().model.items;
    const pt = items.find(i => i.kind === 'pending-tool') as PendingTool | undefined;
    expect(pt).toBeDefined();
    expect(pt!.entries.map(e => e.toolUseId)).toEqual(['t1', 't2']);
    expect(pt!.entries).toHaveLength(2);
    // 两 entry 均已配对 presentation
    expect(pt!.entries.every(e => e.presentation !== undefined)).toBe(true);
    // 调用顺序契约:t1 entry 的明细含 one-result,t2 entry 的明细含 two-result
    // (read_file 的 summary=input.path,details 含原始 output)
    expect(pt!.entries[0]!.presentation!.details.some(d => d.kind === 'text' && d.text.includes('one-result'))).toBe(true);
    expect(pt!.entries[1]!.presentation!.details.some(d => d.kind === 'text' && d.text.includes('two-result'))).toBe(true);
  });

  it('clearTurnState \u4f1a\u5b8c\u6210\u672a\u8fd4\u56de\u7684 pending tool', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'orphan.ts' }, toolUseId: 't1' });
    pipeline.clearTurnState();

    const items = store.getState().model.items;
    const pt = items.find(i => i.kind === 'pending-tool') as PendingTool | undefined;
    expect(pt).toBeDefined();
    // 契约:clearTurnState 通过 closeOpenToolGroup 关闭该组 → closed=true
    expect(pt!.closed).toBe(true);
  });

  it('hook \u9644\u7740\u5230\u5bf9\u5e94\u7684\u7ed3\u679c\uff0c\u4e0d\u4e71\u5e8f\u53e6\u4e00\u4e2a pending tool', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'one.ts' }, toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'two.ts' }, toolUseId: 't2' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'one-result', toolUseId: 't1' });
    pipeline.emit({ kind: 'hook', text: '[Hook] one complete' });

    // read_file 合并成单组(两 entry);hook 是 system notification,作为独立 system 块。
    const items = store.getState().model.items;
    const pt = items.find(i => i.kind === 'pending-tool') as PendingTool | undefined;
    expect(pt).toBeDefined();
    expect(pt!.entries.map(e => e.toolUseId)).toEqual(['t1', 't2']);
    // 契约:hook 文本不污染工具项(作为独立 system notification 块存在)
    expect(items.some(i => i.kind === 'system' && i.subkind === 'notification' && i.text.includes('[Hook] one complete'))).toBe(true);
    // 工具项本身不含 hook 文本(presentation summary/details 里没有)
    const toolHasHook = pt!.entries.some(e =>
      e.presentation?.summary.includes('[Hook] one complete')
      || e.presentation?.details.some(d => 'text' in d && d.text.includes('[Hook] one complete')),
    );
    expect(toolHasHook).toBe(false);
  });

  it('\u663e\u5f0f\u672a\u77e5 toolUseId \u4e0d\u56de\u9000 FIFO \u5b8c\u6210\u5176\u4ed6 pending tool', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'one.ts' }, toolUseId: 't1' });
    // tool_result 带未知 toolUseId 'missing':pipeline 兜底建一个 orphan 调用并立即解析,
    // 不应误配到 t1。t1 保持未解析的 pending。
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'wrong-result', toolUseId: 'missing' });

    const items = store.getState().model.items;
    // t1 仍是活动 pending(未配对 presentation)
    const t1Entry = items.flatMap(i => i.kind === 'pending-tool' ? i.entries : [])
      .find(e => e.toolUseId === 't1');
    expect(t1Entry).toBeDefined();
    expect(t1Entry!.presentation).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────────
  // AUTO-0025-stable Task 3:子代理内部工具活动不进入主消息管道。
  //
  // 物理本质:spawn_agent 的 pending 只承载外层 call+result 生命周期,
  // 子代理内部 read_file/run_bash 不再作为嵌套进度行写入。语义模型天然满足:
  // pending-tool 的 entries 只反映外层 tool_call/tool_result 配对,无子明细字段。
  // ────────────────────────────────────────────────────────────────────

  it('外层 spawn_agent pending 只有 call,子代理活动不污染 agent block', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: { role: 'explore' }, toolUseId: 'spawn-1' });

    const items = store.getState().model.items;
    // Task 4: spawn_agent → PendingAgent(非 PendingTool)。
    const spawn1 = items.find(i =>
      i.kind === 'pending-agent' && i.id === 'spawn-1',
    ) as PendingAgent | undefined;
    expect(spawn1).toBeDefined();
    expect(spawn1!.label).toBe('代理'); // 无 description/prompt → fallback
    // 契约:无 pending-tool 残留
    expect(items.some(i => i.kind === 'pending-tool')).toBe(false);
  });

  it('外层 spawn_agent 结果到达后,pending 原地固化成 AgentBlock', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: {}, toolUseId: 'spawn-1' });
    pipeline.emit({ kind: 'tool_result', name: 'spawn_agent', output: 'subagent summary', toolUseId: 'spawn-1' });

    const items = store.getState().model.items;
    // Task 4: spawn_agent 结果 → AgentBlock(非 ToolBlock)。
    // output 'subagent summary' 无 [Subagent status=...] envelope → status 'unknown'。
    const agent = items.find(i => i.kind === 'agent') as AgentBlock | undefined;
    expect(agent).toBeDefined();
    expect(agent!.label).toBe('代理');
    expect(agent!.status).toBe('unknown');
    // 契约:无 ToolBlock / pending-agent 残留
    expect(items.some(i => i.kind === 'tool')).toBe(false);
    expect(items.some(i => i.kind === 'pending-agent')).toBe(false);
  });

  it('并行 spawn 各自独立 pending,resolve 一个不影响其余', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: { role: 'explore' }, toolUseId: 'spawn-1' });
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: { role: 'plan' }, toolUseId: 'spawn-2' });
    // 只 resolve spawn-1
    pipeline.emit({ kind: 'tool_result', name: 'spawn_agent', output: 'one', toolUseId: 'spawn-1' });

    const items = store.getState().model.items;
    // spawn-1:已解析 → AgentBlock(unknown,无 envelope)
    const spawn1Agent = items.find(i =>
      i.kind === 'agent' && i.id === 'spawn-1',
    ) as AgentBlock | undefined;
    expect(spawn1Agent).toBeDefined();
    // spawn-2:仍是 pending-agent
    const spawn2Pending = items.find(i =>
      i.kind === 'pending-agent' && i.id === 'spawn-2',
    ) as PendingAgent | undefined;
    expect(spawn2Pending).toBeDefined();
    expect(spawn2Pending!.label).toBe('代理');
  });

  it('孤儿 result 后 hook 不污染已固化工具块', () => {
    const { pipeline, store } = setup();
    // 用不可分组工具 run_bash:t1 完成后形成独立 ToolBlock;
    // 后续孤儿 result(toolUseId 不匹配)走 pipeline 兜底,因 run_bash 不可分组,
    // 不会合并进 t1 的块,而是形成另一个独立 ToolBlock。
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'echo one' }, toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'one-result', toolUseId: 't1' });
    // 孤儿 result(pipeline 兜底建 orphan 调用 + 立即解析)
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'orphan-result', toolUseId: 'missing' });
    pipeline.emit({ kind: 'hook', text: '[Hook] orphan complete' });

    const items = store.getState().model.items;
    // 契约:t1 的 ToolBlock presentation 只含 one-result,不含 orphan-result 或 hook 文本。
    const t1Tool = items.find(i =>
      i.kind === 'tool' && i.presentations.some(p => p.toolUseId === 't1'),
    ) as ToolBlock | undefined;
    expect(t1Tool).toBeDefined();
    const t1Pres = t1Tool!.presentations.find(p => p.toolUseId === 't1')!;
    expect(t1Pres).toBeDefined();
    const t1Contaminated = t1Pres.summary.includes('orphan-result')
      || t1Pres.summary.includes('[Hook] orphan complete')
      || t1Pres.details.some(d => 'text' in d && (d.text.includes('orphan-result') || d.text.includes('[Hook] orphan complete')));
    expect(t1Contaminated).toBe(false);
    // 契约:hook 作为独立 system notification 块存在(不依附任何工具)
    expect(items.some(i =>
      i.kind === 'system' && i.subkind === 'notification' && i.text.includes('[Hook] orphan complete'),
    )).toBe(true);
  });

  it('commits a cancelled agent before the final assistant response', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: {}, toolUseId: 'spawn-1' });
    pipeline.cancelPendingTools(new Set(['spawn-1']));
    pipeline.emit({ kind: 'assistant_text', text: 'Current status: Partially completed', isFinal: true });

    // Task 4: cancelled spawn_agent → AgentBlock(cancelled), not ToolBlock.
    expect(selectCommittedTranscript(store.getState().model.items).map(item => item.kind))
      .toEqual(['agent', 'assistant']);
    expect(store.getState().model.items[0]).toMatchObject({
      kind: 'agent', id: 'spawn-1', status: 'cancelled',
    });
  });

  it('leaves unlisted pending agents unresolved', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: {}, toolUseId: 'spawn-1' });
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: {}, toolUseId: 'spawn-2' });
    pipeline.cancelPendingTools(new Set(['spawn-1']));

    // Task 4: spawn-2 remains a pending-agent (not pending-tool).
    expect(store.getState().model.items.some(item =>
      item.kind === 'pending-agent' && item.id === 'spawn-2',
    )).toBe(true);
  });

  it('does not overwrite resolved agent presentations', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: {}, toolUseId: 'success-1' });
    pipeline.emit({ kind: 'tool_result', name: 'spawn_agent', output: '[Subagent status=completed]\ndone', toolUseId: 'success-1' });
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: {}, toolUseId: 'error-1' });
    pipeline.emit({ kind: 'tool_result', name: 'spawn_agent', output: 'Error: failed', toolUseId: 'error-1' });

    pipeline.cancelPendingTools(new Set(['success-1', 'error-1']));
    // Task 4: both resolved before cancel → AgentBlocks; cancel is no-op (already resolved).
    // success-1 has envelope → completed; error-1 has no envelope → unknown.
    const agents = store.getState().model.items
      .filter(item => item.kind === 'agent') as AgentBlock[];
    expect(agents.find(a => a.id === 'success-1')?.status).toBe('completed');
    expect(agents.find(a => a.id === 'error-1')?.status).toBe('unknown');
  });
});

function setup(): { pipeline: BlockPipeline; store: ReturnType<typeof createMessagesStore>; translator: ReturnType<typeof createTranslator> } {
  const store = createMessagesStore();
  const adapter = new PipelineToStoreAdapter(store);
  const translator = createTranslator(createLanguageStore('zh-CN'));
  const pipeline = new BlockPipeline(adapter, translator);
  return { pipeline, store, translator };
}

describe('BlockPipeline → store 端到端', () => {
  it('user_input → store 末条 user 块含原文', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'user_input', text: '你好' });
    const items = store.getState().model.items;
    expect(items.length).toBeGreaterThanOrEqual(1);
    const last = items[items.length - 1]!;
    expect(last.kind).toBe('user');
    if (last.kind === 'user') {
      expect(last.text).toBe('你好');
    }
  });

  // 语义说明:thinking 完成后 summary 被「挂起」(deferredThinking),等下一个 boundary
  // (assistant / 不同工具 / closeOpenToolGroup)把它 flush 进 items。
  // 这与旧 TuiMessage「立即出现 summary」不同;语义模型刻意推迟以把 summary
  // 透明聚合到紧随其后的只读工具组。本测试守护:thinking_end 后无 ● Thinking… 固化项,
  // summary 进入 deferred(随后被 boundary flush 出现)。
  it('thinking_start + thinking_end → 无 ● Thinking… 固化,summary 进入 deferred(AUTO-0025-transient)', () => {
    const { pipeline, store, translator } = setup();
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '思考内容' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 2 });

    const state = store.getState().model;
    // 契约 1:items 中无 pending-thinking 活动(thinking_end 已擦除临时活动)
    expect(state.items.some(i => i.kind === 'pending-thinking')).toBe(false);
    // 契约 2:summary 被 defer(等待 flush)
    expect(state.deferredThinking.some(s => s.text.includes(translator.t('thinking.summary', { seconds: 5 })))).toBe(true);
  });

  // 防回归守护:旧 bug 中 thinking_summary 经 mapRole→'system'→appendLine,
  // 合并进已有 system message,summary 沉到块内部肉眼不可见。
  // 语义模型中每个 block 都是独立 items 元素,天然杜绝续接。本测试验证:
  // flush 后 summary 作为独立 system(thinking-summary)块存在,subkind 标记区分。
  it('thinking_end → summary flush 后是独立 system(thinking-summary) 块(防 appendLine 回退)', () => {
    const { pipeline, store, translator } = setup();
    // 真实时序:thinking_start → thinking_end(summary defer)→ 后续 boundary 触发 flush。
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '内部推理' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    // 用 user_input 触发 boundary(appendBoundaryBlock 内部 closeOpenToolGroup + flushDeferredThinking)。
    // 等价于真实场景中下一轮 user 提问或 assistant 文本到达。
    pipeline.emit({ kind: 'user_input', text: 'next question' });

    const items = store.getState().model.items;
    // 契约:summary 作为独立 system(thinking-summary)块存在
    const summaryItem = items.find(i =>
      i.kind === 'system' && i.subkind === 'thinking-summary' && i.text.includes(translator.t('thinking.summary', { seconds: 1 })),
    );
    expect(summaryItem).toBeDefined();
    // 契约:无任何块混入空字符串 system notification(证明没被续接进空行块)
    const emptyNotification = items.find(i =>
      i.kind === 'system' && i.subkind === 'notification' && i.text === '',
    );
    expect(emptyNotification).toBeUndefined();
  });

  it('thinking_delta 只缓存供展开，不把原始推理写入可见 items', () => {
    const { pipeline, store } = setup();
    const privateReasoning = '内部推理不应直接铺满终端';

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: privateReasoning });

    // 契约:items 中 pending-thinking 的 text 是占位 'Thinking…',原始推理不进 items。
    const visibleText = store.getState().model.items
      .map(item => {
        switch (item.kind) {
          case 'pending-thinking': return item.text;
          case 'streaming-assistant': return item.text;
          default: return '';
        }
      })
      .join('\n');
    expect(visibleText).not.toContain(privateReasoning);

    pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });
    // 契约:原始推理仍可经 pipeline 的可折叠存储展开(ctrl+o 路径)。
    const expanded = pipeline.getLastExpandableFullLines();
    expect(expanded?.lines.map(line => line.content).join('\n')).toContain(privateReasoning);
  });

  it('assistant_text 流式 → store 末条 streaming-assistant 累加，isFinal 固化', () => {
    const { pipeline, store } = setup();
    // 先建一个前置块(让 assistant 不被当作首块强制加空行逻辑干扰)
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    pipeline.emit({ kind: 'assistant_text', text: '你', isFinal: false });
    pipeline.emit({ kind: 'assistant_text', text: '你好', isFinal: false });
    pipeline.emit({ kind: 'assistant_text', text: '你好世界', isFinal: false });

    // 流式中:末条 streaming-assistant 活动项,text 累加(含 ● 前缀)
    const streaming = store.getState().model.items.filter(i => i.kind === 'streaming-assistant');
    expect(streaming.length).toBe(1);
    expect((streaming[0] as { text: string }).text).toContain('你好世界');

    // 固化
    pipeline.emit({ kind: 'assistant_text', text: '你好世界', isFinal: true });
    const items = store.getState().model.items;
    const finalized = items.filter(i => i.kind === 'assistant');
    expect(finalized.length).toBeGreaterThanOrEqual(1);
    const last = finalized[finalized.length - 1]!;
    expect(last.kind).toBe('assistant');
    if (last.kind === 'assistant') {
      expect(last.text).toContain('你好世界');
    }
    // 固化后无 streaming-assistant 活动项
    expect(items.some(i => i.kind === 'streaming-assistant')).toBe(false);
  });

  it('tool_call + tool_result 配对 → store 含 ToolBlock(工具名 + 结果明细)', () => {
    const { pipeline, store } = setup();
    // run_bash 是不可分组工具:tool_call 建 closed pending,tool_result 原地固化成 ToolBlock。
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' }, toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'file1\nfile2', toolUseId: 't1' });
    const items = store.getState().model.items;
    const tool = items.find(i => i.kind === 'tool') as ToolBlock | undefined;
    expect(tool).toBeDefined();
    expect(tool!.toolName).toBe('run_bash');
    // 契约:presentation 含工具名(run_bash)和结果明细(file1/file2)
    expect(tool!.presentations.some(p => p.toolName === 'run_bash')).toBe(true);
    expect(tool!.presentations.some(p =>
      p.details.some(d => 'text' in d && (d.text.includes('file1') || d.text.includes('file2'))),
    )).toBe(true);
  });

  it('hook 紧跟 tool_result → store 含独立 hook system 块', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'x.ts' }, toolUseId: 'h1' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'X', toolUseId: 'h1' });
    pipeline.emit({ kind: 'hook', text: '[Hook] read_file done' });
    const items = store.getState().model.items;
    // hook 作为独立 system notification 块存在(groupBoundary: break)
    expect(items.some(i =>
      i.kind === 'system' && i.subkind === 'notification' && i.text.includes('[Hook] read_file done'),
    )).toBe(true);
  });

  it('clear → store 清空', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'user_input', text: 'hi' });
    expect(store.getState().model.items.length).toBeGreaterThan(0);
    pipeline.clear();
    expect(store.getState().model.items).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// Task 7 — 消息呈现 v1 整案验收(compact transcript)
//
// 一条覆盖 memory_list + read_file + spawn_agent(cancelled) 的紧凑时间线,
// 验证 Tasks 1–6 的呈现规则在真实 pipeline 端到端叠加后仍成立:
//  - <1s thinking 的 summary 在提交边界被丢弃(Task 2);
//  - 常规 post-tool hook 在源头被抑制 -> 不产生 system/notification(Task 3);
//  - spawn_agent 取消后固化为 AgentBlock(cancelled, label=description)(Task 4)。
//
// 注意:本用例只驱动 pipeline,不调用 finalize/index.ts,故 turn-status 的
// emit 决策不在本用例验证范围内(pipeline 本身不会自发 emit turn-status)。
// 真正的 turn-status 决策缝由 turn-final-feedback.test.ts 的 production-seam 用例证明。
// ════════════════════════════════════════════════════════════════════
describe('message presentation v1 — full case', () => {
  it('compact transcript for memory+read+spawn_agent(cancelled)+partial', () => {
    const { pipeline, store, translator } = setup();
    pipeline.emit({ kind: 'user_input', text: '启动子代理调查项目' });
    pipeline.emit({ kind: 'assistant_text', text: '我来启动…', isFinal: true });
    pipeline.emit({ kind: 'thinking_start' });
    // durationSec=0 -> <1s,deferred summary 在提交边界被丢弃(不进 committed transcript)。
    pipeline.emit({ kind: 'thinking_end', durationSec: 0, filesRead: 0 });
    pipeline.emit({ kind: 'tool_call', name: 'memory_list', input: {}, toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_result', name: 'memory_list', output: 'No memories', toolUseId: 't1' });
    // 常规 post-tool hook 在源头被抑制(postToolLogger 返回 '')-> 这里不发 hook 事件。
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: '.' }, toolUseId: 't2' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: '.', toolUseId: 't2' });
    pipeline.emit({ kind: 'assistant_text', text: '现在启动…', isFinal: true });
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: { description: '调查项目' }, toolUseId: 'a1' });
    pipeline.cancelPendingTools(new Set(['a1']));
    const items = selectCommittedTranscript(store.getState().model.items);

    // 存在:用户输入、两段 assistant、两个语义化的工具块、一个取消的 agent 块。
    expect(items.some(i => i.kind === 'user')).toBe(true);
    expect(items.filter(i => i.kind === 'assistant')).toHaveLength(2);
    // memory_list -> 本地化语义摘要「检查了记忆」。
    expect(items.some(i =>
      i.kind === 'tool' && i.presentations.some(p => p.summary === translator.t('toolPresentation.semantic.memory')),
    )).toBe(true);
    // read_file(path='.') -> 本地化语义摘要「读取了项目结构」。
    expect(items.some(i =>
      i.kind === 'tool' && i.presentations.some(p => p.summary === translator.t('toolPresentation.semantic.readDirectory')),
    )).toBe(true);
    // spawn_agent 取消 -> AgentBlock(status=cancelled, label=description)。
    expect(items.some(i =>
      i.kind === 'agent' && i.status === 'cancelled' && i.label === '调查项目',
    )).toBe(true);

    // 缺席:<1s thinking 不进 committed transcript(提交边界丢弃)。
    expect(items.some(i => i.kind === 'system' && i.subkind === 'thinking-summary')).toBe(false);
    // 缺席:无 hook 事件 -> 无 system/notification 噪声。
    expect(items.some(i => i.kind === 'system' && i.subkind === 'notification')).toBe(false);
  });
});
