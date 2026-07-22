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
import { createTurnDurationMessage } from './turn-duration-message.js';

export type MessageRole = TuiMessage['role'];
export type MessagesStore = StoreApi<MessagesState>;

/**
 * 判断消息是否允许被 appendLine 续接（同 role 追加新行）。
 *
 * 专用固化消息（如 turn-duration 完成消息）一旦写入就锁定行数，
 * 不应被后续 appendLine 合并——否则会让 "✻ Cooked for 9s" 之后的内容
 * 沉默地挤进完成消息。
 *
 * 当前实现里只有 turn-duration 一种专用 kind；未来若新增其他专用 kind
 * （例如 'error'、'system-banner'），必须在此 type guard 里显式排除，
 * 否则 TS narrowing 不会自动报错——这是「显式优于隐式」的防御边界。
 */
export function isAppendableMessage(message: TuiMessage): boolean {
  return message.kind === undefined;
}

export interface MessagesState {
  messages: TuiMessage[];
  /** 自增 id（生成 uuid） */
  _idCounter: number;
  /** 追加一条完整消息（多行，finalized=true） */
  appendMessage: (role: MessageRole, lines: FormattedLine[]) => void;
  /** 追加一行到末条消息（同 role）；不同 role 或空时新建 */
  appendLine: (role: MessageRole, line: FormattedLine) => void;
  /** 追加一条独立的固化完成时长消息 */
  appendTurnDurationMessage: (durationMs: number) => void;
  /** \u8ffd\u52a0\u53ef\u89c1\u7684\u5f85\u5b8c\u6210\u5de5\u5177\u6d88\u606f\uff0c\u8fd4\u56de\u5176 uuid */
  appendPendingTool: (toolUseId: string, lines: FormattedLine[]) => string;
  /** \u53ea\u5b8c\u6210\u5339\u914d\u7684 pending \u5de5\u5177\u6d88\u606f */
  resolvePendingTool: (toolUseId: string, lines: FormattedLine[]) => boolean;
  /** \u5c06 hook \u9644\u5230\u5df2\u5b8c\u6210\u7684\u5de5\u5177\u6d88\u606f */
  appendToolHook: (toolUseId: string, lines: FormattedLine[]) => boolean;
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
  /** 硬撤回:删除末条 user 消息及其后所有消息(幂等:无 user 时空操作)。 */
  rewindLastUserTurn: () => void;
  /** 软中断:末条流式 assistant 固化(保留 streamingText 为 line + 追加 [interrupted] 标记)。
   *  无流式消息时空操作。 */
  finalizeStreamingAsInterrupted: () => void;
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
      // 同 role 且末条已固化且非专用消息（非流式中）→ 续接
      if (last && last.role === role && last.finalized && isAppendableMessage(last)) {
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

    appendTurnDurationMessage: (durationMs) => set((s) => {
      const lastLine = [...s.messages].reverse()
        .find(message => message.lines.length > 0)?.lines.at(-1);
      const id = s._idCounter + 1;
      const message = createTurnDurationMessage({
        uuid: `msg-${id}`,
        durationMs,
        prependBlankLine: Boolean(lastLine && lastLine.content !== ''),
      });
      return { _idCounter: id, messages: [...s.messages, message] };
    }),

    appendPendingTool: (toolUseId, lines) => {
      let uuid = '';
      set((s) => {
        const id = s._idCounter + 1;
        uuid = `msg-${id}`;
        return {
          _idCounter: id,
          messages: [...s.messages, {
            uuid,
            role: 'tool',
            kind: 'tool-progress',
            toolUseId,
            lines,
            finalized: false,
          }],
        };
      });
      return uuid;
    },

    resolvePendingTool: (toolUseId, lines) => {
      let resolved = false;
      set((s) => {
        const index = s.messages.findIndex(message =>
          message.kind === 'tool-progress'
          && message.toolUseId === toolUseId
          && !message.finalized,
        );
        if (index < 0) return s;
        resolved = true;
        const message = s.messages[index]!;
        const updated: TuiMessage = { ...message, lines, finalized: true };
        return { messages: [...s.messages.slice(0, index), updated, ...s.messages.slice(index + 1)] };
      });
      return resolved;
    },

    appendToolHook: (toolUseId, lines) => {
      let appended = false;
      set((s) => {
        const index = s.messages.findIndex(message =>
          message.kind === 'tool-progress' && message.toolUseId === toolUseId,
        );
        if (index < 0) return s;
        appended = true;
        const message = s.messages[index]!;
        const updated: TuiMessage = { ...message, lines: [...message.lines, ...lines] };
        return { messages: [...s.messages.slice(0, index), updated, ...s.messages.slice(index + 1)] };
      });
      return appended;
    },

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

    rewindLastUserTurn: () => set((s) => {
      const msgs = s.messages;
      // 从末尾向前找最后一条 user
      let userIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]!.role === 'user') { userIdx = i; break; }
      }
      if (userIdx === -1) return s; // 幂等:无 user
      return { messages: msgs.slice(0, userIdx) };
    }),

    finalizeStreamingAsInterrupted: () => set((s) => {
      const last = s.messages[s.messages.length - 1];
      // 只处理流式中的 assistant(finalized=false, role='assistant')
      if (!last || last.finalized || last.role !== 'assistant') return s;
      const text = (last.streamingText ?? '').trim();
      const { streamingText: _drop, ...rest } = last;
      void _drop;
      const newLines = text
        ? [
            ...last.lines,
            { content: text, style: {}, indent: 0 },
            { content: '[interrupted]', style: { fg: 'error' }, indent: 0 },
          ]
        : [
            ...last.lines,
            { content: '[interrupted]', style: { fg: 'error' }, indent: 0 },
          ];
      const updated: TuiMessage = { ...rest, lines: newLines, finalized: true };
      return { messages: [...s.messages.slice(0, -1), updated] };
    }),
  }));
}
