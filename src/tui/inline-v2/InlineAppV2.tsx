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
import { renderFinalizedLine } from '../inline/text-layout.js';
import type { FormattedLine } from '../../ui/types.js';
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

/** 聚合预览的最大 path 行数(超出折叠为 +N more)。 */
const READ_GROUP_PREVIEW_LINES = 4;

/**
 * 从 read_file message 的首行 `● Read(path)` 解析出 path。
 * 解析失败回退原 content(防御,不阻塞渲染)。
 */
function extractReadPath(msg: TuiMessage): string {
  const content = msg.lines[0]?.content ?? '';
  // 匹配 ● Read(path) 提取 path(任务约束:稳定判断前缀,不依赖路径格式)
  const match = content.match(/^● Read\((.*)\)$/);
  return match ? match[1]! : content;
}

/**
 * ReadGroupLine:连续 read_file 的聚合渲染组件。
 *
 * 物理本质:把多个 ● Read(path) 块压缩成一个:
 *   ● Read 3 items
 *     ⎿ src/
 *     ⎿ src/agent/
 *     ⎿ src/utils/
 *     +0 more (ctrl+o to expand)   ← 仅超出预览行数时
 *
 * 渲染契约与 MessageLine 一致:用 renderFinalizedLine 转 ANSI,
 * 每行 + '\n',复用 tool role 的样式映射。
 *
 * 本期不实现 ctrl+o 展开(任务范围:只做预览折叠)。
 */
function ReadGroupLine({ msgs, cols }: { msgs: TuiMessage[]; cols: number }): React.ReactElement {
  const paths = msgs.map(extractReadPath);
  // 标题行:● Read N items(复用 magenta 样式,与单个 Read 的 ● 一致)
  const titleLine: FormattedLine = {
    content: `● Read ${msgs.length} items`,
    style: { fg: 'brand' },
    indent: 0,
  };
  // path 预览行:⎿ path /    path(首行 ⎿,续行对齐空格,与 formatToolResult 风格一致)
  const truncated = paths.length > READ_GROUP_PREVIEW_LINES;
  const previewPaths = paths.slice(0, READ_GROUP_PREVIEW_LINES);
  const pathLines: FormattedLine[] = previewPaths.map((p, i) => ({
    content: `${i === 0 ? '⎿  ' : '   '}${p}`,
    style: { dim: true },
    indent: 2,
    raw: true,
  }));
  if (truncated) {
    const hidden = paths.length - READ_GROUP_PREVIEW_LINES;
    pathLines.push({
      content: `   +${hidden} more (ctrl+o to expand)`,
      style: { dim: true },
      indent: 2,
      raw: true,
    });
  }
  const allLines = [titleLine, ...pathLines];
  return (
    <Text>
      {allLines.flatMap((line, lineIdx) =>
        renderFinalizedLine('tool', line, cols).map((ansiLine, i) => (
          <Text key={`${lineIdx}-${i}`}>{ansiLine + '\n'}</Text>
        ))
      )}
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

  // 有 pending 活动时,pending 区与 spinner 间留一空行分隔(视觉间距)。
  const pendingGapRowCount = (pendingThinking || pendingToolsRowCount > 0) ? 1 : 0;

  // inputRowY(活动区内坐标,<Static> 不占活动区):
  //   流式文本 + thinking 行 + pending 工具行 + pending/spinner 间距 + spinner 行 + 上边框 1 行
  const inputRowY = streamingRowCount + thinkingRowCount + pendingToolsRowCount + pendingGapRowCount + spinnerRowCount + 1;

  // <Static> items:logo 作为首项(只写一次进 scrollback)+ 已固化消息。
  // Read 聚合:连续 read_file 经 groupConsecutiveReadMessages 合并成 read-group,
  // 渲染成 ● Read N items + ⎿ path 预览,减少垂直占用。
  // logo 不参与聚合(单独处理,保证首位不变量)。
  type StaticItem =
    | { kind: 'logo'; id: typeof LOGO_STATIC_ID; logo: LogoData }
    | { kind: 'message'; id: string; msg: TuiMessage }
    | { kind: 'read-group'; id: string; msgs: TuiMessage[] };
  const displayItems = groupConsecutiveReadMessages(finalized);
  const staticItems: StaticItem[] = [
    { kind: 'logo', id: LOGO_STATIC_ID, logo },
    ...displayItems.map((item): StaticItem => {
      if (item.kind === 'read-group') {
        // 组 id 用成员 uuid 拼接,保证唯一且稳定(Static 需要稳定 key)
        return { kind: 'read-group', id: 'rg-' + item.msgs.map(m => m.uuid).join('-'), msgs: item.msgs };
      }
      return { kind: 'message', id: item.msg.uuid, msg: item.msg };
    }),
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
          : item.kind === 'read-group'
            ? <ReadGroupLine key={item.id} msgs={item.msgs} cols={cols} />
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
        {/* 有 pending 活动(thinking 或工具)时,与 spinner 留一行空行分隔,
            避免 spawn_agent 紧贴 spinner 动画行。 */}
        {(pendingThinking || pendingTools.length > 0) && (
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

// ─────────────────────────────────────────────────────────────
// Read 聚合显示适配器(display adapter,纯函数)
//
// 物理本质:渲染前的"分组翻译器"。不改 message 数据,只把连续的
// read_file tool message 合并成一个 read-group 显示条目。
//
// 解决问题:连续多个 Read 各占一个 ● 块,占用垂直空间。
// 聚合后渲染成 ● Read N items + ⎿ path 预览。
//
// 关键约束 —— <Static> append-only:
//   Ink <Static> 已渲染的 item 不可变(内部用 index 跳过已渲染项)。
//   因此聚合基于"已 finalized 的连续段"做回溯合并——段被非 Read 打断时
//   锁定,生成后不再变。这与 Static 的 append-only 语义契合。
//
// 聚合规则(严格):
//   连续满足 role==='tool' && lines[0].content 以 '● Read(' 开头
//   段被以下任一打断:role!=='tool'、content 不以 ● Read( 开头
//   仅 ≥2 个才聚合成 read-group;单个 Read 保持原样(行为不变)
//
// 工具名识别:解析 lines[0].content 前缀 '● Read('。
// 不新增 message 字段(任务约束:纯显示优化,不改 schema)。
// ─────────────────────────────────────────────────────────────

/** 显示条目:聚合后的渲染单元,区分单条消息与 Read 聚合组。 */
export type DisplayItem =
  | { kind: 'message'; msg: TuiMessage }
  | { kind: 'read-group'; msgs: TuiMessage[] };

/** 判断 message 是否是 read_file 工具调用(用于聚合识别)。 */
function isReadToolMessage(msg: TuiMessage): boolean {
  // 仅 tool role 参与;system/assistant 等即使内容巧合也不聚合(防御)
  if (msg.role !== 'tool') return false;
  const firstLine = msg.lines[0];
  // 稳定判断:content 以 '● Read(' 开头。不依赖路径格式。
  return firstLine?.content.startsWith('● Read(') ?? false;
}

/**
 * 判断 message 是否是 thinking_summary(模型思考摘要)。
 *
 * 真实时序:模型每次工具调用前会 thinking,产生 role=system 的摘要行
 * (如 "Thought for 1s (ctrl+o to expand)")。它是工具调用的伴随状态,
 * 不属于用户内容流,因此不应阻止同批 Read 聚合。
 *
 * 判定:role=system 且首行 content 含 "Thought for"。
 * (与 formatThinkingSummary 输出一致,不依赖精确格式)
 */
function isThinkingSummary(msg: TuiMessage): boolean {
  if (msg.role !== 'system') return false;
  const firstLine = msg.lines[0];
  return firstLine?.content.includes('Thought for') ?? false;
}

/**
 * 把 finalized messages 分组为显示条目。
 *
 * 连续的 read_file message 合并成 read-group;其余原样保留为 message。
 * 纯函数,无副作用,不改输入。
 *
 * 聚合规则(适配真实 Agent runtime 时序 thinking→tool→thinking→tool):
 *   - 连续 Read 段允许中间夹 thinking_summary(不打断聚合)
 *   - thinking_summary 保留为独立 message item(不合并进 group,不丢弃)
 *   - 段被非 Read、非 thinking_summary 的 message 打断(如 Bash/assistant/user)
 *   - 仅段内 Read ≥2 才聚合成 read-group;单个 Read 保持原样
 *
 * 输出顺序:read-group 放段首位置,段内被跨越的 thinking_summary 紧随其后
 * (保持相对顺序,不丢失 thinking 信息)。
 */
export function groupConsecutiveReadMessages(messages: TuiMessage[]): DisplayItem[] {
  const result: DisplayItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (!isReadToolMessage(msg)) {
      // 非 Read:原样保留,前进 1(thinking_summary 也走这里,独立输出)
      result.push({ kind: 'message', msg });
      i++;
      continue;
    }
    // Read:收集连续段(允许中间夹 thinking_summary,它们不进 group 但属本段)
    const group: TuiMessage[] = [msg];
    const interspersedThoughts: TuiMessage[] = [];
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j]!;
      if (isReadToolMessage(next)) {
        group.push(next);
        j++;
      } else if (isThinkingSummary(next)) {
        // thinking_summary 不打断段,但不并入 group(保留独立显示)
        interspersedThoughts.push(next);
        j++;
      } else {
        // 其他 message(Bash/assistant/user/system非thinking)打断段
        break;
      }
    }
    // ≥2 个 Read 才聚合;单个 Read 保持原样(验收:单个 Read 行为不变)
    if (group.length >= 2) {
      result.push({ kind: 'read-group', msgs: group });
    } else {
      result.push({ kind: 'message', msg: group[0]! });
    }
    // 段内被跨越的 thinking_summary 紧随 group 输出(保留信息,不移动到段外)
    for (const t of interspersedThoughts) {
      result.push({ kind: 'message', msg: t });
    }
    i = j;
  }
  return result;
}

