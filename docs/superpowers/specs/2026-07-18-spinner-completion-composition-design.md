# Spinner 完成消息与组件依赖对齐设计

## 目标

完成 AUTO-0021 与 AUTO-0022：

- Spinner 停止后生成独立的 `SystemTurnDurationMessage`，以暗灰色 `✻ <verb> for <duration>` 进入普通消息列表和滚动区域。
- 建立 `SpinnerWithVerb` 的 normal/brief 展示分支，并接入动画主行、Teammate、TaskListV2、Tip、Budget 与 NextTask。
- Ink 与 inline 使用同一份状态、决策规则和行数计算，渲染后端只负责各自的颜色与终端输出。

本设计整合并取代 [Spinner Tip 显示设计](./2026-07-18-spinner-tip-design.md) 中单独 setter 的接口方案，但保留其 Tip 阈值、优先级和样式规则。

## 范围与非目标

本任务实现完成消息、normal/brief 入口、共享视图模型、现有 Teammate/Todo 快照、Tip、可注入 Budget/NextTask、动态多行布局和测试。

不在本任务中：

- 不实现 `/btw` 命令或使用记录持久化。
- 不虚构 Teammate 父子关系、teammate token 生产者、费用统计或任务调度器。
- 不把 `contextPct` 当作 Budget。
- 不把 `TaskBoard` 当作 `TaskListV2`。
- 不增加 manager 轮询，不复制 Claude Code 专属 provider/context hooks。
- 不把 normal/brief 与 inline/alt-screen、verbose 或终端宽度绑定。
- 不顺手重构无关 TUI、状态栏或测试代码。

## 方案选择

采用“共享 `SpinnerView` + 两个薄渲染器”：

```text
index.ts
  ├─ TeammateManager / TodoManager / 外部补充数据
  └─ bootstrap.setSpinnerContext(snapshot)
                    ↓
              Spinner Store
                    ↓
          selectSpinnerView()
           ├─ brief：仅动画主行
           └─ normal：动画主行 + 辅助行
                    ↓
        ┌───────────┴───────────┐
        Ink                 inline
 SpinnerWithVerb       buildSpinnerLines()
```

不采用两套完整组件树，因为会重复 normal/brief、Tip、活动区和行数规则；也不继续直接堆叠在 `Spinner.tsx` 与 `InlineApp.tsx`，因为当前单行契约无法可靠支持动态辅助行。

## 共享数据契约

### Spinner 上下文

```ts
type SpinnerVariant = 'normal' | 'brief';

interface SpinnerTeammate {
  name: string;
  role: string;
  status: 'idle' | 'working' | 'shutdown';
}

interface SpinnerTask {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner: string | null;
  activeForm: string | null;
  blockedBy: readonly string[];
}

interface SpinnerContextSnapshot {
  variant: SpinnerVariant;
  teammates: readonly SpinnerTeammate[];
  tasks: readonly SpinnerTask[];
  spinnerTip: string | null;
  hasUsedBtw: boolean;
  budgetText: string | null;
  nextTaskText: string | null;
}
```

Store 通过一个原子 `setContext(snapshot)` 更新完整快照。数组在写入时复制；可选文本先 `trim()`，空白规范化为 `null`。默认值为 normal、空数组、`hasUsedBtw=false` 和空可选文本。

Bootstrap 支持初始化上下文和运行时 `setSpinnerContext(snapshot)`。`index.ts` 在 turn 开始及工具结果返回后，从 `TeammateManager.list()` 和 `TodoManager.getItems()` 生成新快照；不新增轮询。Budget 与 NextTask 只接受调用方明确提供的完整显示文本，没有权威值时保持 `null`。

### 共享 SpinnerView

纯函数 `selectSpinnerView(state)` 是 normal/brief、活动区、Tip、辅助行顺序和 `rowCount` 的唯一规则来源。它输出动画主行所需状态及已经排序的辅助行视图。

活动区规则：

1. 过滤 `shutdown` teammate；仍有成员时显示一级 `TeammateSpinnerTree`。
2. 否则过滤 completed task；仍有任务时显示 `TaskListV2`。
3. 两者均为空时不显示活动区。

项目没有 Teammate 父子信息，因此“Tree”只表示根下一级成员列表，不推断更多层级。TaskListV2 复用现有 `[>]` 与 `[ ]` 状态标记，completed 项不常驻 Spinner footer。

## 组件与渲染

概念组件树：

```text
SpinnerWithVerb
├─ brief
│  └─ BriefSpinner
│     └─ SpinnerAnimationRow
└─ normal
   └─ SpinnerWithVerbInner
      ├─ SpinnerAnimationRow
      ├─ TeammateSpinnerTree | TaskListV2
      ├─ Tip
      ├─ Budget
      └─ NextTask
```

这些边界可以集中在少量文件中，不要求每个名称单独建文件。

### normal / brief

| 内容 | normal | brief |
|---|---:|---:|
| SpinnerAnimationRow | 显示 | 显示 |
| 计时与 token | 沿用现有条件 | 沿用现有条件 |
| Teammate / TaskListV2 | 有数据时显示 | 隐藏 |
| Tip | 有决策结果时显示 | 隐藏 |
| Budget | 非空时显示 | 隐藏 |
| NextTask | 非空时显示 | 隐藏 |

Spinner inactive 时整个 Spinner 区域为零行。normal 辅助行固定按“活动区、Tip、Budget、NextTask”排序；空内容不占行。Teammate、Task、Tip、Budget 与 NextTask 使用主题暗灰色，不参与 shimmer、stalled 或 thinking 动画。

### Ink

当前 `Spinner` 的单行动画内容抽为 `SpinnerAnimationRow`。`SpinnerWithVerb` 读取共享 `SpinnerView`，brief 只渲染主行，normal 在纵向 Box 中追加辅助行。

`App` 与 `ConnectedApp` 不再用 `(spinnerActive ? 1 : 0)` 估算 Footer 高度，而读取共享的 `spinnerRowCount`。ScrollBox 可见高度和输入框全局行坐标使用同一个值。

### inline

`InlineApp` 删除内部重复的 spinner 行构建逻辑，调用独立 `buildSpinnerLines(view)`。`FooterInput.spinnerLine` 改为 `spinnerLines`。

Footer 行序为：

```text
间隔空行
SpinnerAnimationRow
可选辅助行...
输入框上边框
```

`reserveRows = 1 + spinnerLines.length`，并作为 footer 高度、`cursorToTop` 和光标物理行计算的共同来源。无 Spinner 时只保留现有单个间隔空行。inline 辅助行按可用终端宽度安全截断。

### 动画时钟

`ConnectedApp` 作为两个渲染模式的共同父级，唯一负责 active 期间的 `TICK_MS` interval。Store 继续保存并派生 `time`、暂停时长、thinking、stalled 与 token 动画；Ink 和 inline 渲染器只读 Store，不再各自创建 Spinner interval。

本任务不把现有 `Date.now()` 迁移到 `performance.now()`，避免扩大 AUTO-0022 范围。

## Tip 规则

Store 从统一有效时钟派生：

```ts
elapsedSnapshot = Math.floor(time / 1000) * 1000;
```

共享纯函数按以下优先级返回字符串或 `null`：

1. `elapsedSnapshot >= 1_800_000`：`Use /clear to start fresh when switching topics...`
2. `elapsedSnapshot >= 30_000 && !hasUsedBtw`：`Tip: Use /btw to ask a quick side question...`
3. 其他情况返回规范化后的 `spinnerTip`
4. 无可用文本时返回 `null`

暂停期间快照冻结；brief 模式即使规则返回文本也不渲染 Tip。

## 完成消息模型

### 数据类型与创建

`SystemTurnDurationMessage` 是 `TuiMessage` 的结构化子类型：

```ts
interface SystemTurnDurationMessage extends TuiMessage {
  kind: 'turn-duration';
  verb: TurnCompletionVerb;
  durationMs: number;
}
```

普通 `TuiMessage` 增加可选 `kind`，避免要求所有现有消息创建点同步增加无业务价值的判别字段。

`createTurnDurationMessage()` 接收 uuid、有效时长和是否需要前导空行；创建时抽取一次 `TURN_COMPLETION_VERBS`，并固化 verb、duration 与 lines。随机源允许作为可选参数注入测试，但生产默认使用 `Math.random`。

`TurnDurationMessage` 在本项目中是共享纯行渲染器，而不是 Ink 专用 React 组件。它生成：

```ts
{
  content: `✻ ${verb} for ${formatSpinnerDuration(durationMs)}`,
  style: { dim: true },
  indent: 0,
}
```

这使 Ink 与 inline 都继续复用 `FormattedLine` 的既有样式映射。

### 入队与生命周期

`messagesStore.appendTurnDurationMessage(durationMs)`：

1. 检查当前最后一个可渲染行是否非空，决定专用消息是否包含一个前导空行。
2. 分配新 uuid 并调用 `createTurnDurationMessage()`。
3. 始终把结果作为独立消息追加，禁止通过 `appendLine('system')` 与 Thinking 或其他 system 消息合并。

完成数据流：

```text
agent loop finally
  → 若 thinking 仍活跃，先固化 Thinking 摘要
  → spinnerStore.stop() : { durationMs } | null
  → messagesStore.appendTurnDurationMessage(durationMs)
  → messages[]
  → Ink ScrollBox / inline scrollback
```

`spinnerStore.stop()` 保持幂等：只有 active 时返回有效时长，重复调用返回 `null`。完成动词从 Store 移到消息工厂抽取。`eventBus.onLoopEnd` 不再提前停止 Spinner，停止与完成消息集中到 `finally`，从而保证 Thinking 摘要在完成消息之前。

Ink 通过 `flattenMessages` 将专用消息作为普通固化行加入虚拟滚动；inline 通过现有 finalized message 账本把它追加到主屏 scrollback。两条路径不增加专用样式分支。

## 防御边界

- 重复 stop 不得生成第二条完成消息。
- 已有空行时不得再增加重复前导空行。
- random 只在创建消息时执行一次，重渲染不得改变动词。
- inactive、brief 或空辅助数据不得占用幽灵行。
- `spinnerRowCount` 必须是 Footer 高度、ScrollBox 高度和光标坐标的共同来源。
- overlay/select 替换主布局时沿用现有行为，不额外显示 Spinner 辅助行。
- manager 快照失败或缺少权威 Budget/NextTask 时隐藏对应区域，不生成占位文本。

## TDD 与验证

按 RED → GREEN → REFACTOR 分阶段：

1. 完成消息纯函数：固定符号、完成动词、时长格式、dim、随机只执行一次。
2. Messages Store：独立消息、单个前导空行、重复 stop、Thinking 顺序。
3. SpinnerView：normal/brief、Teammate 优先、Task fallback、Tip 边界、辅助行顺序和 rowCount。
4. Spinner Store：上下文原子快照、整秒 elapsedSnapshot、暂停冻结和 start/stop 生命周期。
5. Ink：动画主行拆分、normal 辅助行、brief 隐藏和暗灰样式。
6. inline：`spinnerLines` 行序、动态 Footer 高度、`cursorToTop`、卸载擦除和终端宽度。
7. 集成：Thinking 摘要 → 空行 → 完成消息，完成消息进入滚动/scrollback，正文 finalize 后不闪回 Spinner。

基线分析发现 12 个 Footer 测试仍假定“无 Spinner 固定预留两行”，而当前实现已经采用“有 Spinner 两行、无 Spinner 一行”。本任务在观察失败并确认原因后，按本设计的动态 `spinnerLines` 契约更新这些直接相关测试并保留为回归保护。两个与状态栏 ANSI 文本匹配有关的既有失败不纳入功能修改，除非最终验证证明本次改动直接影响它们。

完成前运行：

- L1：新增或修改的单个测试文件。
- L2：Spinner、Messages Store、Ink/inline Footer 与滚动相关测试。
- L3：`npm test`、`npm run typecheck`、`npm run lint`。

所有完成声明必须附带新鲜命令输出；若全量验证仍包含确认过的既有无关失败，需明确报告，不能表述为全绿。
