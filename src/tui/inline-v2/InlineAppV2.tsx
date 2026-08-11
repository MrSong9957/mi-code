// src/tui/inline-v2/InlineAppV2.tsx
//
// V2 inline 模式根组件。
//
// 物理本质:走 Ink reconciler + <Static> + 活动区(<SpinnerMemo>/<FooterV2>)。
// 与 V0 的 <InlineApp> 区别:返回真正的 React 元素,而非 <></> + 副作用。
//
// 订阅策略(关键):
// - **不**订阅 spinnerStore 整个 state(否则 spinner tick 会触发本组件重渲染,
//   再下传 props 给 <FooterV2>,破坏 memo 隔离)。
// - 只订阅 spinner 的 rowCount(只在 active/variant/auxiliaryLines 变化时变,
//   tick 不影响 rowCount)→ 本组件重渲染频率与 spinner tick 解耦。
// - <SpinnerMemo> 自己订阅整个 spinnerStore,tick 爆炸范围限制在它内部。
//
// <Static> 已固化消息由 Ink 直接写入 scrollback(永久区),不占活动区 y 坐标。
// 活动区(spinner + footer)从 y=0 开始。
//
// LOGO 渲染:logo 作为 <Static> 的首项(特殊 item),与已固化消息一起只写一次进 scrollback。
// 这样 logo 不会被 spinner tick 反复重画(避免 logo 重复出现),且 resize 时通过
// 父组件 ConnectedApp 重挂载本组件(key={resizeKey})让 <Static> 重写 logo + 所有消息。

import React, { useMemo } from 'react';
import { Box, Static, Text } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { TranscriptBlockLine } from './TranscriptBlockLine.js';
import { PendingToolMessage } from './PendingToolMessage.js';
import { PendingThinkingMessage } from './PendingThinkingMessage.js';
import { SpinnerMemo } from './spinner-memo.js';
import { FooterV2 } from './FooterV2.js';
import { StreamingText } from './StreamingText.js';
import { SelectOverlayV2 } from './SelectOverlayV2.js';
import { AskQuestionOverlayV2 } from './AskQuestionOverlayV2.js';
import { ExitPlanModeOverlayV2 } from './ExitPlanModeOverlayV2.js';
import { OverlayHost } from './OverlayHost.js';
import { selectSpinnerView } from '../state/spinner-view.js';
import { computeInputViewportLayout, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH } from '../state/input-viewport.js';
import type { TuiMessage, StatusBarData, LogoData } from '../types.js';
import type { MessagesStore } from '../state/messages-store.js';
import type { TranscriptBlock, ActivityItem } from '../transcript-types.js';
import { selectCommittedTranscript } from '../state/transcript-reducer.js';
import { isVisibleInNormalMode } from '../state/presentation-channel.js';
import type { InputStore } from '../state/input-store.js';
import type { StatusStore } from '../state/status-store.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectStore } from '../state/select-store.js';
import type { SelectionStore } from '../state/selection-store.js';
import type { OverlayStore } from '../state/overlay-store.js';
import type { AskQuestionStore } from '../state/ask-question-store.js';

/** LOGO 在 <Static> items 数组里的特殊 id(避免与消息 uuid 冲突) */
export const LOGO_STATIC_ID = '__logo__';

/** LogoLineV2:渲染 logo 3 行(与 V0 buildLogoAnsi 同款文本,但走 React 元素)。 */
function LogoLineV2({ logo }: { logo: LogoData }): React.ReactElement {
  return (
    <Text>
      <Text color="magenta">{` ▐▛███▜▌   MiCode v${logo.version}`}</Text>
      {'\n'}
      <Text color="magenta">{'▝▜█████▛▘  TypeScript CLI · Node.js Runtime'}</Text>
      {'\n'}
      <Text color="magenta">{`  ▘▘ ▝▝    ${logo.dir}`}</Text>
      {'\n'}
    </Text>
  );
}

/**
 * PendingToolSemantic:把语义 PendingTool 活动项适配到 PendingToolMessage。
 *
 * Task 6 过渡:PendingToolMessage 仍消费旧 TuiMessage 形状,
 * 本组件构造一个兼容的 msg 对象传入。Task 7 可让 PendingToolMessage 直接消费 PendingTool。
 */
function PendingToolSemantic({
  item,
  cols,
  spinnerStore,
}: {
  item: Extract<ActivityItem, { kind: 'pending-tool' }>;
  cols: number;
  spinnerStore: SpinnerStore;
}): React.ReactElement {
  // 构造兼容 TuiMessage:用 toolName + 首个 entry 的 input 显示。
  const firstEntry = item.entries[0];
  const callText = firstEntry
    ? `${item.toolName}(${Object.keys(firstEntry.input).length > 0 ? '...' : ''})`
    : item.toolName;
  const msg: TuiMessage = {
    uuid: item.id,
    role: 'tool',
    kind: 'tool-progress',
    toolUseId: firstEntry?.toolUseId,
    lines: [{ content: `● ${callText}`, style: { fg: 'brand' }, indent: 0 }],
    finalized: false,
  };
  return <PendingToolMessage msg={msg} cols={cols} spinnerStore={spinnerStore} />;
}

export interface InlineAppV2Stores {
  messagesStore: MessagesStore;
  inputStore: InputStore;
  statusStore: StatusStore;
  spinnerStore: SpinnerStore;
  completionStore: CompletionStore;
  selectStore: SelectStore;
  selectionStore: SelectionStore;
  overlayStore: OverlayStore;
  askQuestionStore: AskQuestionStore;
}

export interface InlineAppV2Props {
  messages: TuiMessage[];
  status: StatusBarData;
  logo: LogoData;
  stores: InlineAppV2Stores;
  cols: number;
  rows: number;
}

export function InlineAppV2({ logo, stores, cols }: InlineAppV2Props): React.ReactElement {
  // 语义时间线:从 store 直接读 model.items(Task 6 切换)。
  // messages props 不再消费(渲染层已完全切到语义 TimelineItem)。
  const modelItems = useStore(stores.messagesStore, useShallow((s) => s.model.items));
  const committedTranscript: TranscriptBlock[] = selectCommittedTranscript(modelItems);
  const activityItems: ActivityItem[] = modelItems.slice(committedTranscript.length) as ActivityItem[];

  // 已固化块直接用 TranscriptBlockLine 渲染(语义,无字符串匹配)。
  // Message Presentation v1:在 normal 模式下隐藏 diagnostics-channel 块(非错误
  // system/notification)。源头的 postToolLogger 已抑制常规 [Hook] done,这里是
  // 安全网——任何已经进入 transcript 的 diagnostics 块都不会渲染到 <Static>。
  const finalized = committedTranscript.filter(isVisibleInNormalMode);

  // pending 工具(pending-tool 活动项):运行中工具的稳定指示器。
  const pendingTools = activityItems.filter((i): i is Extract<ActivityItem, { kind: 'pending-tool' }> => i.kind === 'pending-tool');

  // thinking 临时行(pending-thinking 活动项)。
  const pendingThinkingActivity = activityItems.find((i): i is Extract<ActivityItem, { kind: 'pending-thinking' }> => i.kind === 'pending-thinking');

  // streaming-assistant 活动项。
  const streamingActivity = activityItems.find((i): i is Extract<ActivityItem, { kind: 'streaming-assistant' }> => i.kind === 'streaming-assistant');

  // streaming-assistant:从语义活动项读取(Task 6 切换)。
  const streaming = streamingActivity
    ? { uuid: streamingActivity.id, streamingText: streamingActivity.text, role: 'assistant' as const }
    : null;

  // 订阅 input(输入变化触发重渲染,这是必要的)
  const inputText = useStore(stores.inputStore, (s) => s.text);
  const cursor = useStore(stores.inputStore, (s) => s.cursor);

  // 订阅 status(用 useShallow 避免引用抖动)
  const statusData = useStore(stores.statusStore, useShallow((s) => ({
    mode: s.mode, model: s.model, dir: s.dir, branch: s.branch, contextPct: s.contextPct,
  })));

  // 订阅 spinner 的 rowCount(不订阅整个 state——tick 只改 time,不改 rowCount,
  // 故 spinner tick 不会触发本组件重渲染)
  const spinnerRowCount = useStore(stores.spinnerStore, (s) => selectSpinnerView(s).rowCount);

  // 订阅 select 是否可见:visible 时用 SelectOverlay 替代 spinner+footer。
  // 用 boolean selector,只在 visible 翻转时触发本组件重渲染。
  const selectVisible = useStore(stores.selectStore, (s) => s.visible);
  const askQuestionVisible = useStore(stores.askQuestionStore, (s) => s.visible);

  // 订阅 askQuestion 的 presentation kind:用于路由分发。
  // plan-approval → <ExitPlanModeOverlayV2>(计划正文 + 审批操作),
  // 缺失/未知 kind → 安全回退 <AskQuestionOverlayV2>(通用问卷)。
  // askQuestionVisible 为 false 时不需要 kind,返回 null 避免不必要订阅。
  const askPresentationKind = useStore(stores.askQuestionStore, (s) => {
    if (!s.visible || !s.request) return null;
    return s.request.presentation?.kind ?? null;
  });

  // 订阅 overlay 是否可见:visible 时用 <Overlay> 替换活动区(只显示折叠块全文)。
  // 复用 alt-screen 的 <Overlay> 组件,Props 一致。
  //
  // **关键设计**:Overlay 不再 return 在根元素之外(以前 if (overlayVisible) return <Overlay/>),
  // 而是作为同根 <Box> 下的条件子树。原因:Ink reconciler 在 <Static> 宿主节点身份变化时
  // (staticNode !== previousStaticNode)会清空 fullStaticOutput,导致 logo + 已固化消息丢失。
  // 父元素类型切换(Box→Overlay→Box)会让 <Static> 卸载重挂载 → identity 变化 → bug。
  // 保持根元素稳定(<Box>),Overlay 作为内部条件渲染,避免 <Static> 卸载。
  // overlayVisible 订阅保持 OverlayHost 与活动区渲染同步(OverlayHost 自管 visible,
  // 但订阅确保 overlay 状态变化时活动区也重渲染)。值本身不直接消费。
  void useStore(stores.overlayStore, (s) => s.visible);

  // 物理行模型 layout(useMemo 缓存引用——spinner tick 不触发 FooterV2 重渲染,memo 隔离)。
  const layout = useMemo(
    () => computeInputViewportLayout(inputText, cursor, cols, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH),
    [inputText, cursor, cols],
  );

  // 流式文本占的行数(用于计算 spinner/footer 的 y 偏移)。
  // 物理行数近似:每行按 cols 折算,首行扣除 ● 前缀。粗估即可(精确行数由 Ink yoga 算)。
  // 注:streamingText 末尾不完整的行被 wrapStreamingTextTrimmed 隐藏,这里按完整行估算。
  const streamingRowCount = streaming?.streamingText
    ? Math.max(1, streaming.streamingText.split('\n').length)
    : 0;

  // AUTO-0025-stable:pending 工具固定占一物理行(由 PendingToolMessage 的 height={1} 保证)。
  // 行数 = pending 工具数量,不再用 lines.length 估算(避免子明细行导致高度抖动)。
  const pendingToolsRowCount = pendingTools.length;

  // AUTO-0025-transient:thinking 临时行固定占一物理行(0 或 1)。
  const thinkingRowCount = pendingThinkingActivity ? 1 : 0;

  // 有 pending 活动时,pending 区与 spinner 间留一空行分隔(视觉间距)。
  const pendingGapRowCount = (pendingThinkingActivity || pendingToolsRowCount > 0) ? 1 : 0;

  // inputRowY(活动区内坐标,<Static> 不占活动区):
  //   流式文本 + thinking 行 + pending 工具行 + pending/spinner 间距 + spinner 行 + 上边框 1 行
  const inputRowY = streamingRowCount + thinkingRowCount + pendingToolsRowCount + pendingGapRowCount + spinnerRowCount + 1;

  // <Static> items:logo 作为首项(只写一次进 scrollback)+ 已固化语义块。
  // Task 6:已固化块用 TranscriptBlockLine 渲染(语义,无字符串匹配)。
  // 工具分组由 reducer 完成,不再需要 groupConsecutiveReadMessages。
  type StaticItem =
    | { kind: 'logo'; id: typeof LOGO_STATIC_ID; logo: LogoData }
    | { kind: 'block'; id: string; block: TranscriptBlock };
  const staticItems: StaticItem[] = [
    { kind: 'logo', id: LOGO_STATIC_ID, logo },
    ...finalized.map((block): StaticItem => ({
      kind: 'block',
      id: block.id,
      block,
    })),
  ];

  // 防御性断言:logo 必须在 staticItems 首位。
  // 背景:LOGO 曾间歇性消失,根因可能是重构时把 logo item 漏掉或顺序错。
  // 开发环境立刻抛错(NODE_ENV !== 'production'),生产环境跳过避免开销。
  if (process.env.NODE_ENV !== 'production') {
    if (staticItems.length === 0 || staticItems[0]!.kind !== 'logo') {
      throw new Error(
        'InlineAppV2 不变量破坏:logo 必须是 <Static> items 的首项,实际首项: '
        + (staticItems[0]?.kind ?? '空数组'),
      );
    }
  }

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(item) => item.kind === 'logo'
          ? <LogoLineV2 key={item.id} logo={item.logo} />
          : (
            <Box key={item.id} marginBottom={1}>
              <TranscriptBlockLine block={item.block} cols={cols} />
            </Box>
          )}
      </Static>
      {/* OverlayHost:visible 时进终端备用屏直接写 stdout(不走 Ink 渲染),
          避免覆盖 footer 或盖不住 scrollback。返回 null,无可见 React 元素。 */}
      <OverlayHost store={stores.overlayStore} cols={cols} />
      {/* 活动区始终渲染,即使 overlayVisible。
          原因:overlayVisible 时活动区被备用屏遮住(用户看不见),但 Ink 的 lastOutput
          仍含完整 footer。退出备用屏后,主屏的 footer 物理上一直在,无需 Ink 重绘。
          如果切换时隐藏活动区,Ink 的 lastOutput 会变成空白,退出备用屏后 footer 不恢复。
          契约由 overlay-footer-recovery.test.tsx 的"关键契约"测试守护。 */}
      <>
        {streaming && (
          <StreamingText
            text={streaming.streamingText}
            role="assistant"
            cols={cols}
          />
        )}
        {/* AUTO-0025-transient:thinking 临时行(闪烁 ● Thinking…)。
            单例,固定一行,在 pending 工具之前渲染。 */}
        {pendingThinkingActivity && (
          <PendingThinkingMessage cols={cols} spinnerStore={stores.spinnerStore} />
        )}
        {/* AUTO-0025-stable:pending 工具用专用稳定指示器渲染(固定一行 + 闪烁 ●)。
            Task 6:pendingTools 现在是语义 PendingTool 活动项。 */}
        {pendingTools.map((pt) => (
          <PendingToolSemantic
            key={pt.id}
            item={pt}
            cols={cols}
            spinnerStore={stores.spinnerStore}
          />
        ))}
        {/* 有 pending 活动(thinking 或工具)时,与 spinner 留一行空行分隔,
            避免 spawn_agent 紧贴 spinner 动画行。 */}
        {(pendingThinkingActivity || pendingTools.length > 0) && (
          <Box height={1}>
            <Text>{' '}</Text>
          </Box>
        )}
        {askQuestionVisible ? (
          askPresentationKind === 'plan-approval' ? (
            <ExitPlanModeOverlayV2 store={stores.askQuestionStore} cols={cols} />
          ) : (
            <AskQuestionOverlayV2 store={stores.askQuestionStore} cols={cols} />
          )
        ) : selectVisible ? (
          // Select 选择器:替代 spinner+footer 占据活动区(自订阅 selectStore)
          <SelectOverlayV2 store={stores.selectStore} cols={cols} />
        ) : (
          <>
            <SpinnerMemo store={stores.spinnerStore} />
            <FooterV2
              status={statusData}
              cols={cols}
              inputRowY={inputRowY}
              layout={layout}
              completionStore={stores.completionStore}
              selectionStore={stores.selectionStore}
            />
          </>
        )}
      </>
    </Box>
  );
}
