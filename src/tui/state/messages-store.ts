// src/tui/state/messages-store.ts
// 语义时间线 store(zustand vanilla):TimelineItem 列表 + 流式累加
//
// 物理本质:对话的「语义账本」。
// 不再存储 FormattedLine 字符串行,而是存储生命周期安全的 TimelineItem:
// - 已固化块(TranscriptBlock):user / assistant / tool / ask / system / turn-duration
// - 活动项(ActivityItem):streaming-assistant / pending-tool / pending-thinking
//
// 所有工具分组/配对逻辑委托给 transcript-reducer;本 store 只管 id 生成、
// 流式 assistant/thinking 状态,以及把 reducer 产物暴露给渲染层。
//
// 过渡兼容(Task 6 删除):messages / appendLine / appendMessage 是旧 TuiMessage
// 形态的派生视图/桥接,供尚未迁移的渲染层使用。Task 6 渲染层切到 TimelineItem 后移除。

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { FormattedLine } from '../../ui/types.js';
import type { TuiMessage } from '../types.js';
import type {
  ActivityItem,
  AgentBlock,
  AskBlock,
  AssistantBlock,
  ToolPresentation,
} from '../transcript-types.js';
import {
  appendBoundaryBlock,
  closeOpenToolGroup,
  deferThinking,
  emptyModel,
  flushDeferredThinking,
  resolveTool,
  startTool,
  startAgent,
  resolveAgent,
  cancelAgent,
  type BoundaryBlock,
  type ThinkingSummaryBlock,
  type TranscriptModel,
} from './transcript-reducer.js';
import { createTurnDurationBlock, TurnDurationMessage } from './turn-duration-message.js';

export type MessagesStore = StoreApi<MessagesState>;

/**
 * 过渡兼容:把 TimelineItem[] 投影成旧 TuiMessage[]。
 * Task 6 渲染层切到语义块后删除。
 */
function projectLegacyMessages(model: TranscriptModel): TuiMessage[] {
  const out: TuiMessage[] = [];
  for (const item of model.items) {
    switch (item.kind) {
      case 'user':
        out.push({ uuid: item.id, role: 'user', lines: [{ content: `❯ ${item.text}`, style: { fg: 'success', bold: true, bg: 'gray' }, indent: 0 }], finalized: true });
        break;
      case 'assistant':
        out.push({ uuid: item.id, role: 'assistant', lines: [{ content: item.text, style: { fg: 'brand' }, indent: 0 }], finalized: true });
        break;
      case 'streaming-assistant':
        out.push({ uuid: item.id, role: 'assistant', lines: [], finalized: false, streamingText: item.text });
        break;
      case 'pending-thinking':
        out.push({ uuid: item.id, role: 'thinking', kind: 'thinking-progress', lines: [], finalized: false, streamingText: item.text });
        break;
      case 'pending-tool':
        out.push({ uuid: item.id, role: 'tool', kind: 'tool-progress', lines: [{ content: `● ${item.toolName}…`, style: { fg: 'brand' }, indent: 0 }], finalized: !item.closed ? false : true, toolUseId: item.entries[0]?.toolUseId });
        break;
      case 'tool':
        out.push({ uuid: item.id, role: 'tool', kind: 'tool-progress', lines: [{ content: `● ${item.toolName}`, style: { fg: 'brand' }, indent: 0 }, ...item.presentations.map(p => ({ content: `  ⎿ ${p.summary}`, style: { dim: true }, indent: 2 }))], finalized: true });
        break;
      case 'ask':
        out.push({ uuid: item.id, role: 'system', kind: 'agent-completion', lines: [{ content: `● ${item.summary}`, style: { fg: 'brand' }, indent: 0 }, ...item.items.map(i => ({ content: `  ⎿ ${i}`, style: { dim: true }, indent: 2 }))], finalized: true });
        break;
      case 'system':
        if (item.subkind === 'thinking-summary') {
          out.push({ uuid: item.id, role: 'system', lines: [{ content: `  ${item.text}`, style: { dim: true }, indent: 2 }], finalized: true });
        } else {
          out.push({ uuid: item.id, role: 'system', lines: [{ content: item.text, style: item.tone === 'error' ? { fg: 'error' } : {}, indent: 0 }], finalized: true });
        }
        break;
      case 'turn-duration': {
        const tdLine = TurnDurationMessage(item.verb, item.durationMs);
        const tdLines = item.prependBlankLine
          ? [{ content: '', style: {}, indent: 0 }, tdLine]
          : [tdLine];
        const tdMsg: TuiMessage = {
          uuid: item.id, role: 'system', kind: 'turn-duration',
          lines: tdLines, finalized: true,
        };
        // SystemTurnDurationMessage 扩展了 verb/durationMs,这里补上(类型转换)。
        (tdMsg as TuiMessage & { verb: string; durationMs: number }).verb = item.verb;
        (tdMsg as TuiMessage & { verb: string; durationMs: number }).durationMs = item.durationMs;
        out.push(tdMsg);
        break;
      }
    }
  }
  return out;
}

export interface MessagesState {
  /** 语义时间线(reducer 模型)。 */
  model: TranscriptModel;
  /** 自增 id(生成稳定 React key)。 */
  _idCounter: number;

  // ── 语义 store actions(Task 4 接口) ──

  /** 开始一个工具调用,返回该 PendingTool 的 activityId(仅新建组时生效)。 */
  startTool(call: {
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
  }): string;
  /** 解析一个工具调用的展示;返回是否命中。 */
  resolveTool(toolUseId: string, presentation: ToolPresentation): boolean;
  /** 开始一个子代理调用,返回该 PendingAgent 的 id(= agentUseId)。 */
  startAgent(call: { agentUseId: string; label: string }): string;
  /** 完成一个子代理调用(原地固化为 AgentBlock);返回是否命中。 */
  resolveAgent(agentUseId: string, block: Omit<AgentBlock, 'id' | 'kind'>): boolean;
  /** 取消一个子代理调用(原地固化为 AgentBlock cancelled);返回是否命中。 */
  cancelAgent(agentUseId: string, label: string): boolean;
  /** 完成 Ask,写入 AskBlock;返回是否成功。 */
  finishAsk(toolUseId: string, block: AskBlock): boolean;
  /** 开始流式 assistant,返回 id。 */
  startAssistant(text: string): string;
  /** 固化流式 assistant。 */
  finishAssistant(): void;
  /** 开始流式 thinking,返回 id。 */
  startThinking(text: string): string;
  /** 完成 thinking,生成 thinking-summary SystemBlock 并 defer。 */
  finishThinking(summary: ThinkingSummaryBlock): void;
  /** 追加一个已固化 transcript 块(非 tool)。 */
  appendTranscript(block: BoundaryBlock): void;
  /** 关闭当前 open tool group。 */
  closeOpenToolGroup(): void;

  // ── 过渡兼容(Task 6 删除) ──

  /** 旧 TuiMessage[] 派生视图(从 model 投影)。Task 6 渲染层切到 items 后删。 */
  readonly messages: TuiMessage[];
  /** 旧兼容:追加一条完整消息。 */
  appendMessage(role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking', lines: FormattedLine[]): void;
  /** 旧兼容:追加一行(同 role 续接,不同 role 断块)。 */
  appendLine(role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking', line: FormattedLine): void;

  // ── 兼容/辅助 actions ──

  /** 追加 turn-duration 块。 */
  appendTurnDurationMessage(durationMs: number): void;
  /** 软中断:固化流式 assistant 为 interrupted。 */
  finalizeStreamingAsInterrupted(): void;
  /** 清空。 */
  clear(): void;
  /** 硬撤回:删除末条 user 块及其后所有。 */
  rewindLastUserTurn(): void;
}

export function createMessagesStore(): MessagesStore {
  return createStore<MessagesState>((baseSet, get) => {
    // 包装 set:每次更新后自动从 model 投影 messages(过渡兼容,Task 6 删)。
    const set = (partial: Partial<MessagesState> | ((s: MessagesState) => Partial<MessagesState>)) => {
      baseSet((s) => {
        const next = typeof partial === 'function' ? partial(s) : partial;
        const model = next.model ?? s.model;
        return { ...next, messages: projectLegacyMessages(model) };
      });
    };

    return {
    model: emptyModel(),
    messages: [],
    _idCounter: 0,

    startTool(call) {
      const id = `activity-${get()._idCounter + 1}`;
      set((s) => ({
        _idCounter: s._idCounter + 1,
        model: startTool(s.model, {
          activityId: id,
          toolUseId: call.toolUseId,
          toolName: call.toolName,
          input: call.input,
        }),
      }));
      return id;
    },

    resolveTool(toolUseId, presentation) {
      let resolved = false;
      set((s) => {
        const next = resolveTool(s.model, toolUseId, presentation);
        if (next !== s.model) resolved = true;
        return { model: next };
      });
      return resolved;
    },

    startAgent(call) {
      set((s) => ({
        model: startAgent(s.model, {
          activityId: call.agentUseId,
          agentUseId: call.agentUseId,
          label: call.label,
        }),
      }));
      return call.agentUseId;
    },

    resolveAgent(agentUseId, block) {
      let resolved = false;
      set((s) => {
        const next = resolveAgent(s.model, agentUseId, block);
        if (next !== s.model) resolved = true;
        return { model: next };
      });
      return resolved;
    },

    cancelAgent(agentUseId, label) {
      let resolved = false;
      set((s) => {
        const next = cancelAgent(s.model, agentUseId, label);
        if (next !== s.model) resolved = true;
        return { model: next };
      });
      return resolved;
    },

    finishAsk(_toolUseId, block) {
      // Ask 是边界块:先关闭 open tool group,再 flush deferred thinking,再追加。
      set((s) => ({
        model: appendBoundaryBlock(s.model, block),
      }));
      return true;
    },

    startAssistant(text) {
      const id = `activity-${get()._idCounter + 1}`;
      set((s) => {
        // assistant 是边界:先关闭 open tool group + flush deferred。
        const flushed = closeOpenToolGroup(s.model);
        const afterFlush = flushDeferredThinking(flushed);
        const item: ActivityItem = {
          id,
          kind: 'streaming-assistant',
          text,
        };
        return {
          _idCounter: s._idCounter + 1,
          model: { ...afterFlush, items: [...afterFlush.items, item] },
        };
      });
      return id;
    },

    finishAssistant() {
      set((s) => {
        const items = [...s.model.items];
        const idx = items.findIndex(
          item => item.kind === 'streaming-assistant',
        );
        if (idx < 0) return s;
        const sa = items[idx]!;
        if (sa.kind !== 'streaming-assistant') return s;
        const block: AssistantBlock = {
          id: sa.id,
          kind: 'assistant',
          text: sa.text,
        };
        items[idx] = block;
        return { model: { ...s.model, items } };
      });
    },

    startThinking(text) {
      const id = `activity-${get()._idCounter + 1}`;
      set((s) => {
        const item: ActivityItem = {
          id,
          kind: 'pending-thinking',
          text,
        };
        return {
          _idCounter: s._idCounter + 1,
          model: { ...s.model, items: [...s.model.items, item] },
        };
      });
      return id;
    },

    finishThinking(summary) {
      set((s) => {
        // 移除 pending-thinking 活动项,defer summary。
        const items = s.model.items.filter(
          item => item.kind !== 'pending-thinking',
        );
        return {
          model: deferThinking({ ...s.model, items }, summary),
        };
      });
    },

    appendTranscript(block) {
      set((s) => ({
        model: appendBoundaryBlock(s.model, block),
      }));
    },

    closeOpenToolGroup() {
      set((s) => ({ model: closeOpenToolGroup(s.model) }));
    },

    appendTurnDurationMessage(durationMs) {
      set((s) => {
        const id = `activity-${s._idCounter + 1}`;
        // prependBlankLine 判断:items 有内容,或 deferred thinking 将被 flush(也会产生内容)。
        const hasContent = s.model.items.length > 0 || s.model.deferredThinking.length > 0;
        const block = createTurnDurationBlock({
          uuid: id,
          durationMs,
          prependBlankLine: hasContent,
          random: Math.random,
        });
        return {
          _idCounter: s._idCounter + 1,
          model: appendBoundaryBlock(s.model, block),
        };
      });
    },

    finalizeStreamingAsInterrupted() {
      set((s) => {
        const items = [...s.model.items];
        const idx = items.findIndex(
          item => item.kind === 'streaming-assistant',
        );
        if (idx < 0) return s;
        const sa = items[idx]!;
        if (sa.kind !== 'streaming-assistant') return s;
        const block: AssistantBlock = {
          id: sa.id,
          kind: 'assistant',
          text: sa.text,
          interrupted: true,
        };
        items[idx] = block;
        return { model: { ...s.model, items } };
      });
    },

    clear() {
      set({ model: emptyModel(), _idCounter: 0 });
    },

    // ── 过渡兼容 appendMessage/appendLine(Task 6 删除) ──
    appendMessage(role, lines) {
      // 把旧 appendMessage 映射成语义 boundary block。
      const id = `legacy-${get()._idCounter + 1}`;
      const text = lines.map(l => l.content).join('\n');
      if (role === 'user') {
        set((s) => ({
          _idCounter: s._idCounter + 1,
          model: appendBoundaryBlock(s.model, { id, kind: 'user', text }),
        }));
      } else if (role === 'assistant') {
        set((s) => ({
          _idCounter: s._idCounter + 1,
          model: appendBoundaryBlock(s.model, { id, kind: 'assistant', text }),
        }));
      } else {
        set((s) => ({
          _idCounter: s._idCounter + 1,
          model: appendBoundaryBlock(s.model, { id, kind: 'system', subkind: 'notification', text, groupBoundary: 'break' }),
        }));
      }
    },

    appendLine(role, line) {
      // 旧 appendLine:逐行追加。过渡期映射为单条 system/user/assistant block。
      // 注意:旧 appendLine 有续接逻辑(同 role 合并),语义模型里每行都是独立 block。
      // 这会改变视觉间距,但过渡期可接受(Task 6 渲染层接管后删除)。
      this.appendMessage(role, [line]);
    },

    rewindLastUserTurn() {
      set((s) => {
        const items = s.model.items;
        let userIdx = -1;
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i]!.kind === 'user') { userIdx = i; break; }
        }
        if (userIdx === -1) return s;
        return {
          model: {
            ...s.model,
            items: items.slice(0, userIdx),
            deferredThinking: [],
          },
        };
      });
    },
    };
  });
}
