# Message Presentation v1 — Design Spec

- 日期：2026-08-12
- 分支：`feat/message-presentation-v1`
- 基线：`master@6991718`
- 阶段：brainstorming「Write design doc」产物，仅设计，不含 implementation plan
- 状态：等待用户审核（User Review Gate）

## 0. 背景与问题

当前 TUI（`inline-v2`，唯一活跃渲染路径，`src/tui/bootstrap.tsx:131-136`）消息呈现存在信息密度与层级问题，根因是**系统没有「信息层」概念**：`TranscriptBlock`（`src/tui/transcript-types.ts:110-117`）是扁平联合，hook 通知、thinking 摘要、工具摘要、outcome 模板与 user/assistant 对话本体同级，全部经 `selectCommittedTranscript`（`src/tui/state/transcript-reducer.ts:327`）无差别铺平进同一个 `<Static>` 区域。

实测症状：

```text
❯ 启动子代理调查项目
  Thought for 0s                                  ← thinking_end 无阈值（block-pipeline.ts:185-215）
● 我来启动子代理调查项目……
● Ran 1 operation                                 ← generic 机器措辞
  ⎿ No memories recorded yet.
[Hook] memory_list done                           ← 成功 hook 进主轴（hooks/builtins.ts:32-35）
● Ran 1 operation
  ⎿ spawn_agent → cancelled                       ← raw 工具名（block-pipeline.ts:141-147）
● Current status: Partially completed             ← 四字段固定模板（turn-final-feedback.ts:240-257）
  Result obtained: Some tool results were obtained
  Failure or blocked at: Some steps were not completed
  Next step: Retry the failed step or provide missing information
```

本 spec 把现有 `TranscriptModel + transcript-reducer + MessagesStore` 扶正为 UI Presentation Model，在 renderer 之前引入「channel 分类 + normal 可见性边界」，并修正上述五类噪音。

## 1. 核心架构

**单状态源演进。不新建第二套并行 PresentationModel store。** 现有 `TranscriptModel` + `transcript-reducer`（`src/tui/state/transcript-reducer.ts`）+ `MessagesStore`（`src/tui/state/messages-store.ts`）即被扶正为 UI Presentation Model。`BlockPipeline`（`src/ui/block-pipeline.ts`）与 `pipeline-adapter`（`src/tui/state/pipeline-adapter.ts`）v1 保留。

```text
Agent / Session History（Message[]，sessionStore）   ← 模型上下文 + 持久化（权威）
        │  domain events（StreamEventBus + hook + classifyTurn）
        ▼
  BlockPipeline（v1 保留：配对 / thinking buffer / expandable）
        │  Block（src/ui/types.ts:71-79，v1 保留 + 极小新增）
        ▼
  pipeline-adapter（v1 保留 + 极小新增方法）
        │  语义 action
        ▼
  transcript-reducer（扶正为 Presentation Reducer）
        │  TranscriptModel { items: TimelineItem[] }
        ▼
  presentationChannel() + normalMode 过滤选择器（本设计新增的「层」）
        │  PresentationItem（带 channel）
        ▼
  InlineAppV2 / TranscriptBlockLine（Ink）
```

**铁律：**

```text
模型需要保存什么  ≠  用户界面应该展示什么
```

例：raw `tool_result` 可进入模型/session history（`src/index.ts:1131` 落盘进 `Message[]`），但 UI 中投影为 Tool/Agent **Activity**，不属于 Conversation。持久化决策（`sessionStore.append`）与 channel 决策相互独立。

## 2. Channel

定义三类：

```ts
type PresentationChannel = 'conversation' | 'activity' | 'diagnostics';
```

**优先使用派生分类函数，不给每个 block 冗余存储 channel 字段**（项目已有 `isTranscriptBlock` / `selectCommittedTranscript` 派生选择器先例，见 `transcript-types.ts:168-176` 与 `transcript-reducer.ts:327`）。仅当写实现时发现明确无法派生的反证，才退化为存储字段。

```ts
function presentationChannel(b: TranscriptBlock): PresentationChannel {
  switch (b.kind) {
    case 'user':
    case 'assistant':                       return 'conversation';
    case 'tool':
    case 'agent':                           // 新增
    case 'ask':
    case 'turn-duration':
    case 'turn-status':                     // 新增（仅非 success）
                                            return 'activity';
    case 'system':
      // thinking-summary → activity
      // notification：tone='error' → activity（用户须行动）；否则 → diagnostics
      return b.subkind === 'notification' && b.tone !== 'error'
        ? 'diagnostics'
        : 'activity';
  }
}
```

> `SystemBlock.tone?` 字段已存在（`transcript-types.ts:99`），v1 开始实际赋值以区分 hook success/error。

归类：

| Channel | 含义 | v1 归入 |
|---|---|---|
| **Conversation** | 人机对话本体 | `UserBlock`、substantive `AssistantBlock` |
| **Activity** | Agent 正在/已经做什么 + 用户须行动的异常 | `ToolBlock`、`AgentBlock`、`thinking-summary`（≥1s）、`AskBlock`、`TurnDurationBlock`、`TurnStatusBlock`（fallback）、`PendingTool/PendingAgent/PendingThinking`（running）、`system/notification` tone=error |
| **Diagnostics** | 有内部诊断价值但 normal 用户不应看到的信息 | `system/notification` tone=normal（**v1 实际由源头抑制，见 §3**） |

## 3. Diagnostics 最终裁决

**铁律：raw event ≠ 必须产生 PresentationItem。** Diagnostics 不是所有内部 raw event 的日志仓库。

**routine 成功 hook（无用户价值、也无未来诊断价值）：源头直接抑制，不进入 Presentation Model。**

```text
[Hook] memory_list done
[Hook] read_file done
```

实现：`src/hooks/builtins.ts:32-35` `postToolLogger` 在成功时返回空 `message`，被 `src/index.ts:1075` `if (hookResult.message)` 自然过滤 → 根本不 `pipeline.emit({kind:'hook'})`。**不存入 MessagesStore，不进任何 channel。** 不为未来 debug 功能保留成功 hook 数据。

真正有诊断意义但 normal 不应显示的信息：可进入 Diagnostics channel，由 normalMode 选择器隐藏。**v1 不实现** `/verbose`、`/debug` 命令；**v1 不预定义** 未使用的 verbosity API/enum。只实现当前需要的 normal 可见性边界。

> 自检：本节「成功 hook 源头不 emit」与 §8 一致，不要求「所有成功 hook 留在 store」。Diagnostics channel 类型层保留，但 v1 无实际 item 路由进去（success 抑制、error 走 Activity）。

## 4. Outcome

保留结构化分类器 `classifyTurn()`（`src/agent/turn-final-feedback.ts:118-176`），不删。

**UI 不再有四字段固定模板。** `Current status / Result obtained / Failure or blocked at / Next step`（模板来自 `src/locale/resources/en-US.ts:117-135`，装配见 `turn-final-feedback.ts:240-257`）不再进入 normal transcript。

- `success` → 不生成 TurnStatus（沿用现有短路 `turn-final-feedback.ts:340-348`）。
- `partial` / `failed` / `cancelled` → **TurnStatus 仅作为 fallback**：仅当本回合没有其他可见 abnormal Activity 足以解释结果时，才生成一条 concise `TurnStatusBlock`。

**纯结构化去重判断**（不做 NLP/文本相似度）：

```ts
// 扫描本回合已 commit 的 Activity items 是否已表达异常
function hasVisibleAbnormalActivity(turnItems: readonly TimelineItem[]): boolean {
  return turnItems.some(i =>
    (i.kind === 'tool' && i.presentations.some(p => p.status === 'error' || p.status === 'cancelled'))
    || (i.kind === 'agent' && i.status !== 'completed')   // partial/failed/cancelled/unknown
    || (i.kind === 'system' && i.subkind === 'notification' && i.tone === 'error')
  );
}
```

- `hasVisibleAbnormalActivity === true` → 不追加 TurnStatus（已有 Activity 解释）。
- `=== false` → 追加一条 concise `TurnStatusBlock`（如 `⚠ Partial — {reason}` / `✖ Failed — {error摘要}`（tone=error，红）/ `○ Cancelled`）。

turn 边界：复用 finalize 阶段已有的 `turnStartIndex`（`src/index.ts:1116-1122`）映射到 presentation model items（自最近一个 `UserBlock` 起）。该判断在 turn finalize 时执行，读取 presentation model 当前回合 items，反映用户实际所见。

`turn-final-feedback.ts` 不再以 `assistant_text` emit 四字段（废止 `src/index.ts:1132` 的 `pipeline.emit({kind:'assistant_text', text: feedbackText})` 与 `turn-final-feedback.ts:301-319` 把 feedback 作为 `uiOnly` 文本追加进 `Message[]` 的逻辑）。`classifyTurn` 结果作为回合内瞬态计算保留，仅用于驱动 fallback TurnStatus 决策，不持久化。

废止不变量「每个非后台回合必须有恰好一个用户可见状态块」（`src/index.ts:1109-1111` 注释所述）。

## 5. AgentBlock

v1 将 `spawn_agent` 从普通 `ToolBlock` 升级为一等 Agent Activity。

状态：

```text
running | completed | partial | failed | cancelled | unknown
```

**数据复用现有通道（已核验充分，无阻断）：**

- `tool_call.input`（`description` / `prompt`）→ label。
- `tool_result.output`（envelope）→ outcome / summary，经现有 parser（`src/ui/subagent-presentation.ts:96-115`，**不消除 string→regex 往返**）。
- `tool_result.durationMs` → `durationMs`（cancelled 时缺省）。
- cancelled 路径仍持有 input：`src/ui/block-pipeline.ts:140` 的 `item` 含 `input`（`:235-239` 存入），仅 `:143` 当前未用 → v1 改为从中推导 label。

**已确认：不需要新事件、不需要 child progress、不需要修改 `SubagentOptions`、不需要消除 string 往返。**

类型（新增进 `src/tui/transcript-types.ts`，**保持最小**）：

```ts
export interface AgentBlock {            // TranscriptBlock 联合新增分支
  id: string;
  kind: 'agent';
  label: string;                         // input.description → prompt 有意义首行 → "Agent"
  status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'unknown';
  summary?: string;                      // envelope body / report.summary
  durationMs?: number;                   // cancelled 时缺省
}
export interface PendingAgent {          // ActivityItem 联合新增分支
  id: string;
  kind: 'pending-agent';
  label: string;
}
```

**不预埋 `details` / `expandableId`**：经核验，现有 reducer/renderer 接口对 AgentBlock 无不可避免的可展开要求（单行渲染即可）。`pending-agent`/`agent` 不进入 `ToolPresentation.details` 通道。

> 已知 v1 取舍：AgentBlock 完整输出在 v1 不支持 Ctrl+O 内联展开（当前 spawn_agent 的可展开注册在 `block-pipeline.ts:300-314`，依赖 `ToolPresentation.details`）。这属于「per-block expand/collapse 新 UI」与「`details` 全面激活」，均明确 out of scope（§14）。完整子代理输出仍无损保留在 `SubagentJournal` JSONL（`src/agent/subagent-journal.ts`）。

running 展示（无 child progress）：`PendingAgent` 渲染为 `● Agent "{label}" …`（闪烁 ●，无 child 细节）。child 内部事件继续留在私有 eventBus（`src/agent/subagent.ts:421`），不冒泡。

## 6. Tool Activity

首版只解决**确定性**的 generic machine wording。语义必须由确定的 tool name + input + structured output 得到。

**禁止**通过 Bash 命令文本 regex 猜测「这是测试 / build / lint」。如无可靠结构化证据，保留现有 Bash concise presentation（首行摘要，`src/ui/tool-presentation.ts:325-350`）。

v1 覆盖（改 `src/ui/tool-presentation.ts:95-125` `buildToolPresentation` 的 default 分支，新增最小 case）：

| 工具 | 现 generic | v1 语义（确定性来源） |
|---|---|---|
| `memory_list` / `memory_*` | `Ran 1 operation` | `Checked memory`（来自 tool name） |
| `read_file`（input.path === `"."` 或目录） | `Read 1 item` | `Read project structure`（来自 input.path） |
| `read_file`（文件） | `Read 1 item` | `Read {basename}`（来自 input.path） |
| `grep` / `glob` | `Searched N patterns` / `N files` | 已语义，保留 |
| `spawn_agent` | `Ran 1 operation` | 转 `AgentBlock`（§5） |
| `bash` | `Ran 1 operation` | 保留现状首行摘要（不猜命令语义） |

优先复用：现有 `ToolPresentation`、`glob/grep/read_file` 分组（`transcript-reducer.ts:66-70`）、`toolBuffer` 配对（`block-pipeline.ts:122`）。**不建设** per-tool renderer 大全、renderer DSL、插件渲染。

## 7. Thinking

**统一一个规则、一个阈值、一个 helper：**

```ts
const THINKING_COMMIT_THRESHOLD_MS = 1000;
function shouldCommitThinking(durationMs: number): boolean {
  return durationMs >= THINKING_COMMIT_THRESHOLD_MS;
}
```

要求：

- running thinking 始终可 transient 显示（`PendingThinking`，不受阈值影响）。
- completed thinking `<1s` 不进入 committed transcript。
- `>=1s` 才生成 `Thought for Ns`。

**关键：不在早期单个 raw `thinking_end` 阶段施加门控或丢弃 duration。** duration 必须能流入后续聚合。当前架构已支持：`finishThinking`（`messages-store.ts:250-260`）→ `deferThinking`（`transcript-reducer.ts:137-145`）把带 `durationMs` 的 `ThinkingSummaryBlock` 挂入 `deferredThinking` 队列，**不立即 commit**。

**统一阈值在「最终形成用户可见 thinking summary」的 commit boundary 实施**（两处共享同一常量/helper）：

1. **grouped（聚合进 tool group）**：deferred 在 `startTool` 路径 1/2（`transcript-reducer.ts:197,216`）挂到 `ToolBlock.thinking[]` 的 `ThinkingGroupMetadata`，由 `summarizeThinking`（`transcript-reducer.ts:366-384`）在 render 时按**聚合后总 duration** 门控。迁移：把现有「单条 `<2000ms` 返回 null、多条恒显示」改为「聚合总 duration `<THINKING_COMMIT_THRESHOLD_MS` 返回 null，否则显示」，统一用 `shouldCommitThinking`。

2. **standalone（独立 flush）**：deferred 在 `startTool` 路径 3（`transcript-reducer.ts:232` `...deferred`）与 `flushDeferredThinking`（`:148-156`）作为独立 `system/thinking-summary` flush 时，按**该 summary 自身 durationMs** 门控：`deferred.filter(s => shouldCommitThinking(s.durationMs))`，过滤掉的不 commit。

> 自检：全项目只有一个用户可见阈值 `1000ms`、一个 helper。grouped 与 standalone 的差异仅是「聚合 vs 单条」的固有形状差异，不是两套阈值。`block-pipeline.ts:185-215` 的 `thinking_end` 不再加任何门控（修正此前 round-2 草案在此处加门控的错误——那会过早丢弃可聚合的 duration）。

`turn-lifecycle.ts:52-60`（measurement）与 `*-stream-client.ts`（streaming/model 层）不动。

## 8. Hook

normal 模式：

- **routine successful hook → 完全不产生 presentation**（`postToolLogger` 成功返回空 message，源头抑制，见 §3）。
- **actionable warning/error → Activity/Error**（`system/notification` tone=error，可见）。
- **有诊断价值但用户无需知道 → Diagnostics（hidden）**。

**不**为了未来 debug 功能把所有成功 hook 存入 MessagesStore。v1 不新增 `/verbose`、`/debug`。

> 自检：成功 hook 源头抑制（§3）与「不存入 store」（本节）一致，无矛盾。

## 9. Assistant narration

**v1 不做 NLP/text similarity 去重。** Renderer 无权根据文本相似度判断「我先读取项目」是否应隐藏。该问题留待 model/system prompt 行为约束。

Assistant substantive text **永远完整保留**（验收标准 §13.10）。Presentation 层只保证 Activity 自身紧凑、不重复内部事件（如 TurnStatus 不重复已由 Tool/Agent Activity 表达的异常，§4）。

## 10. Overlay 边界

以下继续保持独立 store / overlay，**不进入 Presentation Model**：

- `permission`（`permission/` + decision channel）
- `plan approval`（`planStore` + `exit_plan_mode`）
- `ask question`（`askQuestionStore`，`src/agent/ask-user-manager.ts`）
- modal / progress overlay（`spinnerStore` / `statusStore`，`src/index.ts:889,1013-1030`）

**边界原因**（不重构）：

- 它们是**模态/交互态**（阻塞输入、要求用户决策或表示瞬时进度），不是「已发生事件的历史记录」。
- 生命周期与 transcript 正交：一个 ask question 覆盖当前回合，完成后消失，不进 `<Static>` 滚屏。
- 它们直接驱动输入焦点 / 光标 / 模态层，这是 control 语义，不是 presentation 语义。

## 11. BlockPipeline / adapter / reducer 迁移边界

v1：`BlockPipeline` 保留、`pipeline-adapter` 保留、raw `Block` 类型（`src/ui/types.ts:71-79`）保留。只迁移实现当前 presentation semantics 所必要的职责。

| 层 | v1 保留 | v1 迁移/新增 |
|---|---|---|
| `BlockPipeline` | tool_call/result 配对（`toolBuffer`）、thinking buffer、expandable 注册 | ① `name === 'spawn_agent'` 路由到 `renderer.startAgent/finishAgent/cancelAgent`（label 从 `input` 现场推导）；② `cancelPendingTools`（`block-pipeline.ts:136-152`）spawn_agent 分支用 `item.input` 推 label；③ `thinking_end` **不加门控**（门控在 reducer commit boundary） |
| `pipeline-adapter` | 全部现有 tool/thinking/assistant 方法 | 新增 `startAgent/finishAgent/cancelAgent` → store action |
| `transcript-reducer` | `startTool/resolveTool/closeOpenToolGroup/appendBoundary` | ① 新增 `startAgent/resolveAgent/cancelAgent`（agent 永不分组，单条目）；② 新增 `presentationChannel()` + normalMode 过滤选择器；③ 新增 `hasVisibleAbnormalActivity()`；④ thinking 阈值统一（§7） |

raw `Block` 新增极小：`{kind:'turn_status'; status; line}`（用于 §4 的 fallback TurnStatus 投递）。`spawn_agent` 仍走现有 `tool_call`/`tool_result` Block kind（不新增 raw event）。

**本 spec 不设计删除三层的完整重构。** Plan C（删除 `Block`/`pipeline-adapter` 冗余翻译层，让 reducer 直接消费 domain event）仅作为 future direction 记录：待 v1 落地、有充分测试保护后，再评估是否在根上消除「raw event 1:1 镜像」债务。

## 12. Before / After walkthrough

案例：`启动子代理调查项目 → memory_list → read_file → spawn_agent(cancelled) → classifyTurn(partial)`

逐事件（domain event → presentation reducer → normal UI）：

| # | domain event | reducer 得到 | channel | normal UI |
|---|---|---|---|---|
| 1 | user input | `UserBlock` | conv | `❯ 启动子代理调查项目` |
| 2 | assistant text | `AssistantBlock` | conv | `● 我来启动子代理调查项目……` |
| 3a | thinking start (0.3s) | `PendingThinking`（transient） | activity | `● Thinking…`（running） |
| 3b | thinking end (<1s) | standalone commit boundary 门控：不 commit | — | （擦除，无残留） |
| 4 | memory_list call+result | `ToolBlock`（语义） | activity | `● Checked memory` / `⎿ No saved memories` |
| 5 | read_file "." call+result | `ToolBlock`（语义） | activity | `● Read project structure` |
| 6 | hook memory_list/read_file (success) | **源头抑制，不 emit** | — | （隐藏） |
| 7 | assistant text | `AssistantBlock` | conv | `● 现在启动多个子代理并行调查项目不同方面：` |
| 8a | spawn_agent call | `PendingAgent`（label="调查项目"） | activity | `● Agent "调查项目" …`（running） |
| 8b | user_abort → cancelAgent | `AgentBlock`(cancelled, label←input) | activity | `● Agent "调查项目" cancelled` |
| 9 | turn finalize: classifyTurn=partial | `hasVisibleAbnormalActivity` = true（AgentBlock cancelled）→ **不追加 TurnStatus** | — | （无四字段、无重复 Partial 行） |

目标 normal UI（接近）：

```text
❯ 启动子代理调查项目

● 我来启动子代理调查项目。首先检查已有的记忆和项目结构。

● Checked memory
  ⎿ No saved memories

● Read project structure

● 现在启动多个子代理并行调查项目不同方面：

● Agent "调查项目" cancelled
```

重点：无 `Thought for 0s`、无 `[Hook] ... done`、无 `Ran 1 operation`、无 raw `spawn_agent → cancelled`、无重复 `Partial — 1 agent cancelled`（因已有 AgentBlock cancelled）、无四字段模板、assistant narration 完整保留。

## 13. 验收标准

1. completed thinking `<1s` 不产生 `Thought for 0s`。
2. `>=1s` thinking 正常显示 `Thought for Ns`。
3. successful routine hook 不进入 normal transcript（源头抑制）。
4. hook / 用户须行动的 error 仍可见（Activity，tone=error）。
5. partial / cancelled / failed 不显示四字段模板。
6. 已有 abnormal Tool/Agent Activity 时不追加重复 TurnStatus（`hasVisibleAbnormalActivity` 结构化判断）。
7. `spawn_agent` running/completed/failed/cancelled 使用 Agent Activity（`AgentBlock`/`PendingAgent`）。
8. cancelled agent 不显示 raw `spawn_agent → cancelled`；显示 `Agent "{label}" cancelled`。
9. memory / read / search 使用确定性语义 presentation（不出现 `Ran N operation`）。
10. assistant substantive text 完整保留（无 NLP 去重）。
11. permission / plan / ask overlay 行为不改变（独立 store 未动）。
12. model/session history 中 `tool_result` 等数据行为不改变（持久化与 channel 解耦）。

## 14. v1 明确不做

- Web / GUI；renderer DSL / plugin renderer；theme / 动画。
- child subagent live progress；token / tool 实时子代理状态；`SubagentOptions.onProgress`。
- 消除 `SubagentExecutionResult → string → regex` 技术债。
- per-block expand / collapse 新 UI（含 AgentBlock Ctrl+O 内联展开，见 §5 已知取舍）。
- `ToolPresentation.details` 全面激活。
- `/verbose`、`/debug` 命令；verbosity 枚举预埋。
- assistant NLP / 文本相似度去重。
- 删除 `Block` / `pipeline-adapter`（Plan C，仅 future direction 一句话记录，§11）。
- overlay 收编进 presentation reducer（§10）。
- legacy / dead code 清理（如休眠的 `streaming-markdown.tsx` / alt-screen 路径 / legacy `messages[]` 投影债）。
- 无关 TUI 重写。

## 15. 名词定义（消除歧义）

四者正交，不可混为一谈：

| 概念 | 定义 | 本项目落点 |
|---|---|---|
| **raw event** | 从 model stream / hook / lifecycle 产生的原始事件（未加工） | `StreamEvent`（`src/agent/types.ts:229-235`）、`HookResult`（`src/hooks/types.ts`）、`classifyTurn` 信号 |
| **history message** | 进入模型上下文 + session 持久化的消息 | agent `Message[]`（`src/agent/types.ts:1-40`），`sessionStore.append`（`src/session/store.ts:319-347`，调用点 `src/index.ts:1131`） |
| **PresentationItem** | presentation reducer 产出的、带 channel 的用户可见语义块 | `TimelineItem`（`src/tui/transcript-types.ts:155`）+ 派生 `presentationChannel()` |
| **terminal committed block** | 已被 Ink `<Static>` 物理写入终端滚屏的块（inline 模式不可逆） | `InlineAppV2` 的 `staticItems`（`src/tui/inline-v2/InlineAppV2.tsx:213-237`） |

channel 过滤发生在 **PresentationItem → terminal committed block** 之间：被 normalMode 过滤的 item 不进 `<Static>`，故不进滚屏。raw event 与 history message 的关系由 §1 铁律约束（可重合可不重合，互不蕴含）。

## 16. 迁移策略（提示，非 implementation plan）

小步、每步带测试，保持 streaming hot path 行为：

1. 纯函数先行（零行为变更）：`presentationChannel()`、`shouldCommitThinking()`、`hasVisibleAbnormalActivity()` + 单元测试。
2. 接入 normalMode 过滤（diagnostics 隐藏）。
3. thinking 阈值统一（§7）。
4. outcome fallback（§4）。
5. AgentBlock（类型 + reducer/adapter action + block-pipeline 路由 + cancel label + `AgentBlockLine` render）。
6. Tool 语义最小 case（§6）。

每步独立可测、可回滚；不顺手删 `Block`/`pipeline-adapter`；不处理无关 legacy/dead code。
