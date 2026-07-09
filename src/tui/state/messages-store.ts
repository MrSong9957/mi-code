// src/tui/state/messages-store.ts
// 消息列表 store（zustand vanilla）：TuiMessage 列表 + 流式累加
//
// 物理本质：对话消息的「账本」。
// BlockPipeline 产出 FormattedLine（格式化好的单行），本 store 把它们聚合成 TuiMessage：
// - appendLine(role, line)：同 role 续接末条消息，不同 role 断块新建
// - startStreaming/updateStreaming/finalizeStreaming：assistant 流式（streamingText 累积，
//   finalize 时把 StreamingMarkdown 渲染结果固化为 lines）
//
// 性能：流式 delta 只更新末条 message 的 streamingText；React 侧用 selector
// 只订阅末条 assistant，避免整列表 re-render（Phase 5/6 优化）。

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { FormattedLine } from '../../ui/types.js';
import type { TuiMessage } from '../types.js';

export type MessageRole = TuiMessage['role'];
export type MessagesStore = StoreApi<MessagesState>;

export interface MessagesState {
  messages: TuiMessage[];
  /** 自增 id（生成 uuid） */
  _idCounter: number;
  /** 追加一条完整消息（多行，finalized=true） */
  appendMessage: (role: MessageRole, lines: FormattedLine[]) => void;
  /** 追加一行到末条消息（同 role）；不同 role 或空时新建 */
  appendLine: (role: MessageRole, line: FormattedLine) => void;
  /** 开一条流式 assistant（finalized=false, streamingText=initialText） */
  startStreaming: (initialText: string) => void;
  /** 开一条流式 thinking（role='thinking', 灰色 dim） */
  startStreamingThinking: (initialText: string) => void;
  /** 更新末条流式 assistant 的 streamingText（累加全文） */
  updateStreaming: (text: string) => void;
  /** 更新末条流式 thinking 的 streamingText */
  updateStreamingThinking: (text: string) => void;
  /** 移除末条流式 thinking 消息（折叠为摘要时调用） */
  removeStreamingThinking: () => void;
  /** 固化末条流式（finalized=true，固化 lines，清 streamingText） */
  finalizeStreaming: (lines: FormattedLine[]) => void;
  /** 清空所有消息 */
  clear: () => void;
}

export function createMessagesStore(): MessagesStore {
  return createStore<MessagesState>((set) => ({
    messages: [],
    _idCounter: 0,

    appendMessage: (role, lines) => set((s) => ({
      _idCounter: s._idCounter + 1,
      messages: [...s.messages, {
        uuid: `msg-${s._idCounter + 1}`,
        role,
        lines,
        finalized: true,
      }],
    })),

    appendLine: (role, line) => set((s) => {
      const last = s.messages[s.messages.length - 1];
      // 同 role 且末条已固化（非流式中）→ 续接
      if (last && last.role === role && last.finalized) {
        const updated = { ...last, lines: [...last.lines, line] };
        return { messages: [...s.messages.slice(0, -1), updated] };
      }
      // 否则新建
      const id = s._idCounter + 1;
      return {
        _idCounter: id,
        messages: [...s.messages, {
          uuid: `msg-${id}`,
          role,
          lines: [line],
          finalized: true,
        }],
      };
    }),

    startStreaming: (initialText) => set((s) => {
      const id = s._idCounter + 1;
      return {
        _idCounter: id,
        messages: [...s.messages, {
          uuid: `msg-${id}`,
          role: 'assistant',
          lines: [],
          finalized: false,
          streamingText: initialText,
        }],
      };
    }),

    /** 开一条流式 thinking 消息（灰色 dim，role='thinking'） */
    startStreamingThinking: (initialText) => set((s) => {
      const id = s._idCounter + 1;
      return {
        _idCounter: id,
        messages: [...s.messages, {
          uuid: `msg-${id}`,
          role: 'thinking',
          lines: [],
          finalized: false,
          streamingText: initialText,
        }],
      };
    }),

    updateStreaming: (text) => set((s) => {
      const last = s.messages[s.messages.length - 1];
      if (!last || last.finalized || last.role !== 'assistant') return s;
      const updated = { ...last, streamingText: text };
      return { messages: [...s.messages.slice(0, -1), updated] };
    }),

    /** 更新末条流式 thinking 的 streamingText */
    updateStreamingThinking: (text) => set((s) => {
      const last = s.messages[s.messages.length - 1];
      if (!last || last.finalized || last.role !== 'thinking') return s;
      const updated = { ...last, streamingText: text };
      return { messages: [...s.messages.slice(0, -1), updated] };
    }),

    /** 移除末条流式 thinking 消息（折叠为摘要时调用，摘要由 printMessage 追加） */
    removeStreamingThinking: () => set((s) => {
      const last = s.messages[s.messages.length - 1];
      if (!last || last.finalized || last.role !== 'thinking') return s;
      return { messages: s.messages.slice(0, -1) };
    }),

    finalizeStreaming: (lines) => set((s) => {
      const last = s.messages[s.messages.length - 1];
      if (!last || last.finalized) {
        // 无流式消息：当作普通 append
        const id = s._idCounter + 1;
        return {
          _idCounter: id,
          messages: [...s.messages, {
            uuid: `msg-${id}`, role: 'assistant', lines, finalized: true,
          }],
        };
      }
      const { streamingText: _removed, ...rest } = last;
      void _removed;
      const updated: TuiMessage = { ...rest, lines, finalized: true };
      return { messages: [...s.messages.slice(0, -1), updated] };
    }),

    clear: () => set({ messages: [], _idCounter: 0 }),
  }));
}
