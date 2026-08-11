// src/tui/transcript-types.ts
// 生命周期安全的 transcript / activity 类型系统。
//
// 物理本质:把"字符串形状的 TUI 消息"换成"判别联合类型的数据模型"。
// 上游 pipeline 配对 call/result 后产出演义过的语义块(TranscriptBlock),
// Ink <Static> 直接消费已固化的块;活动区(ActivityItem)展示未完成的流式
// assistant / pending-tool / pending-thinking。渲染层不再解析渲染字符串来
// 判断工具类型或分组,杜绝 `content.startsWith('● Read(')` 这类脆弱启发式。

import type { StructuredAskResult } from '../agent/ask-user-types.js';
import type { TurnCompletionVerb } from './state/turn-duration-message.js';

/** 工具展示状态:成功 / 空 / 错误 / 已取消(错误保留在分组内,不单独拆组)。 */
export type ToolPresentationStatus = 'success' | 'empty' | 'error' | 'cancelled';

/**
 * 工具结果的语义明细项。
 * Phase 1 只定义类型,渲染层暂不展开 details,但数据仍可达(供可展开注册)。
 */
export type DetailItem =
  | { kind: 'path'; path: string }
  | { kind: 'location'; path: string; line?: number; column?: number }
  | { kind: 'snippet'; text: string; path?: string; line?: number }
  | { kind: 'text'; text: string };

/** 单次工具调用配对后的语义展示(不含渲染前缀,只含数据)。 */
export interface ToolPresentation {
  toolUseId: string;
  toolName: string;
  summary: string;
  details: DetailItem[];
  status: ToolPresentationStatus;
  errorMessage?: string;
  layout?: 'standard' | 'compact-completion';
}

/** 工具分组里挂载的 thinking 元数据(透明聚合到分组尾部)。 */
export interface ThinkingGroupMetadata {
  durationMs: number;
  expandableId?: string;
}

/** pending-tool 的一条未完成/已解析条目。 */
export interface PendingToolEntry {
  toolUseId: string;
  input: Record<string, unknown>;
  presentation?: ToolPresentation;
}

// ─────────────────────────────────────────────────────────────────────────────
// 已固化 transcript 块(进入 <Static>)
// ─────────────────────────────────────────────────────────────────────────────

export interface UserBlock {
  id: string;
  kind: 'user';
  text: string;
}

export interface AssistantBlock {
  id: string;
  kind: 'assistant';
  text: string;
  interrupted?: boolean;
}

export interface ToolBlock {
  id: string;
  kind: 'tool';
  toolName: string;
  presentations: ToolPresentation[];
  thinking: ThinkingGroupMetadata[];
}

export interface AskBlock {
  id: string;
  kind: 'ask';
  summary: string;
  items: string[];
  outcome?: StructuredAskResult['outcome'];
}

export type SystemBlock =
  | {
      id: string;
      kind: 'system';
      subkind: 'thinking-summary';
      text: string;
      durationMs: number;
      groupBoundary: 'transparent';
      expandableId?: string;
    }
  | {
      id: string;
      kind: 'system';
      subkind: 'notification';
      text: string;
      groupBoundary: 'break';
      tone?: 'normal' | 'error';
    };

export interface TurnDurationBlock {
  id: string;
  kind: 'turn-duration';
  durationMs: number;
  verb: TurnCompletionVerb;
  prependBlankLine: boolean;
}

/** 所有已固化 transcript 块的判别联合。 */
export type TranscriptBlock =
  | UserBlock
  | AssistantBlock
  | ToolBlock
  | AskBlock
  | SystemBlock
  | TurnDurationBlock;

// ─────────────────────────────────────────────────────────────────────────────
// 活动(未固化,渲染在活动区)
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamingAssistant {
  id: string;
  kind: 'streaming-assistant';
  text: string;
  interrupted?: boolean;
}

export interface PendingTool {
  id: string;
  kind: 'pending-tool';
  toolName: string;
  entries: PendingToolEntry[];
  thinking: ThinkingGroupMetadata[];
  closed: boolean;
}

export interface PendingThinking {
  id: string;
  kind: 'pending-thinking';
  text: string;
  summary?: string;
  durationMs?: number;
  expandableId?: string;
}

/** 所有活动项的判别联合。kind 集合与 TranscriptBlock 不相交。 */
export type ActivityItem =
  | StreamingAssistant
  | PendingTool
  | PendingThinking;

/** 完整时间线 = 已固化块 + 活动项。 */
export type TimelineItem = TranscriptBlock | ActivityItem;

// ─────────────────────────────────────────────────────────────────────────────
// 运行时守卫
// ─────────────────────────────────────────────────────────────────────────────

const TRANSCRIPT_KINDS = new Set<string>([
  'user', 'assistant', 'tool', 'ask', 'system', 'turn-duration',
]);
const ACTIVITY_KINDS = new Set<string>([
  'streaming-assistant', 'pending-tool', 'pending-thinking',
]);

/** 判断时间线条目是否为已固化 transcript 块。 */
export function isTranscriptBlock(item: TimelineItem): item is TranscriptBlock {
  return TRANSCRIPT_KINDS.has(item.kind);
}

/** 判断时间线条目是否为活动项(未固化)。 */
export function isActivityItem(item: TimelineItem): item is ActivityItem {
  return ACTIVITY_KINDS.has(item.kind);
}

// ─────────────────────────────────────────────────────────────────────────────
// completeActivity:把活动项转换为已固化 transcript 块
// ─────────────────────────────────────────────────────────────────────────────

/** 穷尽性检查 helper:union 收窄到底时报错(编译期 + 运行期)。 */
function assertNever(value: never): never {
  throw new Error(`Unexpected timeline item: ${JSON.stringify(value)}`);
}

/**
 * 把一个活动项收尾成已固化 transcript 块。
 *
 * - StreamingAssistant → AssistantBlock
 * - PendingTool(必须 closed 且所有 entry 已解析)→ ToolBlock
 * - PendingThinking(必须有 summary + duration)→ thinking-summary SystemBlock
 */
export function completeActivity(item: StreamingAssistant): AssistantBlock;
export function completeActivity(item: PendingTool): ToolBlock;
export function completeActivity(item: PendingThinking): SystemBlock;
export function completeActivity(item: ActivityItem): TranscriptBlock {
  switch (item.kind) {
    case 'streaming-assistant':
      return { id: item.id, kind: 'assistant', text: item.text, interrupted: item.interrupted };
    case 'pending-tool': {
      if (!item.closed || item.entries.some(entry => !entry.presentation)) {
        throw new Error('Cannot complete an open or unresolved PendingTool');
      }
      return {
        id: item.id,
        kind: 'tool',
        toolName: item.toolName,
        presentations: item.entries.map(entry => entry.presentation!),
        thinking: item.thinking,
      };
    }
    case 'pending-thinking':
      if (item.summary === undefined || item.durationMs === undefined) {
        throw new Error('Cannot complete PendingThinking without summary metadata');
      }
      return {
        id: item.id,
        kind: 'system',
        subkind: 'thinking-summary',
        text: item.summary,
        durationMs: item.durationMs,
        expandableId: item.expandableId,
        groupBoundary: 'transparent',
      };
    default:
      return assertNever(item);
  }
}
