// src/tui/state/pipeline-adapter.ts
// PipelineToStoreAdapter:实现 PipelineRenderer,把 BlockPipeline 调用翻译成语义 store 操作
//
// 物理本质:旧 pipeline 接口的「语义 store 版替身」。
// BlockPipeline 配对 call/result 后构建 ToolPresentation,通过本 adapter
// 调用 store 的语义 actions(startTool/resolveTool/finishAsk/startAssistant…)。
// adapter 是薄桥接:不解析工具输出、不订阅 store 变化、不生成字形。

import type { PipelineRenderer } from '../../ui/block-pipeline.js';
import type { AskBlock, ToolPresentation } from '../transcript-types.js';
import type { BoundaryBlock, ThinkingSummaryBlock } from './transcript-reducer.js';
import type { MessagesStore } from './messages-store.js';

export class PipelineToStoreAdapter implements PipelineRenderer {
  private store: MessagesStore;

  constructor(store: MessagesStore) {
    this.store = store;
  }

  // ── 工具调用(语义) ──

  startToolCall(call: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  }): void {
    this.store.getState().startTool({
      toolUseId: call.toolUseId,
      toolName: call.name,
      input: call.input,
    });
  }

  finishToolCall(toolUseId: string, presentation: ToolPresentation): boolean {
    return this.store.getState().resolveTool(toolUseId, presentation);
  }

  finishAsk(toolUseId: string, block: AskBlock): boolean {
    return this.store.getState().finishAsk(toolUseId, block);
  }

  closeOpenToolGroup(): void {
    this.store.getState().closeOpenToolGroup();
  }

  // ── assistant 流式(语义) ──

  startAssistant(text: string): string {
    return this.store.getState().startAssistant(text);
  }

  updateAssistant(text: string): void {
    // 更新末条 streaming-assistant 的 text。
    // store 没有单独的 updateAssistant action,这里直接操作 model。
    // 但为保持 store 封装,我们通过一个轻量 set 完成。
    this.store.setState((s) => {
      const items = [...s.model.items];
      const idx = items.findIndex(item => item.kind === 'streaming-assistant');
      if (idx < 0) return s;
      const sa = items[idx]!;
      if (sa.kind !== 'streaming-assistant') return s;
      items[idx] = { ...sa, text };
      return { model: { ...s.model, items } };
    });
  }

  finishAssistant(): void {
    this.store.getState().finishAssistant();
  }

  // ── thinking 流式(语义) ──

  startThinking(text: string): string {
    return this.store.getState().startThinking(text);
  }

  updateThinking(text: string): void {
    this.store.setState((s) => {
      const items = [...s.model.items];
      const idx = items.findIndex(item => item.kind === 'pending-thinking');
      if (idx < 0) return s;
      const pt = items[idx]!;
      if (pt.kind !== 'pending-thinking') return s;
      items[idx] = { ...pt, text };
      return { model: { ...s.model, items } };
    });
  }

  eraseThinking(): void {
    // 移除 pending-thinking 活动项。
    this.store.setState((s) => ({
      model: {
        ...s.model,
        items: s.model.items.filter(item => item.kind !== 'pending-thinking'),
      },
    }));
  }

  finishThinking(summary: ThinkingSummaryBlock): void {
    this.store.getState().finishThinking(summary);
  }

  // ── 通用 transcript 追加(用于 user_input / system notification) ──

  appendTranscriptBlock(block: BoundaryBlock): void {
    this.store.getState().appendTranscript(block);
  }

  // ── PipelineRenderer 兼容方法(过渡期) ──
  // 这些在 Task 6 渲染层切换后会被移除。目前 BlockPipeline 仍通过它们驱动。

  appendStreamingMarkdown(
    text: string,
    isFinal: boolean,
    _opts?: { firstLinePrefix?: string },
  ): void {
    if (isFinal) {
      // 固化:更新末条 streaming-assistant 的 text 再 finish。
      this.updateAssistant(text);
      this.finishAssistant();
      return;
    }
    // 非终态:若无 streaming-assistant 则 start,否则 update。
    const state = this.store.getState();
    const has = state.model.items.some(item => item.kind === 'streaming-assistant');
    if (has) {
      this.updateAssistant(text);
    } else {
      this.startAssistant(text);
    }
  }

  sealStreaming(): void {
    this.finishAssistant();
  }

  flushNow(): void {
    // 无操作:store 响应式。
  }

  clearMessages(): void {
    this.store.getState().clear();
  }
}
