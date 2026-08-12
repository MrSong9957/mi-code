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
  type AgentBlock,
  type PendingAgent,
  type PendingTool,
  type SystemBlock,
  type ThinkingGroupMetadata,
  type TimelineItem,
  type ToolBlock,
  type ToolPresentation,
  type TranscriptBlock,
} from '../transcript-types.js';
// type-only:不创建运行时 cycle,符合 tui→agent 的类型导入约定。
import type { TurnStatusCandidate } from '../../agent/turn-final-feedback.js';

// ─────────────────────────────────────────────────────────────────────────────
// 对外类型
// ─────────────────────────────────────────────────────────────────────────────

/** thinking-summary 子类的精确提取(供 deferThinking / 测试使用)。 */
export type ThinkingSummaryBlock = Extract<
  SystemBlock,
  { subkind: 'thinking-summary' }
>;

/** boundary 块:所有已固化块除 ToolBlock / AgentBlock 外(tool/agent 通过专用 reducer 进入)。 */
export type BoundaryBlock = Exclude<TranscriptBlock, ToolBlock | AgentBlock>;

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

/** startAgent 的入参。 */
export interface StartAgentInput {
  /** PendingAgent 的 id(同时是后续 resolveAgent/cancelAgent 的查找键)。 */
  activityId: string;
  /** spawn_agent 的 tool_use id(与 activityId 一致,供 pipeline 层传递)。 */
  agentUseId: string;
  /** 展示 label(由 deriveAgentLabel 从 input 派生)。 */
  label: string;
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

/**
 * 单一的 thinking 提交阈值:只有当汇总时长 ≥ 1s 时,thinking summary 才进入
 * 已固化 transcript。在两个 commit boundary 上统一应用:
 *  - `summarizeThinking`(分组聚合后的可见摘要)
 *  - `flushDeferredThinking` / `startTool` 路径 3(独立 flush 的 standalone summary)
 *
 * 注意:此阈值作用于「最终形成用户可见 summary 的 commit 边界」,而不是
 * 原始 `thinking_end` 事件——duration 始终保留,以便后续聚合到 tool 分组。
 */
export const THINKING_COMMIT_THRESHOLD_MS = 1_000;

/** 单条 / 聚合后的 thinking 时长是否达到提交阈值。 */
export function shouldCommitThinking(durationMs: number): boolean {
  return durationMs >= THINKING_COMMIT_THRESHOLD_MS;
}

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

/**
 * 把所有 deferred thinking 按到达顺序追加到 items 末尾,清空队列。
 *
 * 仅提交达到 `THINKING_COMMIT_THRESHOLD_MS`(1s)的 standalone summary;
 * 时长 < 1s 的不进入已固化 transcript(避免出现 `Thought for 0s`)。
 */
export function flushDeferredThinking(model: TranscriptModel): TranscriptModel {
  if (model.deferredThinking.length === 0) {
    return model;
  }
  const visible = model.deferredThinking.filter(summary =>
    shouldCommitThinking(summary.durationMs),
  );
  return {
    items: [...model.items, ...visible],
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

  // 路径 3:ungroupable → 先 flush deferred(独立 SystemBlock,仅 ≥1s),再追加 closed 单条目
  const closedPending: PendingTool = {
    id: call.activityId,
    kind: 'pending-tool',
    toolName: call.toolName,
    entries: [{ toolUseId: call.toolUseId, input: call.input }],
    thinking: [],
    closed: true,
  };
  return {
    items: [
      ...prefix,
      ...deferred.filter(summary => shouldCommitThinking(summary.durationMs)),
      closedPending,
    ],
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

// ─────────────────────────────────────────────────────────────────────────────
// reducer:子代理(agent)调用归约
//
// spawn_agent 是一等公民:不经过 PendingTool/tool 分组逻辑,直接走 PendingAgent
// 活动项。startAgent 是 boundary(关闭 open tool group + flush deferred thinking),
// resolveAgent/cancelAgent 原地把 PendingAgent 替换为 AgentBlock。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 开始一个子代理调用:关闭 open tool group → flush deferred thinking → 追加 PendingAgent。
 *
 * Agents 永不分组(类似 ungroupable tools),每次调用都创建独立的 PendingAgent。
 */
export function startAgent(
  model: TranscriptModel,
  call: StartAgentInput,
): TranscriptModel {
  const closed = closeOpenToolGroup(model);
  const flushed = flushDeferredThinking(closed);
  const agent: PendingAgent = {
    id: call.activityId,
    kind: 'pending-agent',
    label: call.label,
  };
  return {
    items: [...flushed.items, agent],
    deferredThinking: flushed.deferredThinking,
  };
}

/**
 * 用配对结果完成匹配的 PendingAgent,原地替换为 AgentBlock。
 *
 * - 未知 agentUseId(找不到 pending-agent)→ 返回原 model 不变
 * - 命中 → 构造 AgentBlock(id 来自 PendingAgent,status/summary/durationMs 来自 block)
 */
export function resolveAgent(
  model: TranscriptModel,
  agentUseId: string,
  block: Omit<AgentBlock, 'id' | 'kind'>,
): TranscriptModel {
  let found = false;
  const newItems = model.items.map((item): TimelineItem => {
    if (item.kind === 'pending-agent' && item.id === agentUseId) {
      found = true;
      const agentBlock: AgentBlock = {
        id: item.id,
        kind: 'agent',
        label: block.label,
        status: block.status,
        ...(block.summary !== undefined ? { summary: block.summary } : {}),
        ...(block.durationMs !== undefined ? { durationMs: block.durationMs } : {}),
      };
      return agentBlock;
    }
    return item;
  });
  if (!found) return model;
  return { items: newItems, deferredThinking: model.deferredThinking };
}

/**
 * 取消匹配的 PendingAgent,原地替换为 AgentBlock(status: cancelled)。
 *
 * - 未知 agentUseId → 返回原 model 不变
 * - 命中 → 构造 AgentBlock{ status: 'cancelled', label }
 */
export function cancelAgent(
  model: TranscriptModel,
  agentUseId: string,
  label: string,
): TranscriptModel {
  let found = false;
  const newItems = model.items.map((item): TimelineItem => {
    if (item.kind === 'pending-agent' && item.id === agentUseId) {
      found = true;
      const agentBlock: AgentBlock = {
        id: item.id,
        kind: 'agent',
        label,
        status: 'cancelled',
      };
      return agentBlock;
    }
    return item;
  });
  if (!found) return model;
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
 * - 聚合总时长 < `THINKING_COMMIT_THRESHOLD_MS`(1s)→ null(太短不显示)
 * - 单条且 ≥ 1s → `Thought Ns`
 * - 多条且聚合 ≥ 1s → `Thought Ns (M entries)`
 *
 * 阈值统一作用于聚合总时长(单条 / 多条共享同一规则),不再对单条/多条分别
 * 采用不同阈值。duration 本身仍保留在 ThinkingGroupMetadata 里,这里只决定
 * 用户可见的 summary 是否生成。
 */
export function summarizeThinking(
  entries: readonly ThinkingGroupMetadata[],
): string | null {
  if (entries.length === 0) {
    return null;
  }
  const totalMs = entries.reduce(
    (sum, entry) => sum + entry.durationMs,
    0,
  );
  if (!shouldCommitThinking(totalMs)) {
    return null;
  }
  if (entries.length === 1) {
    return `Thought ${entries[0]!.durationMs / 1_000}s`;
  }
  return `Thought ${totalMs / 1_000}s (${entries.length} entries)`;
}

/**
 * turn 结束时,时间线里是否已有「可见的异常活动」可解释本回合结局。
 *
 * 当任一条目满足以下条件时返回 true:
 * - ToolBlock,且任一 presentation 的 status 为 'error' 或 'cancelled';
 * - AgentBlock,且 status !== 'completed'(partial / failed / cancelled / unknown);
 * - system notification,且 tone === 'error'。
 *
 * 用途:`shouldEmitTurnStatus` 据此决定是否还要补一条 turn-status 兜底行——
 * 当时间线里已有可见的异常活动时,兜底行就是冗余的(用户已能从工具/agent 块看到结局)。
 */
export function hasVisibleAbnormalActivity(
  items: readonly TimelineItem[],
): boolean {
  return items.some((item) => {
    switch (item.kind) {
      case 'tool':
        return item.presentations.some(
          (presentation) =>
            presentation.status === 'error' || presentation.status === 'cancelled',
        );
      case 'agent':
        return item.status !== 'completed';
      case 'system':
        return item.subkind === 'notification' && item.tone === 'error';
      default:
        return false;
    }
  });
}

/**
 * 唯一的生产决策缝:是否真正 emit turn-status 兜底行。
 *
 * = `candidate !== null && !hasVisibleAbnormalActivity(currentTurnItems)`,
 * 其中 currentTurnItems = items 从**最后一条** `kind === 'user'`(含)到末尾的切片。
 *
 * 关键(多回合正确性):时间线 items 跨回合累积,只在 rewind 时裁剪(见
 * `rewindLastUserTurn`)。若把整条时间线喂给 hasVisibleAbnormalActivity,上一回合
 * 残留的异常块(如 Turn 1 失败的工具)会让 Turn 2 的兜底行被错误抑制。因此这里
 * **内部**按"最后一条 user 块"切出当前回合,只检查当前回合内是否已有可见异常活动。
 *
 * user 块本身不是异常活动,所以切片含它(inclusive)是安全的。若无 user 块,
 * 切片 = 全部 items(单回合 / 无 user 边界的退化情形)。
 *
 * index.ts 和 Task 7 验收测试都调用同一个函数,禁止在此之外内联相同判断。
 * 外部签名固定为 `(candidate, items) => boolean`,turn-boundary 切片是内部细节。
 */
export function shouldEmitTurnStatus(
  candidate: TurnStatusCandidate | null,
  items: readonly TimelineItem[],
): boolean {
  if (candidate === null) {
    return false;
  }
  // 取最后一条 user 块的下标(含);无 user 块时切片 = 全部 items。
  // 用反向循环而非 Array#findLastIndex(ES2023):本项目 tsconfig lib=ES2022,
  // 且与 messages-store.rewindLastUserTurn 的既有 idiom 一致。
  let lastUserIdx = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.kind === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const currentTurnItems =
    lastUserIdx === -1 ? items : items.slice(lastUserIdx);
  return !hasVisibleAbnormalActivity(currentTurnItems);
}
