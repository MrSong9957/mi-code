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

import React from 'react';
import { Box, Static, Text } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { MessageLine } from './MessageLine.js';
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
import { computeInputViewport, MAX_VISIBLE_INPUT_LINES } from '../state/input-viewport.js';
import { cursorScreenPos } from '../state/cursor-position.js';
import type { TuiMessage, StatusBarData, LogoData } from '../types.js';
import type { MessagesStore } from '../state/messages-store.js';
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

export function InlineAppV2({ messages, logo, stores, cols }: InlineAppV2Props): React.ReactElement {
  const finalized = messages.filter((m) => m.finalized);

  // AUTO-0025 修复:pending 工具调用(未拿到结果、kind='tool-progress')必须在活动区可见。
  // 物理本质:慢工具(spawn_agent / read_file 等)执行时,其 call 行应立即出现在终端,
  // 让用户看到"● spawn_agent(...) 正在运行",而不是等结果回来才一次性显示。
  // 不写入 <Static> —— 否则结果到达后无法原地更新(resolvePendingTool 需要可变 pending 消息)。
  const pendingTools = messages.filter((m) => !m.finalized && m.kind === 'tool-progress');

  // AUTO-0025-transient:thinking 临时行(最多一条)。单例由 messages-store 保证。
  const pendingThinking = messages.find((m) => !m.finalized && m.kind === 'thinking-progress');

  // 订阅末条未固化 assistant 消息的 streamingText + role(流式 token 到达触发重渲染——必要)。
  // AUTO-0025-transient:限制为 role === 'assistant'——thinking-progress 也是未固化末条消息,
  // 但它的渲染走 PendingThinkingMessage(固定文本),不能进 StreamingText。
  // 用 useShallow 让 selector 输出引用稳定(浅比较相等时返回同一对象),
  // 避免每次都返回新对象触发 React "getSnapshot should be cached" 警告。
  const streaming = useStore(stores.messagesStore, useShallow((s) => {
    const last = s.messages[s.messages.length - 1];
    if (!last || last.finalized || last.role !== 'assistant') return null;
    return { uuid: last.uuid, streamingText: last.streamingText, role: last.role };
  }));

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
  const overlayVisible = useStore(stores.overlayStore, (s) => s.visible);

  // 输入框视口:光标居中滚动,超出 MAX_VISIBLE_INPUT_LINES 时 viewportTop 跟随。
  const totalInputLines = inputText.split('\n').length;
  const cursorLine = cursorScreenPos(inputText, cursor, '❯ ').y;
  const vp = computeInputViewport(totalInputLines, cursorLine, MAX_VISIBLE_INPUT_LINES);

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
  const thinkingRowCount = pendingThinking ? 1 : 0;

  // inputRowY(活动区内坐标,<Static> 不占活动区):
  //   流式文本 + thinking 行 + pending 工具行 + spinner 行 + 上边框 1 行
  const inputRowY = streamingRowCount + thinkingRowCount + pendingToolsRowCount + spinnerRowCount + 1;

  // <Static> items:logo 作为首项(只写一次进 scrollback)+ 已固化消息。
  // 用 discriminator 字段区分 logo item 和 message item。
  type StaticItem =
    | { kind: 'logo'; id: typeof LOGO_STATIC_ID; logo: LogoData }
    | { kind: 'message'; id: string; msg: TuiMessage };
  const staticItems: StaticItem[] = [
    { kind: 'logo', id: LOGO_STATIC_ID, logo },
    ...finalized.map((msg): StaticItem => ({ kind: 'message', id: msg.uuid, msg })),
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
          : <MessageLine key={item.id} msg={item.msg} cols={cols} />}
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
        {pendingThinking && (
          <PendingThinkingMessage cols={cols} spinnerStore={stores.spinnerStore} />
        )}
        {/* AUTO-0025-stable:pending 工具用专用稳定指示器渲染(固定一行 + 闪烁 ●)。
            叶子组件自订阅 spinnerStore.time/active,tick 不拖动本组件重渲染。
            子代理内部工具明细不进入这里(见 Task 3 删除进度桥接)。 */}
        {pendingTools.map((msg) => (
          <PendingToolMessage
            key={msg.uuid}
            msg={msg}
            cols={cols}
            spinnerStore={stores.spinnerStore}
          />
        ))}
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
              input={inputText}
              cursor={cursor}
              status={statusData}
              cols={cols}
              inputRowY={inputRowY}
              viewportTop={vp.viewportTop}
              completionStore={stores.completionStore}
              selectionStore={stores.selectionStore}
            />
          </>
        )}
      </>
    </Box>
  );
}
