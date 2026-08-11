// src/tui/state/transcript-reducer.ts
// 生命周期安全的时间线 reducer(状态机)。
//
// 物理本质:把上游 pipeline 产出的离散事件(startTool / resolveTool / boundary /
// thinking)归约成一个不可变的 TranscriptModel。核心不变量:
//
// 1. 同名只读工具(glob / grep / read_file)的相邻调用合并进同一个 PendingTool,
//    避免活动区出现一长串同质卡片;工具一完成就原地固化成 ToolBlock。
// 2. deferred thinking 不直接进时间线,而是「挂起」等待匹配的只读工具分组把它
//    透明聚合到尾部;若一直等不到(遇到非 tool 内容),才作为独立 SystemBlock flush。
// 3. boundary(assistant 文本 / 不同工具 / turn-duration)原子地:关闭未关闭的
//    分组 → flush 残留 deferred → 追加新块。关闭未解析的分组**不**造 fallback,
//    它停在原时间线位置,直到最后一条 entry 被解析才原地 complete。
// 4. selectCommittedTranscript 只返回连续的已固化前缀,在第一个 ActivityItem 处
//    截断——防止后完成的块抢先进入 <Static> 造成回溯闪烁。
//
// 所有函数都返回**新 model**(不可变),绝不 mutate 输入。

import {
  completeActivity,
  isActivityItem,
  type PendingTool,
  type SystemBlock,
  type ThinkingGroupMetadata,
  type TimelineItem,
  type ToolBlock,
  type ToolPresentation,
  type TranscriptBlock,
} from '../transcript-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 对外类型
// ─────────────────────────────────────────────────────────────────────────────

/** thinking-summary 子类的精确提取(供 deferThinking / 测试使用)。 */
export type ThinkingSummaryBlock = Extract<
  SystemBlock,
  { subkind: 'thinking-summary' }
>;

/** boundary 块:所有已固化块除 ToolBlock 外(tool 通过 startTool/resolveTool 进入)。 */
export type BoundaryBlock = Exclude<TranscriptBlock, ToolBlock>;

/** reducer 的不可变状态。 */
export interface TranscriptModel {
  /** 完整时间线(已固化块 + 活动项混排)。 */
  items: TimelineItem[];
  /** 已 defer 但尚未找到归属的 thinking summary(按到达顺序)。 */
  deferredThinking: ThinkingSummaryBlock[];
}

/** startTool 的入参。 */
export interface StartToolInput {
  /** 仅在新建 PendingTool 时用作其 id;合并进既有分组时忽略。 */
  activityId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具:工具名规范化 + 可分组判定
// ─────────────────────────────────────────────────────────────────────────────

/** 可分组的规范化工具名白名单(只读、无副作用的检索/读取类工具)。 */
const GROUPABLE_TOOLS: ReadonlySet<string> = new Set([
  'glob',
  'grep',
  'read_file',
]);

/**
 * 把工具别名规范化到统一形态,便于分组判定。
 * - read → read_file
 * - search → glob
 * - 其它原样
 *
 * 注意:reducer 是独立模块,这里重复一份白名单是刻意的自包含设计,
 * 不依赖 tool-presentation(Task 3 不耦合外部模块)。
 */
function normalizeToolName(name: string): string {
  if (name === 'read') return 'read_file';
  if (name === 'search') return 'glob';
  return name;
}

/** 规范化后是否属于可分组的只读工具。 */
function isGroupableTool(name: string): boolean {
  return GROUPABLE_TOOLS.has(normalizeToolName(name));
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具:open group 探测 + 关闭/固化
// ─────────────────────────────────────────────────────────────────────────────

/** 取时间线末尾的 open PendingTool(未关闭);否则返回 null。 */
function getOpenGroup(items: readonly TimelineItem[]): PendingTool | null {
  const last = items[items.length - 1];
  if (last && last.kind === 'pending-tool' && !last.closed) {
    return last;
  }
  return null;
}

/**
 * 把一个 PendingTool 标记为 closed;若此时所有 entry 都已解析,则立即原地
 * complete 成 ToolBlock(via completeActivity)。已 closed 的输入原样返回。
 *
 * 关键:未解析的分组**不**造 fallback,保持 closed PendingTool 形态停在原位,
 * 等待 resolveTool 解析最后一条 entry 后才原地 complete。
 */
function closeOrComplete(group: PendingTool): TimelineItem {
  if (group.closed) {
    return group;
  }
  const closed: PendingTool = { ...group, closed: true };
  if (closed.entries.every(entry => entry.presentation)) {
    return completeActivity(closed);
  }
  return closed;
}

// ─────────────────────────────────────────────────────────────────────────────
// reducer:基础构造
// ─────────────────────────────────────────────────────────────────────────────

/** 空模型。 */
export function emptyModel(): TranscriptModel {
  return { items: [], deferredThinking: [] };
}

/**
 * 把一条 thinking summary 追加到 deferred 队列,**不**追加 transcript item。
 * 后续 startTool(匹配只读分组)或 appendBoundaryBlock/flushDeferredThinking
 * 会消费它。
 */
export function deferThinking(
  model: TranscriptModel,
  summary: ThinkingSummaryBlock,
): TranscriptModel {
  return {
    items: model.items,
    deferredThinking: [...model.deferredThinking, summary],
  };
}

/** 把所有 deferred thinking 按到达顺序追加到 items 末尾,清空队列。 */
export function flushDeferredThinking(model: TranscriptModel): TranscriptModel {
  if (model.deferredThinking.length === 0) {
    return model;
  }
  return {
    items: [...model.items, ...model.deferredThinking],
    deferredThinking: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// reducer:工具调用归约
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 开一个新的工具调用,按规范名 + groupable 决定合并 / 新建 / 立即关闭。
 *
 * - groupable + 末尾有同名 open group → 合并:追加 entry,把 deferred 挂到该 group
 * - groupable + 无匹配 open group → 关闭前一个 open group(若有),新建 open group,
 *   deferred 挂到新 group 的 thinking
 * - ungroupable → 关闭前一个 open group(若有),先把 deferred 作为独立 SystemBlock
 *   flush,再追加一个 **closed** 单条目 PendingTool
 *
 * 三种路径都消耗(deferredThinking 清空)。
 */
export function startTool(
  model: TranscriptModel,
  call: StartToolInput,
): TranscriptModel {
  const groupable = isGroupableTool(call.toolName);
  const normalizedCallName = normalizeToolName(call.toolName);
  const items = model.items;
  const deferred = model.deferredThinking;

  const openGroup = getOpenGroup(items);

  // 路径 1:groupable + 同规范名 open group → 合并
  if (
    groupable &&
    openGroup &&
    normalizeToolName(openGroup.toolName) === normalizedCallName
  ) {
    const merged: PendingTool = {
      ...openGroup,
      entries: [
        ...openGroup.entries,
        { toolUseId: call.toolUseId, input: call.input },
      ],
      // deferred 透明聚合到该分组的 thinking 尾部
      thinking: [...openGroup.thinking, ...deferred],
    };
    const newItems = [...items.slice(0, -1), merged];
    return { items: newItems, deferredThinking: [] };
  }

  // 否则:先关闭既有的 open group(若有,完成或保持 closed pending)
  let prefix: TimelineItem[] = items;
  if (openGroup) {
    prefix = [...items.slice(0, -1), closeOrComplete(openGroup)];
  }

  if (groupable) {
    // 路径 2:groupable 但与 open group 不同名(或无 open group)→ 新建 open group
    const newGroup: PendingTool = {
      id: call.activityId,
      kind: 'pending-tool',
      toolName: call.toolName,
      entries: [{ toolUseId: call.toolUseId, input: call.input }],
      thinking: [...deferred],
      closed: false,
    };
    return { items: [...prefix, newGroup], deferredThinking: [] };
  }

  // 路径 3:ungroupable → 先 flush deferred(独立 SystemBlock),再追加 closed 单条目
  const closedPending: PendingTool = {
    id: call.activityId,
    kind: 'pending-tool',
    toolName: call.toolName,
    entries: [{ toolUseId: call.toolUseId, input: call.input }],
    thinking: [],
    closed: true,
  };
  return {
    items: [...prefix, ...deferred, closedPending],
    deferredThinking: [],
  };
}

/**
 * 用配对结果解析匹配的未解析 entry。
 *
 * - 未知 toolUseId 或重复解析(已 presentation)→ 返回原 model 不变
 * - 命中后:若该 group 已 closed 且全部 entry 解析 → 原地 complete 成 ToolBlock
 * - 否则仅更新该 entry 的 presentation(group 保持原 open/closed 状态)
 */
export function resolveTool(
  model: TranscriptModel,
  toolUseId: string,
  presentation: ToolPresentation,
): TranscriptModel {
  let found = false;

  const newItems = model.items.map((item): TimelineItem => {
    if (item.kind !== 'pending-tool') {
      return item;
    }
    let entryFound = false;
    const newEntries = item.entries.map(entry => {
      if (entry.toolUseId === toolUseId && !entry.presentation) {
        entryFound = true;
        return { ...entry, presentation };
      }
      return entry;
    });
    if (!entryFound) {
      return item;
    }
    found = true;
    const updated: PendingTool = { ...item, entries: newEntries };
    // closed 且全部已解析 → 原地 complete
    if (updated.closed && updated.entries.every(entry => entry.presentation)) {
      return completeActivity(updated);
    }
    return updated;
  });

  if (!found) {
    return model;
  }
  return { items: newItems, deferredThinking: model.deferredThinking };
}

/**
 * 显式关闭末尾的 open PendingTool。若此时所有 entry 已解析则立即 complete。
 * 没有 open group 时返回原 model。
 */
export function closeOpenToolGroup(model: TranscriptModel): TranscriptModel {
  const items = model.items;
  const openGroup = getOpenGroup(items);
  if (!openGroup) {
    return model;
  }
  const settled = closeOrComplete(openGroup);
  return {
    items: [...items.slice(0, -1), settled],
    deferredThinking: model.deferredThinking,
  };
}

/**
 * 原子地追加一个 boundary 块(非 tool):关闭 open group → flush deferred
 * thinking → 追加传入块。
 *
 * 关闭未解析的 open group **不**造 fallback、**不**调 completeActivity——
 * 它停在原时间线位置,等 resolveTool 解析最后一条 entry 后才原地 complete。
 */
export function appendBoundaryBlock(
  model: TranscriptModel,
  block: BoundaryBlock,
): TranscriptModel {
  const closed = closeOpenToolGroup(model);
  const flushed = flushDeferredThinking(closed);
  return {
    items: [...flushed.items, block],
    deferredThinking: flushed.deferredThinking,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 选择器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 返回**连续的**已固化 transcript 块前缀,在第一个 ActivityItem 之前截止。
 *
 * 已关闭但未解析的 PendingTool 仍是 ActivityItem,会截断前缀——这保证后完成
 * 的块不会抢先进入 <Static>,避免回溯闪烁。
 */
export function selectCommittedTranscript(
  items: readonly TimelineItem[],
): TranscriptBlock[] {
  const result: TranscriptBlock[] = [];
  for (const item of items) {
    if (isActivityItem(item)) {
      break;
    }
    result.push(item);
  }
  return result;
}

/**
 * 稳定排序工具展示:success → empty → error → cancelled,组内保持原始相对顺序。
 * Array.prototype.sort 在 ES2019+ 保证稳定。
 */
export function orderToolPresentations(
  presentations: readonly ToolPresentation[],
): ToolPresentation[] {
  const rank: Record<ToolPresentation['status'], number> = {
    success: 0,
    empty: 1,
    error: 2,
    cancelled: 3,
  };
  return [...presentations].sort(
    (a, b) => rank[a.status] - rank[b.status],
  );
}

/**
 * 把一组 thinking 元数据汇总成一行人类可读的摘要。
 *
 * - 空 → null
 * - 恰好 1 条且 < 2000ms → null(太短不显示)
 * - 恰好 1 条且 ≥ 2000ms → `Thought Ns`
 * - 多条 → `Thought Ns (M entries)`(不受 2000ms 阈值限制,总是显示)
 */
export function summarizeThinking(
  entries: readonly ThinkingGroupMetadata[],
): string | null {
  if (entries.length === 0) {
    return null;
  }
  if (entries.length === 1) {
    const only = entries[0];
    if (only.durationMs < 2_000) {
      return null;
    }
    return `Thought ${only.durationMs / 1_000}s`;
  }
  const totalMs = entries.reduce(
    (sum, entry) => sum + entry.durationMs,
    0,
  );
  return `Thought ${totalMs / 1_000}s (${entries.length} entries)`;
}
