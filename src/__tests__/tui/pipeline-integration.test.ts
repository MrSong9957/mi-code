// src/__tests__/tui/pipeline-integration.test.ts
// 端到端：BlockPipeline + PipelineToStoreAdapter + messages-store
//
// 物理本质：整条数据流的「联调验收」。
// 真实 BlockPipeline（不经 mock）emit 各种 Block，PipelineToStoreAdapter 实现 PipelineRenderer
// 接口把数据推进 store。验证 store 最终状态符合预期——这是 Phase 4 的交付证据。

import { describe, it, expect } from 'vitest';
import { BlockPipeline } from '../../ui/block-pipeline.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';

describe('tool lifecycle visibility', () => {
  it('\u8c03\u7528\u4e8b\u4ef6\u5355\u72ec\u5230\u8fbe\u65f6\u7acb\u5373\u663e\u793a pending tool', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: { task: 'inspect' }, toolUseId: 't1' });

    expect(store.getState().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'tool-progress',
        toolUseId: 't1',
        finalized: false,
        lines: expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('spawn_agent') })]),
      }),
    ]));
  });

  it('\u4e24\u4e2a pending tool \u7ed3\u679c\u5012\u5e8f\u5230\u8fbe\u4ecd\u4fdd\u6301\u8c03\u7528\u987a\u5e8f', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'one.ts' }, toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'two.ts' }, toolUseId: 't2' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'two-result', toolUseId: 't2' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'one-result', toolUseId: 't1' });

    const tools = store.getState().messages.filter(message => message.kind === 'tool-progress');
    expect(tools.map(message => message.toolUseId)).toEqual(['t1', 't2']);
    expect(tools).toHaveLength(2);
    expect(tools.every(message => message.finalized)).toBe(true);
    expect(tools[0]!.lines.some(line => line.content.includes('one-result'))).toBe(true);
    expect(tools[1]!.lines.some(line => line.content.includes('two-result'))).toBe(true);
  });

  it('clearTurnState \u4f1a\u5b8c\u6210\u672a\u8fd4\u56de\u7684 pending tool', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'orphan.ts' }, toolUseId: 't1' });
    pipeline.clearTurnState();

    expect(store.getState().messages.find(message => message.toolUseId === 't1')).toMatchObject({ finalized: true });
  });

  it('hook \u9644\u7740\u5230\u5bf9\u5e94\u7684\u7ed3\u679c\uff0c\u4e0d\u4e71\u5e8f\u53e6\u4e00\u4e2a pending tool', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'one.ts' }, toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'two.ts' }, toolUseId: 't2' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'one-result', toolUseId: 't1' });
    pipeline.emit({ kind: 'hook', text: '[Hook] one complete' });

    const tools = store.getState().messages.filter(message => message.kind === 'tool-progress');
    expect(tools.map(message => message.toolUseId)).toEqual(['t1', 't2']);
    expect(tools[0]!.lines.some(line => line.content.includes('[Hook] one complete'))).toBe(true);
    expect(tools[1]!.lines.some(line => line.content.includes('[Hook] one complete'))).toBe(false);
  });

  it('\u663e\u5f0f\u672a\u77e5 toolUseId \u4e0d\u56de\u9000 FIFO \u5b8c\u6210\u5176\u4ed6 pending tool', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'one.ts' }, toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'wrong-result', toolUseId: 'missing' });

    expect(store.getState().messages.find(message => message.toolUseId === 't1')).toMatchObject({ finalized: false });
  });

  // ────────────────────────────────────────────────────────────────────
  // AUTO-0025 Task 3：subagent_tool_progress 块路由到匹配的父 pending 消息。
  //
  // 物理本质:子代理内部工具(read_file / run_bash)的实时活动,作为嵌套进度行
  // 挂到外层 spawn_agent 的 pending 消息上,不创建第二条顶级工具消息。
  // 并行 spawn 时,每个子代理进度按 parentToolUseId 精确挂载,不串台。
  // ────────────────────────────────────────────────────────────────────

  it('subagent_tool_progress 嵌入对应父 pending 消息,不新建顶级消息', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: { role: 'explore' }, toolUseId: 'spawn-1' });
    pipeline.emit({
      kind: 'subagent_tool_progress',
      parentToolUseId: 'spawn-1',
      childToolUseId: 'read-1',
      name: 'read_file',
      phase: 'running',
    });

    const msgs = store.getState().messages;
    // 没有创建第二条顶级 tool-progress 消息
    const spawnMessages = msgs.filter(m => m.kind === 'tool-progress');
    expect(spawnMessages).toHaveLength(1);
    expect(spawnMessages[0]!.toolUseId).toBe('spawn-1');
    // 父消息内嵌入了 read_file 进度行
    expect(spawnMessages[0]!.lines.some(l => l.content.includes('read_file'))).toBe(true);
  });

  it('并行 spawn 时 subagent_tool_progress 按 parentToolUseId 精确挂载', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: { role: 'explore' }, toolUseId: 'spawn-1' });
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: { role: 'plan' }, toolUseId: 'spawn-2' });

    // 交错进度:spawn-2 先报 read_file,spawn-1 后报 run_bash
    pipeline.emit({
      kind: 'subagent_tool_progress',
      parentToolUseId: 'spawn-2',
      childToolUseId: 'read-2a',
      name: 'read_file',
      phase: 'running',
    });
    pipeline.emit({
      kind: 'subagent_tool_progress',
      parentToolUseId: 'spawn-1',
      childToolUseId: 'bash-1a',
      name: 'run_bash',
      phase: 'running',
    });

    const spawn1 = store.getState().messages.find(m => m.toolUseId === 'spawn-1')!;
    const spawn2 = store.getState().messages.find(m => m.toolUseId === 'spawn-2')!;
    // 精确隔离:spawn-1 只含 run_bash,spawn-2 只含 read_file
    expect(spawn1.lines.some(l => l.content.includes('run_bash'))).toBe(true);
    expect(spawn1.lines.some(l => l.content.includes('read_file'))).toBe(false);
    expect(spawn2.lines.some(l => l.content.includes('read_file'))).toBe(true);
    expect(spawn2.lines.some(l => l.content.includes('run_bash'))).toBe(false);
  });

  it('subagent_tool_progress 完成态把 running 行替换为结果摘要', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: {}, toolUseId: 'spawn-1' });
    pipeline.emit({
      kind: 'subagent_tool_progress',
      parentToolUseId: 'spawn-1',
      childToolUseId: 'read-1',
      name: 'read_file',
      phase: 'running',
    });
    pipeline.emit({
      kind: 'subagent_tool_progress',
      parentToolUseId: 'spawn-1',
      childToolUseId: 'read-1',
      name: 'read_file',
      phase: 'done',
      output: '3 skills found',
    });

    const spawn1 = store.getState().messages.find(m => m.toolUseId === 'spawn-1')!;
    // running 行被 done 摘要替换
    expect(spawn1.lines.some(l => l.content.includes('running') && l.content.includes('read_file'))).toBe(false);
    expect(spawn1.lines.some(l => l.content.includes('3 skills found'))).toBe(true);
  });

  it('外层 spawn_agent 结果到达后,瞬态进度被最终 call+result 替换', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: {}, toolUseId: 'spawn-1' });
    pipeline.emit({
      kind: 'subagent_tool_progress',
      parentToolUseId: 'spawn-1',
      childToolUseId: 'read-1',
      name: 'read_file',
      phase: 'running',
    });
    // 外层 spawn 完成
    pipeline.emit({ kind: 'tool_result', name: 'spawn_agent', output: 'subagent summary', toolUseId: 'spawn-1' });

    const spawn1 = store.getState().messages.find(m => m.toolUseId === 'spawn-1')!;
    expect(spawn1.finalized).toBe(true);
    // 瞬态 read_file 进度消失,被最终 subagent summary 替换
    expect(spawn1.lines.some(l => l.content.includes('read_file'))).toBe(false);
    expect(spawn1.lines.some(l => l.content.includes('subagent summary'))).toBe(true);
  });

  it('未知 parentToolUseId 的 subagent_tool_progress 不影响任何消息', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: {}, toolUseId: 'spawn-1' });
    pipeline.emit({
      kind: 'subagent_tool_progress',
      parentToolUseId: 'missing',
      childToolUseId: 'read-x',
      name: 'read_file',
      phase: 'running',
    });

    const spawn1 = store.getState().messages.find(m => m.toolUseId === 'spawn-1')!;
    // spawn-1 的 lines 仍是原 call 行,没有 read_file
    expect(spawn1.lines.some(l => l.content.includes('read_file'))).toBe(false);
  });

  it('孤儿 result 后 hook 不污染上一条完成工具消息', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'one.ts' }, toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'one-result', toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'orphan-result', toolUseId: 'missing' });
    pipeline.emit({ kind: 'hook', text: '[Hook] orphan complete' });

    const completed = store.getState().messages.find(message => message.toolUseId === 't1');
    expect(completed!.lines.some(line => line.content.includes('[Hook] orphan complete'))).toBe(false);
    expect(store.getState().messages.some(message =>
      message.toolUseId === undefined
      && message.lines.some(line => line.content.includes('[Hook] orphan complete')),
    )).toBe(true);
  });
});

function setup(): { pipeline: BlockPipeline; store: ReturnType<typeof createMessagesStore> } {
  const store = createMessagesStore();
  const adapter = new PipelineToStoreAdapter(store);
  const pipeline = new BlockPipeline(adapter);
  return { pipeline, store };
}

describe('BlockPipeline → store 端到端', () => {
  it('user_input → store 末条 user 消息含 ❯ 前缀', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'user_input', text: '你好' });
    const msgs = store.getState().messages;
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.lines.some(l => l.content.includes('❯') && l.content.includes('你好'))).toBe(true);
  });

  it('thinking_start + thinking_end → store 含 ● Thinking… 标题和 thought for 摘要', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '思考内容' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 2 });
    const allLines = store.getState().messages.flatMap(m => m.lines.map(l => l.content));
    expect(allLines.some(t => t === '● Thinking…')).toBe(true);
    expect(allLines.some(t => t.includes('thought for 5s'))).toBe(true);
  });

  it('thinking_delta 只缓存供展开，不把原始推理写入可见消息', () => {
    const { pipeline, store } = setup();
    const privateReasoning = '内部推理不应直接铺满终端';

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: privateReasoning });

    const visibleText = store.getState().messages.map(message => [
      ...message.lines.map(line => line.content),
      message.streamingText ?? '',
    ].join('\n')).join('\n');
    expect(visibleText).not.toContain(privateReasoning);

    pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });
    const expanded = pipeline.getLastExpandableFullLines();
    expect(expanded?.lines.map(line => line.content).join('\n')).toContain(privateReasoning);
  });

  it('assistant_text 流式 → store 末条 assistant streamingText 累加，isFinal 固化', () => {
    const { pipeline, store } = setup();
    // 先建一个前置块（让 assistant 不被当作首块强制加空行逻辑干扰）
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    pipeline.emit({ kind: 'assistant_text', text: '你', isFinal: false });
    pipeline.emit({ kind: 'assistant_text', text: '你好', isFinal: false });
    pipeline.emit({ kind: 'assistant_text', text: '你好世界', isFinal: false });

    // 流式中：末条 assistant finalized=false，streamingText 累加
    const streaming = store.getState().messages.filter(m => m.role === 'assistant' && !m.finalized);
    expect(streaming.length).toBe(1);
    expect(streaming[0]!.streamingText).toContain('你好世界');

    // 固化
    pipeline.emit({ kind: 'assistant_text', text: '你好世界', isFinal: true });
    const finalized = store.getState().messages.filter(m => m.role === 'assistant' && m.finalized);
    expect(finalized.length).toBeGreaterThanOrEqual(1);
    const last = finalized[finalized.length - 1]!;
    expect(last.lines.some(l => l.content.includes('你好世界'))).toBe(true);
    expect(last.streamingText).toBeUndefined();
  });

  it('tool_call + tool_result 配对 → store 含 ● 工具名 和 ⎿ 结果', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' }, toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'file1\nfile2', toolUseId: 't1' });
    const allLines = store.getState().messages.flatMap(m => m.lines.map(l => l.content));
    expect(allLines.some(t => t.includes('●') && t.includes('Bash(ls)'))).toBe(true);
    expect(allLines.some(t => t.includes('⎿') && (t.includes('file1') || t.includes('file2')))).toBe(true);
  });

  it('hook 紧跟 tool_result → store 含 hook 文本', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'x.ts' }, toolUseId: 'h1' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'X', toolUseId: 'h1' });
    pipeline.emit({ kind: 'hook', text: '[Hook] read_file done' });
    const allLines = store.getState().messages.flatMap(m => m.lines.map(l => l.content));
    expect(allLines.some(t => t.includes('[Hook] read_file done'))).toBe(true);
  });

  it('clear → store 清空', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'user_input', text: 'hi' });
    expect(store.getState().messages.length).toBeGreaterThan(0);
    pipeline.clear();
    expect(store.getState().messages).toEqual([]);
  });
});
