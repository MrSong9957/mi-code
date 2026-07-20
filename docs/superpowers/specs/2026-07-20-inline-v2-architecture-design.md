# Inline V2 架构改造设计文档

> **日期**:2026-07-20
> **作者**:assistant + Claude Code 协同评审
> **状态**:待 writing-plans 转实现计划
> **关联**:
> - `docs/流式输出无限循环问题.md`(原始问题诊断)
> - `docs/流式输出无限循环问题-CC讨论记录.md`(完整调研 + 5 轮 review 记录)
> - `scripts/ink-poc/poc-inline-diff.tsx`(POC 验证脚本)

---

## 1. 问题与目标

### 1.1 问题

inline 模式流式输出累积重复帧。根因是 `InlineRenderer` 手动 diff/快照比较无法处理 spinner 每 50ms 变化与流式正文 250ms 节流之间的耦合。

当前 `prevFrameSnapshot` 修复(`src/tui/inline/InlineRenderer.ts:294-313`)对流式场景**无效**,有两个致命点:

1. **`frame.streamingLines === null` 永不成立**:流式期间 `streamingLines` 总是 `string[]`,短路第一个条件就 false
2. **spinner 行进 `footer.lines` 后,逐元素比较总因 spinner 字符变化失败**:`layout.ts:199` 把 `visibleSpinnerLines` 插到 footer.lines 头部,而 spinner 字符在 50ms 尺度上持续变(glyph 每 120ms 切、shimmer 每 200ms 扫、token 每 tick +3~50、thinking 颜色正弦呼吸)

测试 `inline-renderer-footer-dedup.test.ts` 5 个用例全部用 `streamingLines: null` 测的,**没有覆盖流式场景**——所以测试是绿的,但 bug 没被治住。

### 1.2 目标

**主目标**:消除流式期间的重复帧累积。spinner tick 不应触发未变区域(footer border / statusbar / 正文草稿)的重写。

**架构目标**:让 inline 模式复用 stock Ink 的渲染管线(`<Static>` + `createIncremental`),消除 `InlineRenderer` 重复造的轮子。

**非目标**:
- 不改 alt-screen 模式(它已经工作正常)
- 不引入 Claude Code 的 forked Ink(stock Ink 7.1.0 能力足够,POC 已证实)

### 1.3 成功标准

- 流式期间 spinner tick → stdout 只写 spinner 行(44-46B),不重写 footer/statusbar(对比当前每帧 412B+)。基线数据来自 POC
- 已固化消息通过 `<Static>` 真实进 stdout scrollback
- alt-screen 模式行为 100% 不变(回归测试全绿)
- `MICODE_INLINE_V2=0` 可随时回滚到旧路径

---

## 2. 方案概述

### 2.1 核心改动(5 项)

1. **修改 Ink patch 接通方式**:让 inline V2 模式不注入 `options.renderer`,直接走 Ink 原生 `renderInteractiveFrame` + 开启 `incrementalRendering: true`
2. **加 `MICODE_INLINE_V2` flag**:`bootstrap.tsx` 按 flag 决定走 V0(`InlineRenderer`)或 V2(Ink reconciler)
3. **改造 `<App>`**:按 `isInline && flag` 分支——inline V2 用 `<Static items={finalized}>` + 活动区(`<Spinner>` + `<StreamingText>` + `<Footer>`);alt-screen 保留 `<ScrollBox>` + `<Footer>`
4. **给组件加 `memo` + 稳定 props**:`<Footer>` / `<Spinner>` / `<StatusBar>` / `<SuggestionBar>` / `<SelectionText>` 加 memo;父组件用 `useShallow` / `useMemo` 保证 props 引用稳定
5. **messagesStore 消费方式调整**:已固化(`finalized=true`)消息进 `<Static>`;末条流式消息留在活动区。固化时机已原子化(代码核查证实,无需改 store 实现)

### 2.2 不改

- `messagesStore` 数据结构本身(`finalizeStreaming` 已是原子,只加防回归测试)
- alt-screen 模式任何代码
- `spinnerStore` / `inputStore` / `statusStore` 等数据层
- BlockPipeline / PipelineToStoreAdapter
- `patches/ink+7.1.0.patch`(现有 patch 已支持 `options.renderer` 注入,V2 只是**不注入**)

### 2.3 保留(过渡期)

- `InlineRenderer` 完整代码作为 V0 fallback
- `useThrottledStreamingText`(过渡期保留,实测后再决定是否永久保留——Ink 默认 33ms throttle 在快速流式场景可能仍有打印机感)
- POC 脚本 `scripts/ink-poc/poc-inline-diff.tsx`(扩展为可重复回归测试)

---

## 3. 架构变更

### 3.1 组件树对比

**当前架构(inline 模式)**:
```
<ConnectedApp>
  └─ <InlineApp>                          ← 返回 <></>,所有渲染是副作用
       └─ useEffect(() => {
            buildSpinnerLines(...)
            layoutFooter(...)
            renderer.commit(frame)         ← 手动 stdout 写入
          }, [messages, spinnerView, ...])
```

**目标架构(inline V2 模式)**:
```
<ConnectedApp>
  └─ <App isInline={true}>                ← 真正的组件树,走 Yoga
       ├─ <Static items={finalized}>      ← 已固化消息进 scrollback
       │    └─ {msg => <MessageLine .../>}
       ├─ <StreamingText text={...} role={...}/>     ← 流式草稿(活动区,行级 diff)
       ├─ <Spinner store={...}/>          ← memo,spinner tick 局部重渲染
       ├─ <Footer .../>                   ← memo,内部子组件也 memo
       │    ├─ <SuggestionBar/>
       │    ├─ <SelectionText>{border}</SelectionText>
       │    ├─ <Box internal_cursorTarget>
       │    │    └─ <SelectionText>{input}</SelectionText>
       │    ├─ <SelectionText>{border}</SelectionText>
       │    └─ <StatusBar/>
       └─ (无 ScrollBox — 终端原生 scrollback)
```

**关键差异**:
- `<InlineApp>` 整个消失(过渡期保留作为 V0 路径)
- `<App>` 复用为统一入口,通过 `isInline` prop 分支
- `<Static>` 替代手动 `appendLine` + 渲染账本(`renderedLines` Map)
- `<StreamingText>` 是新组件,渲染末条未固化消息(原 `wrapStreamingTextTrimmed` 转 React 元素)
- ScrollBox 只 alt-screen 用,inline V2 不用

### 3.2 数据流对比

**当前数据流(每个 token)**:
```
text_delta
  → messagesStore.updateStreaming()        ← 重建整个 messages 数组
  → ConnectedApp.useStore(messages)        ← 新引用
  → InlineApp.messages prop
  → useThrottledStreamingText (250ms)      ← 唯一节流
  → useEffect 重跑
  → buildSpinnerLines + layoutFooter       ← 重新构建整个 frame
  → renderer.commit(frame)                 ← 手动 stdout 写入

spinner tick (每 50ms):
  → spinnerStore.tick()
  → InlineApp useStore(spinnerStore)
  → useMemo(selectSpinnerView) → spinnerView 变
  → useEffect 重跑
  → commit(frame)                          ← 重写整个活动区(spinner + footer + statusbar)
```

**目标数据流(每个 token)**:
```
text_delta
  → messagesStore.updateStreaming()        ← 不变
  → ConnectedApp.useStore(messages)        ← 不变
  → <App>.messages prop
  → React reconciler 计算 diff(末条 streaming 变了)
  → 只有 <StreamingText> 重渲染(memo 拦截其他组件)
  → Ink onRender → createIncremental 行级 diff
  → stdout 只写 streaming 行
```

```
spinner tick (每 50ms):
  → spinnerStore.tick()
  → <Spinner> useStore(spinnerStore)       ← Spinner 内部订阅,不冒泡
  → 只有 <Spinner> 重渲染(memo + 局部订阅)
  → Ink createIncremental 行级 diff
  → stdout 只写 spinner 行(44-46B,POC 实测)
```

**关键改变**:
1. **节流层位置上移**:从 `useThrottledStreamingText`(组件外)变成 Ink 内置 throttle(默认 33ms)+ React reconciler 自动 batching。**保留** `useThrottledStreamingText` 作为应用层补充节流,实测后定去留
2. **spinner 订阅局部化**:`<Spinner>` 自己 `useStore(spinnerStore)`,父 `<App>` 不再订阅——spinner tick 只触发 `<Spinner>` 重渲染
3. **行级 diff 由 Ink 完成**:不再手动比较 `footerLines.every(...)`,交给 `createIncremental` 的 `nextLines[i] === previousLines[i]`

### 3.3 Ink 接通方式(不改 patch)

**当前**(`bootstrap.tsx:179-184`):
```ts
if (!isInline && USE_DOUBLE_BUFFER) {
  renderOptions.renderer = createCustomRenderer({ stdout: process.stdout });
  renderOptions.onSetCursorPosition = (pos) => setCursorPos(pos);
}
const inlineRenderer = isInline ? new InlineRenderer(process.stdout) : null;
```

**V2 目标**:
```ts
const useInlineV2 = isInline && process.env.MICODE_INLINE_V2 !== '0';
if (!isInline && USE_DOUBLE_BUFFER) {
  // alt-screen:自研双缓冲 renderer(不变)
  renderOptions.renderer = createCustomRenderer({ stdout: process.stdout });
  renderOptions.onSetCursorPosition = (pos) => setCursorPos(pos);
}
// inline V2:不注入 renderer,走 Ink 原生 + incrementalRendering
if (useInlineV2) {
  renderOptions.incrementalRendering = true;
}
// inline V0(旧路径):保留 InlineRenderer
const inlineRenderer = (isInline && !useInlineV2) ? new InlineRenderer(process.stdout) : null;
```

**render options 完整对照**:

| 模式 | `alternateScreen` | `renderer` | `incrementalRendering` | `inlineRenderer` |
|---|---|---|---|---|
| alt-screen(不变) | `true` | `createCustomRenderer` | - | `null` |
| inline V0(fallback) | `false` | - | - | `new InlineRenderer` |
| **inline V2(新)** | `false` | **不注入** | **`true`** | `null` |

**关键**:**不需要改 `patches/ink+7.1.0.patch`**。现有 patch 已经支持 `options.renderer` 注入,V2 只是**不注入** renderer,自然走 Ink 原生路径。

### 3.4 `<App>` 组件改造

**当前**:`<App>` 只服务 alt-screen 模式,固定用 `<ScrollBox>`。

**V2 目标**:`<App>` 接收 `isInline` prop,按值分支。共享子组件(`<Footer>` / `<Spinner>` / `<MessageLine>` 等),只在顶层容器分叉。

```tsx
export function App({ isInline, messages, ...rest }) {
  if (isInline) {
    const finalized = messages.filter(m => m.finalized);
    const lastMsg = messages[messages.length - 1];
    const streamingMsg = lastMsg && !lastMsg.finalized ? lastMsg : null;
    return (
      <Box flexDirection="column">
        <Static items={finalized}>
          {msg => <MessageLine key={msg.uuid} msg={msg} />}
        </Static>
        {streamingMsg && (
          <StreamingText text={streamingMsg.streamingText} role={streamingMsg.role} />
        )}
        <Spinner store={spinnerStore} />
        <Footer input={input} cursor={cursor} status={status}
                cols={cols} inputRowY={...} viewportTop={...}
                completionStore={completionStore} selectionStore={selectionStore} />  {/* 不含 spinner 相关 prop */}
      </Box>
    );
  }
  // alt-screen(不变)
  return (
    <Box flexDirection="column">
      <LogoBox .../>
      <ScrollBox ...>
        {messages.map(m => <MessageLine key={m.uuid} msg={m} />)}
      </ScrollBox>
      <Footer spinnerView={spinnerView} ... />
    </Box>
  );
}
```

#### 3.4.1 V2 `<Footer>` props 契约(明确化)

V2 路径下 `<Footer>` 与 alt-screen 路径下的 `<Footer>` **是同一个组件,但 props 不同**。

**alt-screen `<Footer>`(不变)**:
```
{ input, cursor, status, cols, inputRowY, viewportTop, spinnerView, completionStore, selectionStore }
```
↑ `spinnerView` 用于内部 `<SpinnerWithVerb>` 子组件

**V2 inline `<Footer>`(新)**:
```
{ input, cursor, status, cols, inputRowY, viewportTop, completionStore, selectionStore }
```
↑ **不含** `spinnerView` / `spinnerStore` — spinner 是 `<Footer>` 的**兄弟**,不是子

**实现策略**(推荐方案 A,alt-screen 不破坏原则):
- **方案 A(推荐)**:同一个 `<Footer>` 组件,通过 `isInline` prop 内部分支决定是否渲染 spinnerView
  - 优点:alt-screen 路径代码完全不动,只新增 inline 分支
  - 缺点:`<Footer>` 内部多一个分支判断
- 方案 B(备选):抽出 `<FooterCore>`(共用)+ alt-screen 包一层加 spinner
  - 优点:`<Footer>` 单一职责
  - 缺点:需要重构现有 alt-screen `<Footer>`,风险扩散

选 A 是因为方案核心原则之一是"alt-screen 模式任何代码不动"。方案 B 会破坏这个原则。具体细节由阶段 3 TDD 决定。

### 3.5 关键设计决策

**Q1:为什么 `<Spinner>` 自己订阅 `spinnerStore`,而不是父组件订阅后传 prop?**

A:为了**隔离重渲染**。父 `<App>` 若订阅 `spinnerStore`,每次 tick 都重渲染整树。`<Spinner>` 内部 `useStore(spinnerStore)`,父组件传 `spinnerStore` 引用(store 本身不变),`<Spinner>` 的 memo 拦截父层重渲染,只在 store 真变时自己重渲染。

**Q2:`<Footer>` 怎么避免被 spinner tick 拖动?**

A:`<Footer>` **不接收任何 spinner 相关 prop**(spinner 是兄弟)。`<Footer>` 的 props 是 `{ input, cursor, status, cols, ... }`——这些在 spinner tick 时都不变 → memo 拦截 → `<Footer>` 子树不重渲染。

**Q3:已固化消息如何"原子地"从活动区移到 `<Static>`?**

A:**代码核查证实 `messagesStore.finalizeStreaming` 已经是原子的**(`src/tui/state/messages-store.ts:165-181`)。同一个 `set()` 调用内完成:
- 末条消息剥离 `streamingText`(解构)
- 标记 `finalized: true`
- 写入 `lines`

React 看到一次 state 变化,触发一次重渲染。`<Static items={finalized}>` 多了一项(新固化消息),`<StreamingText text={...} role={...}>` 因 `streamingMsg` 变成 `null` 而被条件渲染移除(`{streamingMsg && <StreamingText .../>}`)。Ink reconciler 在同一帧内:Static 写新行 + 活动区 eraseLines 擦掉旧的 streaming 草稿。无中间态。**不需要改 store 实现,只加防回归测试。**

**Q4:cursor 定位如何工作?**

A:**stock Ink 自带 `useCursor()` hook,完全独立于 `options.renderer`**。

- `useCursor()`(`node_modules/ink/build/hooks/use-cursor.js`):通过 `CursorContext` 把 cursor position 传给 log-update
- log-update 在每次写入时附加 `buildCursorSuffix`(把 cursor 移到指定坐标)

**MiCode 现有 `<Footer>` 已经在用 `useCursor()`**(`src/tui/components/Footer.tsx:43`):
```tsx
const { setCursorPosition } = useCursor();
const pos = cursorScreenPos(input, cursor, PROMPT);
setCursorPosition({ x: pos.x, y: inputRowY + (pos.y - viewportTop) });
```

V2 路径下这段代码**原样复用,不需要任何改造**。

**注意区分**(避免混淆):
- `useCursor()`(stock Ink 内置)→ V2 inline 路径用,通过 `CursorContext` 把光标位置传给 log-update
- `onSetCursorPosition`(MiCode patch)→ 仅 alt-screen + USE_DOUBLE_BUFFER 用,把光标位置传给自研双缓冲 renderer
- 两条路径独立,V2 不依赖 patch 的 `onSetCursorPosition`

**Q5:`<Static>` 与 `incrementalRendering: true` 是否兼容?**

A:**兼容,POC 已验证**。`scripts/ink-poc/poc-inline-diff.tsx` 就是 `incrementalRendering: true` + `<Static items={finalizedMessages}>` 组合。结果:
- 帧 2(120B)写了 `<Static>` 3 行 Finalized,**只写一次**
- 后续所有 spinner tick 不再写 Static 内容
- spinner tick 时只写 spinner 行(44-46B)

`<Static>` 通过 `internal_static` 标记被 reconciler 识别,输出走 `staticOutput` 通道(独立于 `output`),与 `incrementalRendering` 行级 diff 互不干扰。

---

## 4. 实现顺序

**总览**:5 个阶段(5b 独立),严格串行(每阶段依赖上一阶段),每阶段独立可验证,完成后即可提交。每个阶段完成后 `MICODE_INLINE_V2=0` 可回滚。

### 阶段 0:准备(worktree + 基线)

**目标**:隔离工作区,固化基线测试。

**操作**:
1. 用 `using-git-worktrees` 创建 worktree:`git worktree add ../mi-code-inline-v2 codex/spinner-completion-composition`
2. 把工作树现有的未提交改动(`InlineRenderer.ts` 的 `prevFrameSnapshot`、`use-throttled-streaming-text.ts` 的 250ms、`use-input-handler.ts` 的 SGR 过滤等)**保留作为 V0 fallback**,不还原
3. 把当前 `inline-renderer-footer-dedup.test.ts` 等 V0 测试跑绿,作为基线
4. 把 POC(`scripts/ink-poc/poc-inline-diff.tsx`)扩展为可重复运行的回归测试

**验证标准**:
- worktree 干净,V0 路径所有现有测试绿
- POC 可通过 `npx tsx scripts/ink-poc/poc-inline-diff.tsx` 运行,输出"spinner tick 只写 44-46B"的基线数据
- 提交:`chore: establish V2 baseline + POC harness`

**估算**:0.5 天

### 阶段 1:Ink patch + flag(无组件树改动)

**目标**:让 inline 模式有能力走 Ink 原生 `renderInteractiveFrame`,但**先不接通**——确保现有 V0 路径不受影响。

**操作**:
1. **不改 `patches/ink+7.1.0.patch`**——现有 patch 已经支持 `options.renderer` 注入,我们只是**在 inline V2 模式不注入 renderer**,自然走 Ink 原生路径
2. **改 `bootstrap.tsx:179-184`**:加 `MICODE_INLINE_V2` flag 判断(见第 3.3 节代码)
3. **改 `ConnectedApp.tsx:305-326`**:加 flag 分支,但**V2 分支暂时返回与 V0 相同的 `<InlineApp>`**(占位,下一阶段才真正接通 V2 组件树)
4. 加单元测试:`bootstrap` 在不同 flag/env 组合下创建/不创建 `inlineRenderer`、设置/不设置 `incrementalRendering`

**验证标准**:
- `MICODE_INLINE_V2=0`(默认):行为完全同当前生产代码,V0 所有测试绿
- `MICODE_INLINE_V2=1`:ConnectedApp 进入 V2 分支(暂返回 `<InlineApp>` 占位),不崩
- alt-screen 模式不受 flag 影响
- 提交:`feat(inline): add MICODE_INLINE_V2 flag (no behavior change yet)`

**估算**:0.5 天

### 阶段 2:V2 组件树搭建(`<Static>` + `<ActiveArea>`,无 spinner/streaming)

**目标**:V2 路径能渲染**静态结构**——logo + 已固化消息(`<Static>`)+ 空 footer。验证 `<Static>` 真的进 scrollback、`<App>` 分支正确。

**操作**:
1. **抽离 `<MessageLine>` 组件**:从现有 alt-screen 的 `flatten-messages.ts` + `renderFinalizedLine` 抽出,接收单个 `TuiMessage`,返回 `<Text>` 列。复用现有 `renderFinalizedLine` 逻辑
2. **写 `<ActiveArea>` 占位组件**:先返回 `<Footer>`(alt-screen 用的那个),`<Spinner>` 和 `<StreamingText>` 留空
3. **改 `<App>`**:接收 `isInline` prop,inline V2 分支渲染:
   ```tsx
   <Static items={finalized}>{msg => <MessageLine key={msg.uuid} msg={msg} /></Static>
   <ActiveArea ... />
   ```
4. alt-screen 分支保持原 `<ScrollBox>` 路径不变
5. **加测试**:
   - V2 模式下 `<Static>` 输出含已固化消息(用 `ink-testing-library`)
   - V2 模式下 `<App>` 不渲染 `<ScrollBox>`
   - resize 时 `<Static>` 不重写历史行
   - **专门验证 `<Static items={finalized}>` 在 `incrementalRendering: true` 下正确累积**(POC 已隐式覆盖,但加显式测试)

**验证标准**:
- `MICODE_INLINE_V2=1`:能看到 logo + 已固化消息 + 空 footer
- 已固化消息**只写一次**(扩展 POC 验证)
- alt-screen 模式行为不变
- 提交:`feat(inline-v2): render static messages via <Static>`

**估算**:1 天

### 阶段 3:Spinner + Footer 接入(memo + 局部订阅)

**目标**:V2 路径能渲染完整 footer(spinner + 输入框 + statusbar),且 spinner tick 不拖动 footer 重渲染。

**操作**:
1. **改 `<Spinner>` 组件**:加 `React.memo`,确认它**自己订阅** `spinnerStore`(不接收 spinnerView prop)
2. **改 `<Footer>`**:加 `React.memo`,**移除 `spinnerView` prop**(spinner 是兄弟,不是子)。Footer 不再调 spinner 相关 hook
3. **改 `<Footer>` 子组件**(`<SuggestionBar>` / `<StatusBar>` / `<SelectionText>`):全部加 memo。审计它们的 props 引用稳定性,父组件用 `useShallow` / `useMemo` 包装
4. **`<App>` inline V2 分支**:
   ```tsx
   <Static items={finalized}>...</Static>
   <Spinner store={spinnerStore} />      {/* 兄弟,非 Footer 子 */}
   <Footer input={...} cursor={...} status={...} cols={...}
           completionStore={...} selectionStore={...} />  {/* 不含 spinner 相关 prop */}
   ```
5. **删 `useThrottledStreamingText` 的使用**(本阶段还没接 streaming,先停用)
6. **加测试**:
   - spinner tick 时 `<Footer>` 不重渲染(用 `react/test-renderer` 计数 render 次数)
   - spinner tick 时 stdout 只写 spinner 行(扩展 POC 验证)
   - 输入文本变化时 `<Footer>` 重渲染,`<Spinner>` 不重渲染
   - `<SuggestionBar>` 打开/关闭时 footer 高度变化不破坏 cursor 定位

**验证标准**:
- 完整 POC 场景(已固化 + spinner + footer)通过,**spinner tick stdout 字节 44-46B**(对照 POC 基线)
- alt-screen 模式行为不变(`<Footer>` 仍接收 spinnerView,因为 alt-screen 不变)
- 提交:`feat(inline-v2): wire spinner + footer with memo isolation`

**估算**:2 天

**关键风险**:这阶段最大。`<Footer>` 子组件多、props 多,某个 prop 引用不稳定就会让 memo 失效。**用 React DevTools profiler 或手写 render 计数器逐个验证**。

### 阶段 4:Streaming 文本接入 + finalize 原子性验证

**目标**:V2 路径支持流式正文渲染 + finalize 时机原子性验证(不需要改 store)。

**操作**:
1. **写 `<StreamingText>` 组件**:接收 `{ text, role }`,内部用 `wrapStreamingTextTrimmed` / `wrapThinkingTextTrimmed` 转行,返回 `<Box>` 列。加 memo,只在 text/role 变化时重渲染
2. **`<App>` inline V2 分支**:
   ```tsx
   <Static items={finalized}>...</Static>
   {streamingMsg && <StreamingText text={streamingMsg.streamingText} role={streamingMsg.role} />}
   <Spinner store={spinnerStore} />
   <Footer .../>
   ```
3. **确认 `messagesStore.finalizeStreaming` 原子性(已实现)**:
   代码核查证实 `src/tui/state/messages-store.ts:165-181` 已经在**同一个 `set()` 调用**内完成"剥离 streamingText + 标记 finalized + 写 lines"。**不需要改 store 实现**。本阶段加防回归测试:
   ```ts
   it('finalizeStreaming 在单个 set() 内完成(原子化)', () => {
     // 调 finalizeStreaming 后,末条消息应同时满足:
     // - finalized === true
     // - streamingText === undefined
     // - lines === 传入的 lines
     // 且只触发一次 store subscribe 回调
   });
   ```
4. **保留 `useThrottledStreamingText`(实测后再决定)**:
   Ink 默认 `maxFps: 30`(33ms throttle),不是 React batching。LLM token 到达间隔可能 < 33ms(快速流式),Ink throttle 合并到 ~30fps **可能仍有打印机感**。
   
   本阶段策略:
   - **保留** `useThrottledStreamingText`(它不与 Ink 冲突,只是冗余)
   - 真实 LLM 流式场景下实测:开/关节流层,主观对比流畅度
   - 若 Ink 33ms throttle 已足够 → 在 5b(V0 删除)阶段一起删
   - 若仍有打印机感 → 永久保留,作为"应用层渲染节流"独立存在
5. **加测试**:
   - 流式期间 stdout 只写 streaming + spinner 行(不动 footer)
   - finalize 时 `<Static>` 增加一项 + `<StreamingText>` 消失是同一帧
   - 流式 + spinner tick 并发时不累积重复帧(**核心回归测试**,直接对应原始 bug)

**验证标准**:
- 真实 LLM 流式对话场景:无累积、spinner 流畅、固化时机正确
- 原始 bug 复现路径(`docs/流式输出无限循环问题.md`)在 V2 模式下不复现
- alt-screen 模式行为不变
- 提交:`feat(inline-v2): wire streaming text + atomic finalize`

**估算**:1.5 天

### 阶段 5a:边界场景处理 + 默认开启 V2(2 天)

**目标**:覆盖所有边界场景,验证通过后默认切换到 V2。

**操作**:
1. **Select 选择器**:V2 模式下 `<ActiveArea>` 内条件渲染 `<SelectOverlay>`(替代 `<Footer>`),复用现有键盘交互逻辑
2. **Overlay(Ctrl+O)**:V2 模式下 `<App>` 顶层条件渲染 `<Overlay>`,复用 `useAltScreen` hook
   - 关键验证:退出 overlay 后主屏 `<Static>` 内容完好 + Ink `previousLineCount` 不错乱
   - 回滚方案:如出错,overlay 退出时强制 clear + 重渲染
3. **Resize**:不主动清屏,`<Static>` 已在 scrollback。验证 Ink 检测 `stdout.columns` 变化自动重布局
4. **鼠标选区**:V2 模式**初期不支持**(终端原生选区即可)。`ConnectedApp` 跳过 SGR 鼠标路由
5. **流式中 ESC 中断**:复用现有 `use-input-handler.ts`,验证 finalize 时机原子
6. **长输入**:复用 `computeInputViewport`,`<Footer>` 接收 `viewportTop`

**验证标准**:
- 所有边界场景测试通过
- 真实用户跑 5-10 个典型对话场景无回归
- POC 回归测试(`incremental-rendering.test.tsx`)稳定通过

**默认开启**:
- 验证通过后,改 `bootstrap.tsx` 的 `useInlineV2` 默认为 `process.env.MICODE_INLINE_V2 !== '0'`(默认 true)
- 发版:用户默认走 V2,遇问题可 `MICODE_INLINE_V2=0` 回滚

**提交**:`feat(inline-v2): handle edge cases + default to V2`
**估算**:2 天

### 阶段 5b:V0 删除(V2 稳定 1-2 周后)

**前提**:V2 默认开启已满 1-2 周,无重大回归报告。

**操作**(对照第 7.2 节删除清单):
1. 删 `src/tui/inline/InlineRenderer.ts` / `InlineApp.tsx` / `InlineRenderState.ts`
2. 删 `src/tui/inline/layout.ts`(`layoutFooter`)
3. 删 `src/tui/inline/SpinnerLine.tsx` 的 `buildSpinnerLines`(保留其他导出)
4. 删 `src/tui/inline/use-throttled-streaming-text.ts`(**仅当 5a 实测确认 Ink 节流足够**)
5. 删 `src/tui/inline/diff.ts`(V0 的 RenderOperation 体系)
6. 删 V0 专属测试(`inline-renderer-footer-dedup.test.ts` 等)
7. 清理 `bootstrap.tsx` 的 `inlineRenderer` 创建分支
8. 清理 `ConnectedApp.tsx` 的 V0 early return 分支

**验证标准**:
- `npm test` 全绿
- 代码库无 `InlineRenderer` 引用
- alt-screen 模式完全不受影响

**提交**:`refactor(inline): remove legacy InlineRenderer (V0)`
**估算**:0.5 天

**注**:5b 是独立决策。若 V2 稳定则执行;若发现新问题,5b 可无限期延后(V0 作为长期 fallback 保留,代码冗余但不影响用户)。

### 总估算与里程碑

| 阶段 | 估算 | 累计 | 可发版? |
|---|---|---|---|
| 0. 准备 | 0.5d | 0.5d | 是(V0) |
| 1. flag | 0.5d | 1d | 是(V0) |
| 2. static | 1d | 2d | 否(V2 不完整) |
| 3. spinner+footer | 2d | 4d | 否(V2 不完整) |
| 4. streaming | 1.5d | 5.5d | 是(V2 完整,需手动开 flag) |
| 5a. 边界+默认开启 | 2d | 7.5d | 是(V2 默认) |
| 5b. V0 删除 | 0.5d | 8d | 是(V2 默认,代码干净) |

**总估算:8 个工作日(约 1.5-2 周)**

**关键里程碑**:
- **阶段 4 完成**:V2 路径功能完整,可通过 `MICODE_INLINE_V2=1` 启用做真实测试
- **阶段 5a 完成**:V2 默认开启,所有用户受益
- **阶段 5b 完成**:V0 删除,代码干净

---

## 5. 边界场景处理

V2 路径在阶段 5a 处理边界场景。每条都列出**问题、策略、验证方式**。

### 5.1 Select 选择器(交互式选项)

**问题**:`<SelectStore>` 控制的全屏选择器(如选 model、选 worktree)。当前 V0 在 `<InlineApp>` effect 里通过 `selectVisible` 分支调 `buildSelectView` 拼 ANSI,塞进 footer.lines 替换整个 footer。V2 走 React 组件树后,Select 应该作为活动区的**条件渲染分支**。

**策略**:
- V2 模式下,`<App>` 在 `<ActiveArea>` 内部判断 `selectVisible`:
  ```tsx
  function ActiveArea({ selectStore, ... }) {
    const selectVisible = useStore(selectStore, s => s.visible);
    const selectTitle = useStore(selectStore, s => s.title);
    const selectOptions = useStore(selectStore, s => s.options);
    const selectIndex = useStore(selectStore, s => s.index);
    if (selectVisible) {
      return <SelectOverlay title={selectTitle} options={selectOptions} index={selectIndex} />;
    }
    return <><Spinner .../> ... <Footer .../></>;
  }
  ```
- `<SelectOverlay>` 是新组件(或改造现有 alt-screen 用的版本),返回 `<Box>` 列布局
- 用户键盘交互不变(`use-input-handler.ts` 复用),只改渲染出口
- Select 可见时 spinner 隐藏、footer 隐藏——活动区整树替换

**风险**:Select 高度动态(选项数变化),`createIncremental` 行级 diff 应能处理(POC 已验证高度变化场景)。需要专门加测试。

**验证**:Select 打开/关闭/翻页时 stdout 只写变化行,不破坏下方已固化内容。

### 5.2 Overlay(Ctrl+O 备用屏)

**问题**:用户按 Ctrl+O 看 thinking 全文或 tool_result。当前 V0 用 Ink 自带 alt-screen 切换(`renderer.renderOverlay` 进 `\x1b[?1049h`,退出 `\x1b[?1049l`)。V2 走 Ink reconciler 后,这套机制需要重新设计。

**策略**:
- **保持现有的 alt-screen 切换语义**,但在 React 组件层做:
  ```tsx
  function App({ isInline, overlayStore, ... }) {
    const overlayVisible = useStore(overlayStore, s => s.visible);
    if (overlayVisible) {
      return <Overlay store={overlayStore} />;   // 复用 alt-screen 用的 Overlay 组件
    }
    // ... 正常 <Static> + 活动区
  }
  ```
- `<Overlay>` 组件内部用 `useAltScreen` hook(现有)发 `\x1b[?1049h`,卸载时发 `\x1b[?1049l`
- **关键验证**:退出 overlay 时,主屏已写内容(`<Static>` 输出)是否完好——理论上终端自己恢复主屏,但 Ink 的 `previousLineCount` 状态可能错乱。**这是最高风险点**

**回滚方案**:如果 overlay 退出后画面错乱,临时方案是 overlay 退出时发 `\x1b[?1049l` + `clear()` + 重渲染整个 `<Static>`(虽然低效,但保证正确)

**验证**:进 overlay → 看几秒 → 退出 → 主屏内容完整 + cursor 位置正确 + 后续 spinner tick 正常

### 5.3 Resize(终端尺寸变化)

**问题**:V0 在 `<InlineApp>` effect 里检测 `cols` 变化,清屏 + 重画 + 重置 `renderedLines` 账本。V2 走 Ink 后,`<Static>` 已写内容已在 stdout 流(终端 scrollback),resize 不影响已写内容。但**活动区需要重布局**。

**策略**:
- **不主动清屏**(V2 不需要——已固化内容在 scrollback,resize 不动)
- Ink reconciler 自动检测 `stdout` 的 `columns` / `rows` 变化(通过 `terminal-size` 事件),触发 `<App>` 重渲染,`<Footer>` 的 `border` 重新计算,`<Static>` 的 `wrapLine` 用新 cols
- **新消息**用新 cols 折行,**已写消息保持原样**(这是 inline 模式的正确语义——scrollback 不可变)
- `useTerminalSize` hook(现有)继续提供 `{ rows, cols }`

**风险**:Ink 自身的 resize 处理依赖 `previousLineCount` 正确——如果 resize 时 `eraseLines` 算错,可能擦掉已固化行。**这是次高风险点**

**验证**:resize 缩小 → 放大 → 缩小,确认活动区正确重布局、scrollback 完整、cursor 定位正确

### 5.4 鼠标选区(初期不支持)

**问题**:V0 在 alt-screen 模式下用 SGR 鼠标事件(`\x1b[<0;col;rowM`)做字符级选区高亮 + 跨页拖拽 + 右键复制。inline 模式下,这套机制依赖 `rowTextMap`(屏幕行→文本映射),由 `<ConnectedApp>` 维护。

**策略**:
- V2 模式下**初期不支持鼠标选区**——终端原生选区即可(用户按住左键拖拽,终端自己处理)
- `ConnectedApp.tsx` 的 V2 分支跳过 SGR 鼠标路由(已经只在 `!isInline` 时启用,自然不冲突)
- 后续(本次方案外):如果想支持,需要把 `rowTextMap` 重新设计——inline 模式下已固化内容在 scrollback(行号会随新消息滚动而变化),`rowTextMap` 无法稳定映射。这是个独立大问题

**验证**:V2 模式下鼠标选区交给终端原生(用户可观察到选区高亮是终端的,不是 MiCode 的)。功能上不丢失(用户仍能复制),只是失去了"应用内选区高亮"

### 5.5 流式中 ESC 中断

**问题**:用户在流式输出期间按 ESC 中断 LLM。当前 V0 路径下,`onAbortStream` 触发 `AbortController.abort()`,流式停止,`messagesStore.finalizeStreamingAsInterrupted()` 把半成品消息固化(加 `[interrupted]` 标记)。V2 路径下,这个流程不变。

**策略**:
- ESC 键处理完全复用现有 `use-input-handler.ts` 逻辑
- `finalizeStreamingAsInterrupted()` 已经是原子实现(`messages-store.ts:196-215`),V2 直接复用
- V2 下验证:ESC 后 `<Static>` 增加半成品消息 + `<StreamingText>` 消失 + spinner 隐藏是同一帧

**验证**:流式中 ESC → 终止及时 + 画面无残留 + scrollback 有半成品消息

### 5.6 长输入(多行 + 视口滚动)

**问题**:用户输入超长内容(多行),需要视口滚动。V0 用 `computeInputViewport` 算 `viewportTop`,`<Footer>` 渲染 `[viewportTop, viewportTop + MAX_VISIBLE_INPUT_LINES)`。V2 复用同一逻辑。

**策略**:
- `<Footer>` 组件继续接收 `viewportTop`(由父组件算)
- 父组件用 `useMemo` 包装 `computeInputViewport` 结果,保证引用稳定
- `<Footer>` memo 拦截:输入文本不变时,viewportTop 也不变 → 不重渲染

**验证**:粘贴长文本 + 上下键移动光标 → 视口正确滚动 + footer 不闪烁

---

## 6. 测试策略

### 6.1 POC 扩展为可重复回归测试

**目标**:把 `scripts/ink-poc/poc-inline-diff.tsx` 改造为 `vitest` 测试,每次 CI 跑。

**测试内容**(对应 POC 验证的三个核心假设):
```ts
describe('InlineV2 incrementalRendering POC', () => {
  it('<Static> 已固化消息只写一次进 stdout', async () => {
    // 跑 1 秒 spinner tick,断言 stdout 中 'Finalized' 只出现 1 次
  });

  it('spinner tick 时未变行(footer border, statusbar)不被重写', async () => {
    // 断言 spinner tick 后的帧字节 < 80B(只有 spinner 行)
  });

  it('React.memo 拦截未变组件重渲染', async () => {
    // 用 test-renderer 计数 <Footer> render 次数,断言 spinner tick 不增加
  });
});
```

**位置**:`src/__tests__/tui/inline-v2/incremental-rendering.test.tsx`

### 6.2 单元测试层级

| 模块 | 测试类型 | 关键用例 |
|---|---|---|
| `bootstrap.tsx` flag 分支 | 单元 | `MICODE_INLINE_V2=0/1` + `renderMode=inline/alt-screen` 四种组合 |
| `<App>` 分支渲染 | 组件 | inline V2 返回 `<Static>`,alt-screen 返回 `<ScrollBox>` |
| `<MessageLine>` | 组件 | 各种 role/style 的消息渲染正确 |
| `<StreamingText>` | 组件 | text 变化时重渲染,role 不变时不重渲染 |
| `<Spinner>` memo | 组件 | spinner tick 不触发父组件重渲染 |
| `<Footer>` memo | 组件 | spinner tick 不触发 footer 重渲染(核心回归) |
| `<Footer>` cursor 定位 | 组件 | V2 模式下 `useCursor()` 调用正确,光标在输入框 prompt 之后 |
| `messagesStore.finalizeStreaming` 原子性 | 单元 | 同一 `set()` 完成"标记 + 清空",只触发一次 subscribe |

### 6.3 集成测试(组件协作)

| 场景 | 验证 |
|---|---|
| 流式 token 到达 | `<StreamingText>` 重渲染,`<Footer>`/`<Spinner>` 不动 |
| 流式 + spinner tick 并发 | stdout 不累积重复帧(**核心回归,直接对应原始 bug**) |
| finalize 时机 | `<Static>` 增加一项 + `<StreamingText>` 消失是同一帧 |
| Select 打开/关闭 | 活动区整树替换,无残留 |
| Overlay 进/出 | 主屏内容完好,cursor 位置正确 |
| Resize | 活动区重布局,scrollback 完整 |
| 输入文本时光标定位 | `useCursor()` 正确把终端光标移到 `<Footer>` 输入框位置 |
| 流式期间光标定位 | 流式更新不破坏光标位置(spinner tick + streaming 并发) |

### 6.4 E2E 测试(终端真实行为)

**目标**:用 `ink-testing-library` + 真实 stdout 捕获,验证完整用户流程。

**关键 E2E**:
1. **完整对话**:用户输入 → spinner → 流式 → 固化 → 等待下一轮 → 退出。验证 stdout 输出无累积、scrollback 完整
2. **多次对话**:连续 3 轮对话,验证每轮的已固化消息都在 scrollback、活动区正确
3. **长流式**:流式 1000+ token,验证 spinner tick 与流式更新并发不累积
4. **原始 bug 复现路径**:按 `docs/流式输出无限循环问题.md` 的复现步骤,在 V2 模式下不复现

### 6.5 回归测试(alt-screen 不能破)

**关键红线**:每个阶段提交前必须跑 `npm test`,**alt-screen 模式的所有测试 100% 绿**。具体:
- `<App>` alt-screen 分支输出与改造前完全一致(快照测试)
- `<ScrollBox>` 行为不变
- alt-screen 模式下鼠标选区、Select、Overlay 全部正常
- alt-screen 模式下 `<Footer>` 仍接收 `spinnerView`(alt-screen 不变)

**关于 useCursor 与 onSetCursorPosition 的区别**(避免混淆):
- `useCursor()`(stock Ink 内置)→ V2 inline 路径用,通过 `CursorContext` 把光标位置传给 log-update
- `onSetCursorPosition`(MiCode patch)→ 仅 alt-screen + USE_DOUBLE_BUFFER 用,把光标位置传给自研双缓冲 renderer
- 两条路径独立,V2 不依赖 patch 的 `onSetCursorPosition`

### 6.6 测试反模式(禁止)

- ❌ 测 `<Static>` 内部 `useState`/`useLayoutEffect`(实现细节)
- ❌ 测 Ink reconciler 的调度顺序(框架行为)
- ❌ 测 `previousLineCount` 的具体值(内部状态)
- ❌ 为追求覆盖率加大量低价值测试(只覆盖核心场景 + 回归)

**优先级**:核心回归(原始 bug 不复现) > alt-screen 不破 > 边界场景覆盖 > 单元覆盖率

---

## 7. 回滚与迁移

### 7.1 回滚机制

**flag 驱动**:`MICODE_INLINE_V2` 环境变量控制路径切换。

| 值 | 行为 |
|---|---|
| `'0'` | 走 V0(`InlineRenderer` 手动渲染) |
| `'1'` | 走 V2(Ink reconciler + `<Static>`) |
| 未设置 | 阶段 5a 前:V0(默认);阶段 5a 完成后:V2(默认) |

**回滚操作**:用户/开发者遇到问题 → `export MICODE_INLINE_V2=0` → 立即回到 V0 路径,无需重新构建。

**发版策略**:
- 阶段 4 完成:发版默认 V0,V2 需手动开 flag(早期用户/开发者测试)
- 阶段 5a 完成:发版默认 V2,V0 可手动回滚(真实用户验证)
- 阶段 5b(V2 稳定 1-2 周无重大问题):删除 V0 代码

### 7.2 V0 删除检查清单(阶段 5b)

删除前必须确认:
- [ ] V2 默认开启已满 1-2 周
- [ ] 无用户报告 V2 路径的回归 bug
- [ ] 所有边界场景(Select / Overlay / Resize / 流式 ESC / 长输入)测试覆盖
- [ ] POC 回归测试(`incremental-rendering.test.tsx`)稳定通过 N 次 CI
- [ ] 原始 bug 复现路径在 V2 下不复现(手工验证 + 自动化)

删除范围:
| 文件 | 操作 |
|---|---|
| `src/tui/inline/InlineRenderer.ts` | 删 |
| `src/tui/inline/InlineApp.tsx` | 删 |
| `src/tui/inline/InlineRenderState.ts` | 删 |
| `src/tui/inline/layout.ts` | 删(`layoutFooter`) |
| `src/tui/inline/SpinnerLine.tsx` 的 `buildSpinnerLines` | 删(保留其他导出) |
| `src/tui/inline/use-throttled-streaming-text.ts` | 删(**仅当 5a 实测确认 Ink 节流足够**) |
| `src/tui/inline/diff.ts` | 删(V0 的 RenderOperation 体系) |
| `src/__tests__/tui/inline-renderer-footer-dedup.test.ts` | 删 |
| `src/__tests__/tui/use-input-handler.test.tsx` 的 V0 专属用例 | 评估(部分可能复用) |
| `bootstrap.tsx` 的 `inlineRenderer` 创建分支 | 删 |
| `ConnectedApp.tsx` 的 V0 early return 分支 | 删 |
| `patches/ink+7.1.0.patch` 的 V0 相关注释 | 保留(自研 renderer 仍用于 alt-screen) |

### 7.3 迁移风险与缓解

| 风险 | 缓解 |
|---|---|
| 某个边界场景在 V2 下坏掉(如鼠标选区缺失) | flag 回滚 + 在 issue tracker 跟踪 |
| `<Footer>` 子组件 prop 引用不稳定导致 memo 失效 | 阶段 3 用 React DevTools profiler 逐个验证 |
| Overlay 退出后画面错乱 | 5.2 节的回滚方案(强制 clear + 重渲染) |
| Resize 时 `eraseLines` 擦错已固化行 | 阶段 5a 专门加 resize E2E 测试 |
| 流式期间 Ink reconciler 调度时机与 LLM token 到达不同步 | Ink 自动 throttle(33ms),如有打印机感保留 `useThrottledStreamingText` |
| `<Static>` 在 React StrictMode 下双调用导致重复写入 | 测试期间关 StrictMode,生产环境 Ink 不用 StrictMode |

### 7.4 监控指标(发版后)

V2 默认开启后,关注:
- 用户反馈中 "渲染"、"闪烁"、"累积"、"重复" 关键词
- 性能(spinner tick 的 CPU 占用应低于 V0)
- 内存(`fullStaticOutput` 是否无限增长——理论上 `<Static>` 只追加,但需要监控长会话)

如果出现重大问题,立即 `MICODE_INLINE_V2=0` 回滚,在补丁版本修复后重新开启。

---

## 附录 A:POC 验证基线

POC 脚本:`scripts/ink-poc/poc-inline-diff.tsx`

**场景**:`<Static>` 包 3 行已固化消息 + 活动区(spinner + footer + statusbar),spinner 每 50ms tick。`incrementalRendering: true`,`isTTY: true`。跑 600ms(12 个 tick)。

**关键数据**:

| 帧 | 字节 | Static? | Spinner? | Footer? | StatusBar? | 解读 |
|---|---|---|---|---|---|---|
| 0 | 8B | - | - | - | - | BSU `\e[?2026h` |
| 2 | **120B** | **✅** | - | - | - | **Static 一次性写 3 行** |
| 3 | 6B | - | - | - | - | hideCursor |
| 4 | **412B** | - | ✅ | ✅ | ✅ | **活动区首次完整写** |
| 7 | **44B** | - | ✅ | ❌ | ❌ | spinner tick 50ms,**只重写 spinner 行** |
| 10 | **45B** | - | ✅ | ❌ | ❌ | spinner tick 100ms |
| 13-31 | **46B** | - | ✅ | ❌ | ❌ | 后续 spinner tick |

**核心结论**:
- `<Static>` 一次性写入 scrollback(120B),后续 spinner tick 不再写 Static 内容
- 完整活动区 412B,spinner tick 时只写 **44-46B**(行级 diff 只重写 spinner 行)
- footer border 和 statusbar 完全不被重写
- 每帧字节减少 ~89%

**对比基线**(V0 现状):spinner tick 时每帧写完整活动区(412B+),footer + statusbar 被反复擦写。

---

## 附录 B:核心假设的代码证据

### B.1 stock Ink 内置 `<Static>` 组件

`node_modules/ink/build/components/Static.js`:
```js
export default function Static(props) {
  const { items, children: render, style: customStyle } = props;
  const [index, setIndex] = useState(0);
  const itemsToRender = useMemo(() => items.slice(index), [items, index]);
  useLayoutEffect(() => { setIndex(items.length); }, [items.length]);
  // ... 用 <ink-box internal_static> 包裹
}
```

### B.2 stock Ink 内置 `createIncremental`(行级 diff)

`node_modules/ink/build/log-update.js:105-245`:
```js
const createIncremental = (stream, { showCursor = false } = {}) => {
  let previousLines = [];
  // ...
  for (let i = 0; i < visibleCount; i++) {
    if (nextLines[i] === previousLines[i]) {
      // 行内容相同 → 跳过(cursorNextLine 即可,不重写)
      buffer.push(ansiEscapes.cursorNextLine);
      continue;
    }
    buffer.push(ansiEscapes.cursorTo(0) + nextLines[i] + ansiEscapes.eraseEndLine + ...);
  }
  // 行数减少 → eraseLines(previousVisible - visibleCount + extraSlot) + cursorUp
};
```

### B.3 stock Ink 内置 throttle

`node_modules/ink/build/ink.js:205-236`:
```js
const throttled = throttle(this.onRender, renderThrottleMs, {
  leading: true,
  trailing: true,
});
```

`renderThrottleMs` 来自 `maxFps`,默认 30(`render.js:16`),即 **33ms throttle**。

### B.4 stock Ink 内置 `useCursor`(独立于 `options.renderer`)

`node_modules/ink/build/hooks/use-cursor.js`:
```js
const useCursor = () => {
  const context = useContext(CursorContext);
  const positionRef = useRef(undefined);
  const setCursorPosition = useCallback((position) => {
    positionRef.current = position;
  }, []);
  useInsertionEffect(() => {
    context.setCursorPosition(positionRef.current);
    return () => { context.setCursorPosition(undefined); };
  });
  return { setCursorPosition };
};
```

`CursorContext` 由根 `<App>` 提供,内部调 `this.log.setCursorPosition(position)`,log-update 在每次写入时附加 `buildCursorSuffix`。

### B.5 `messagesStore.finalizeStreaming` 已经是原子的

`src/tui/state/messages-store.ts:165-181`:
```ts
finalizeStreaming: (lines) => set((s) => {
  const last = s.messages[s.messages.length - 1];
  if (!last || last.finalized) { /* 当作普通 append */ }
  // 有流式消息:同一个 set() 内完成"剥离 streamingText + 标记 finalized + 写 lines"
  const { streamingText: _removed, ...rest } = last;
  const updated: TuiMessage = { ...rest, lines, finalized: true };
  return { messages: [...s.messages.slice(0, -1), updated] };
}),
```

同一个 `set()` 调用完成所有变化,React 看到一次 state 变化触发一次重渲染。

---

## 附录 C:与 Claude Code 讨论的 5 轮 review 摘要

完整记录见 `docs/流式输出无限循环问题-CC讨论记录.md`。

| 轮次 | 主题 | 结论 |
|---|---|---|
| 1 | 6 个事实问题(Ink patch / InlineRenderer / 组件树 / renderer 接口 / 分支逻辑 / footer 数据流) | 给 Claude Code 提供代码事实基础 |
| 2 | Claude Code 给出 4 阶段移植清单 | 工作量被高估,因为 MiCode 已有 React 组件库 |
| 3 | stock Ink 7.1.0 能力核查 | `<Static>` + `createIncremental` + `hasChanges` 短路都内置,不需要移植 Claude Code fork |
| 4 | Claude Code 回答 4 个针对性问题 | main-screen 支持足够,`<Static>` 切分规则明确 |
| 5 | Claude Code 评审设计文档,提 6 个问题 | 2 个实质性(cursor 定位 + finalize 原子化)都是"不需要改",4 个优化建议全部采纳 |

---

## 下一步

本设计文档进入 **writing-plans** 阶段,转为详细实现计划:
- 每个 stage(0/1/2/3/4/5a/5b)拆为具体 TODO 项
- 每个 TODO 项对应 TDD 流程(RED → GREEN → REFACTOR)
- 估算每个 TODO 的工作量
- 识别每个 stage 的依赖关系和并行机会
