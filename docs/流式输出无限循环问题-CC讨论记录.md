# 流式输出无限循环问题 - Claude Code 讨论记录

> 时间:2026-07-20
> 上下文:MiCode inline 模式流式输出累积重复帧 bug 的架构修复讨论
> 状态:事实材料已齐备,待决策"改架构 vs 分区 diff"

---

## 背景

MiCode 是 React + Ink 项目(`ink@^7.1.0`, `react@^19.2.7`),有两种渲染模式:

- **alt-screen 模式**:走 Ink reconciler + Yoga + 自研双缓冲 renderer(`src/render/`),工作正常
- **inline 模式**:`ConnectedApp.tsx:305-326` 通过 early return 把组件树短路成 `<InlineApp>`,后者完全绕开 Ink 渲染引擎,自己调 `InlineRenderer.commit()` 写 stdout

**为什么当初绕开 Ink**:inline 模式核心价值是已固化消息行真实写进 stdout 流(进终端 scrollback)。Ink 默认是 alt-screen 整屏擦写模式,与"已固化行进流"语义冲突。

---

## Bug 根因(三层)

1. **`prevFrameSnapshot` 帧级快照比较的致命条件**:
   `InlineRenderer.ts:299` 的 `frame.streamingLines === null` 在流式期间永不为 null,导致短路不触发,commit 必走完整写入路径。

2. **spinner 行在 `footer.lines` 里每 50ms 变化**:
   `layout.ts:199` 把 `visibleSpinnerLines` 插到 footer.lines 头部,而 spinner 字符在 50ms 尺度上持续变(glyph 每 120ms 切、shimmer 每 200ms 扫、token 每 tick +3~50、thinking 颜色正弦呼吸)。即使去掉 `streamingLines === null` 条件,`footerLines.every(...)` 也会因 spinner 行差异而失败。

3. **spinner 与正文草稿被绑在同一个 commit() 里**:
   两者物理上分立,但 `commit(frame)` 把它们作为一个整体写入。spinner tick 触发的 commit 会重写整个帧(包括正文草稿、footer 其他行)。

---

## Claude Code 提议的方向

> Claude Code 判断:不需要"引入 Ink"(已经有了),而是"让 inline 模式也走 Ink 渲染管线"。

Claude Code 的 forked Ink(`src/ink/`)已解决 inline 模式渲染问题:

- `src/ink/ink.tsx:578-584` — main-screen 不做 CSI H cursor home,用相对操作
- `src/ink/log-update.ts:187-199` — main-screen 的 scrollback 处理(cursorAtBottom + viewportY)
- `src/ink/log-update.ts:129-131` — 非 TTY 时走全帧渲染

具体改法:去掉 `InlineRenderer`,让 `ConnectedApp` 的 inline 分支也走 Ink 的 `onRender` 管线。

---

## 给 Claude Code 的 6 个事实答案(用于评估移植清单)

### Q1: Ink patch 的钩子(`options.renderer` 签名)

**不是 Ink 渲染之后加一步,是替换整个渲染流程**(在 `ink.js` 里 if/else 分叉):

**签名**(`src/render/renderer.ts:23`):
```ts
export type InkRenderer = (
  node: unknown,  // React reconciler 的 yoga 根节点
  options: { width: number; height: number; cursor?: CursorPos }
) => { output: string; outputHeight: number; staticOutput: string };
```

**替换点**(`patches/ink+7.1.0.patch` 第 53-93 行,作用在 `ink.js` 的 `onRender`):
```js
if (this.options.renderer) {
  ({ output, outputHeight, staticOutput } = rendererFn(this.rootNode, {...}));
} else {
  ({ output, outputHeight, staticOutput } = render(this.rootNode, this.isScreenReaderEnabled));
}
if (this.options.renderer) {
  this.lastOutput = output;
  this.lastOutputToRender = output;
  this.lastOutputHeight = outputHeight;
  return;  // ← 跳过 Ink 的 renderInteractiveFrame(throttledLog → stdout)
}
this.renderInteractiveFrame(output, outputHeight, ...);
```

**配套钩子**:
- `options.onSetCursorPosition(pos)` — Ink 把 `<Box internal_cursorTarget>` 光标位置同步给 custom renderer
- `reconciler.js` patch — `internal_cursorTarget` prop 透传到 host 节点,供 yoga-walk 读取定位输入框

### Q2: InlineRenderer 接口 + CommitFrame 类型

**公开接口**(`src/tui/inline/InlineRenderer.ts`):

| 方法 | 行 | 作用 |
|---|---|---|
| `constructor(stdout)` | 43 | 建 `InlineRenderState`,发 `\x1b[?7l`(DECAWM OFF) |
| `state: InlineRenderState` | 14 | 公开状态(footerHeight/cursorToTop/lastStreamingHeight/renderedLines) |
| `getFooterHeight()` | 16 | 测试用读 footerHeight |
| `appendLine(ansiText)` | 54 | 写一行 + `\n` |
| `renderFooter(...)` | 123 | 旧式直接渲染 footer(组件层不再调,测试用) |
| `writeFooter(layout)` | 143 | 写已算好的 footer 布局 |
| `commitFooter()` | 181 | 擦除 footer(生命周期清理) |
| `rewriteStreamingLines(lines)` | 208 | 覆写流式草稿 |
| `clearStreamingHeight()` | 215 | 重置流式高度 |
| `eraseStreamingLines()` | 229 | 擦除草稿(固化时) |
| `exitOverlay()` | 245 | 退出备用屏 |
| `renderOverlay(title, lines, cols)` | 260 | 进备用屏渲染覆盖层 |
| `executeOperations(ops)` | 70 | 执行 RenderOperation[] |
| `destroy()` | 50 | 恢复 DECAWM ON + 光标可见 |
| **`commit(frame)`** | **291** | **组件层唯一入口** |

**CommitFrame 类型**(`InlineRenderer.ts:390-414`):
```ts
export interface CommitFrame {
  prefix?: string[];                              // logo 首次/resize 清屏
  newLines: string[];                             // 新固化行(已 ANSI)
  streamingLines: string[] | null;                // 流式草稿(null=不流式)
  footer: FooterLayout;                           // footer 布局结果
  hasNewFinalized: boolean;                       // 有新增固化行?
  transitions: {
    justFinalized: boolean;                       // 上一帧流式,本帧不在流式
    needEraseDraft: boolean;                      // 需擦草稿
    forceFooterReset?: boolean;                   // Select 开关切换
  };
}

interface FooterLayout {
  lines: string[];                                // 完整 footer 行序
  height: number;                                 // = lines.length
  cursorToTop: number;                            // 光标行到 footer 顶距离
  cursorCol: number;                              // 光标列(0-based)
  usableWidth: number;                            // cols - 1
  isSelect?: boolean;                             // Select 模式标志
}
```

### Q3: `<InlineApp>` 内部组件树 + 流式数据流

**InlineApp 是叶子组件**——**没有子组件**。它返回 `<></>`(`InlineApp.tsx:356`),所有渲染都是副作用。

**驱动渲染的 hooks**:
- `useStore(inputStore, ...)` — 输入文本+光标
- `useStore(statusStore, ...)` — status bar
- `useStore(spinnerStore)` — **订阅整个 store**(任何字段变都触发)
- `useStore(overlayStore, ...)`, `useStore(completionStore, ...)`, `useStore(selectStore, ...)`
- `useMemo(() => selectSpinnerView(spinnerState), [spinnerState])` — 派生 spinner view
- `useThrottledStreamingText(realStreamingText)` — **唯一的节流层**

**两个 useEffect**:
1. overlay 渲染(`InlineApp.tsx:163-177`)— 进/退备用屏
2. 主渲染 effect(`InlineApp.tsx:188-353`)— 依赖数组 16 项:`[messages, renderer, inputText, cursor, statusData, spinnerView, logo, streamingText, overlay.visible, dropdownVisible, dropdownCandidates, dropdownIndex, selectVisible, selectTitle, selectOptions, selectIndex, cols]`

**流式文本数据流**:
```
LLM text_delta
  → anthropic-stream-client.ts:167 (SSE → StreamEvent)
  → streaming-query.ts:188 (yield + emit)
  → index.ts:755 (pipeline.emit({kind:'assistant_text', text, isFinal:false}))
  → block-pipeline.ts:174 (renderer.appendStreamingMarkdown)
  → pipeline-adapter.ts:96 (store.updateStreaming(fullText))   ← 每次都新建 messages 数组
  → messagesStore 状态变化
  → ConnectedApp useStore(messagesStore, s=>s.messages) → 新引用
  → InlineApp 收到新 messages prop
  → lastMsg.streamingText 取出
  → useThrottledStreamingText 节流(250ms leading+trailing)
  → 返回 throttled → effect 重跑 → commit(frame.streamingLines=wrapped)
```

**spinner 数据流**:
```
useSpinnerClock(setInterval 50ms)
  → spinnerStore.tick()
  → set({time, displayedTokens, stalledIntensity, ...})
  → InlineApp useStore(spinnerStore) → spinnerState 变
  → useMemo(selectSpinnerView) → spinnerView 变
  → effect 重跑 → buildSpinnerLines(spinnerView) → footer.lines 含 spinner 行
```

### Q4: 自研 renderer 接口 + 与 InlineRenderer 的关系

**两个完全独立的路径**:

- **alt-screen 模式**:`USE_DOUBLE_BUFFER && !isInline` 时启用 → `createCustomRenderer`(`src/render/renderer.ts`)→ yoga-walk + cell-level diff + optimizer + emit → 双缓冲直接写 stdout
- **inline 模式**:`InlineRenderer`(`src/tui/inline/InlineRenderer.ts`)→ React 组件层自己构建 `CommitFrame` → 手动 cursorUp + 整行擦写

**关系**:**两者互不调用,共用 React/Ink reconciler,但渲染出口完全独立**。`bootstrap.tsx:179-184` 二选一:
```ts
if (!isInline && USE_DOUBLE_BUFFER) {
  renderOptions.renderer = createCustomRenderer({ stdout: process.stdout });
  renderOptions.onSetCursorPosition = (pos) => setCursorPos(pos);
}
const inlineRenderer = isInline ? new InlineRenderer(process.stdout) : null;
```

### Q5: bootstrap 的 inline/alt-screen 分支逻辑

**bootstrap.tsx 分支**:
- `renderMode: RenderMode` — `'inline' | 'alt-screen'`,默认 inline
- `isInline = renderMode === 'inline'`
- `renderOptions.alternateScreen = !isInline` — inline 模式不进 alt-screen
- `renderOptions.renderer` 仅 alt-screen + USE_DOUBLE_BUFFER 时设
- `inlineRenderer` 仅 inline 时建

**ConnectedApp 分支**(`ConnectedApp.tsx:305-326`):
```tsx
if (isInline && _inlineRenderer) {
  return <DropdownProvider><InlineApp ... renderer={_inlineRenderer} /></DropdownProvider>;
}
return <DropdownProvider><App ... /></DropdownProvider>;  // alt-screen
```

**inline-only 逻辑**:
- 完全绕开 Yoga 布局(`<App>` 用 `<Box>` + flex;`<InlineApp>` 不用)
- completion 候选用常量短路(`ConnectedApp.tsx:108-109`):inline 模式 inline 直接读 completionStore,不经 ConnectedApp props
- 鼠标 SGR 路由只 alt-screen 启用(`ConnectedApp.tsx:275`)
- scrollback 由 stdout 流天然保留(inline),由 alt-screen buffer 维护(alt-screen)

### Q6: footer.lines 数据来源 + spinnerView 路径

**footer.lines 来源**(`InlineApp.tsx:329-334`):
```tsx
const footerLayout = layoutFooter({
  input: inputText, cursor, status: statusText, cols, rows,
  suggestions, dropdownIndex, viewportTop: vp.viewportTop,
  spinnerLines,           // ← 由 InlineApp 算出后注入
  selectView,
});
```

**spinnerLines 构建**(`InlineApp.tsx:311-313`):
```tsx
const spinnerLines = spinnerVisible
  ? buildSpinnerLines(spinnerView, cols)   // 调 SpinnerLine.tsx:143
  : [];
```

**layoutFooter 把 spinnerLines 插到 footer.lines 头部**(`layout.ts:199`):
```ts
const lines: string[] = ['', ...visibleSpinnerLines, border];
//                   ↑ 1空行  ↑ spinner 行(可能多行)  ↑ border
```

**spinnerView 路径**:
```
spinnerStore (vanilla zustand)
  → ConnectedApp: useStore(spinnerStore) (整 store 订阅)
  → 透传给 InlineApp 的 spinnerStore prop
  → InlineApp: useStore(spinnerStore) + useMemo(selectSpinnerView, [spinnerState])
  → spinnerView
```

---

## 架构改造的 3 个硬障碍

1. **stock Ink 7.x 的 main-screen 支持**:Claude Code fork 的 `log-update.ts:129` 处理 `!isTTY → renderFullFrame`,但它的 main-screen cursor 处理(`ink.tsx:578` `altScreenActive ? ALT_SCREEN_ANCHOR_CURSOR : 保留 prev`)是 fork 新增。stock Ink 7.x 的 `log.js`/`ink.js` 没有这套逻辑。需要把 `log-update.ts` + `ink.tsx` 的 main-screen 段移植到 MiCode 的 `patches/ink+7.1.0.patch`。

2. **`<Static>` 组件**:Claude Code forked Ink 的 main-screen 模式依赖 `<Static>` 把已固化消息写进 stdout 流(进 scrollback)。MiCode 当前 `<App>` 用 ScrollBox 自己管 scroll,**没用 `<Static>`**。要让 inline 走 Ink,需要把 messages 改造成 `<Static>` + 活动区分层模型——这是组件树的实质性重构。

3. **spinner/footer/select/dropdown 的布局**:当前 InlineApp 在 effect 里手动组装 `CommitFrame`,所有这些区域在 layout.ts 的 `layoutFooter` 里拼装。要走 Ink,需要把这些区域改成 `<Box>` 子组件 + memo,让 Yoga 算布局 + Ink reconciler 做 diff。`SpinnerLine.tsx` 的 `buildSpinnerLines` 当前返回 ANSI 字符串,要改成返回 React 元素。

---

## 待决策:方案路线

- **A. 改架构(走 Ink reconciler)**:工作量大,需要移植 Claude Code fork 的 main-screen 逻辑 + 引入 `<Static>` + 组件树重构。一劳永逸,框架自动 diff。
- **B. 分区 diff(在 InlineRenderer 内)**:spinner / streaming / newLines / footer 各自独立快照与 diff,模拟 Ink memo + damage region。中等改动,治本,保留现有架构。
- **C. 分两阶段**:先 B(快速治本),后续评估 A。

---

## Claude Code 的移植清单(4 阶段)

### 核心发现

MiCode 的 inline 模式绕开 Ink 不是因为"没有 Ink",而是**两个独立问题**:
1. stock Ink 7.x 不支持 main-screen 渲染(只有 alt-screen)— 所以需要 patch
2. `<InlineApp>` 返回 `<></>`,所有渲染是副作用 — 绕开了 Ink 的 Yoga 布局 + diff 管线

问题 1 可以通过移植 Claude Code 的 main-screen 逻辑解决。但**问题 2 才是根本障碍**——即使 Ink 支持 main-screen,InlineApp 的组件树不走 Yoga 布局,Ink 的 diff 引擎没有东西可以 diff。

### 阶段 1:让 Ink 支持 main-screen 渲染

改动文件:`patches/ink+7.1.0.patch`

**1a. log-update.ts 的 main-screen diff 逻辑**
```ts
const cursorAtBottom = prev.cursor.y >= prev.screen.height
const prevHadScrollback = cursorAtBottom && prev.screen.height >= prev.viewport.height
```
判断"上一帧的 cursor 是否在屏幕底部,内容是否溢出进 scrollback"。移植到 MiCode 的 Ink log.js。

**1b. ink.tsx 的 main-screen cursor 处理**
```ts
let prevFrame = this.frontFrame;
if (this.altScreenActive) {
  prevFrame = { ...this.frontFrame, cursor: ALT_SCREEN_ANCHOR_CURSOR };
}
// main-screen: cursor 保持上一帧位置
```
alt-screen 每帧 cursor 归零(CSI H),main-screen 保持上一帧位置。在 MiCode 的 Ink ink.js 的 onRender 中加入分叉。

**1c. writeDiffToTerminal 的 main-screen 模式**

Claude Code `src/ink/ink.tsx:624-651`:alt-screen 在 diff 前加 CSI H + BSU/ESU,main-screen 不加。在 MiCode 的 Ink patch 中区分两种模式。

**验证标准**:MiCode 的 alt-screen 模式仍然正常工作(回归测试),inline 模式下 Ink 的 diff 引擎能正确计算 main-screen 的增量更新。

### 阶段 2:把 InlineApp 的副作用渲染改成 React 组件树

当前状态:InlineApp 返回 `<></>`,所有渲染在 useEffect 里通过 `InlineRenderer.commit(frame)` 完成。
目标状态:InlineApp 返回真正的 React 组件树,走 Yoga 布局 + Ink diff。

**2a. 消息列表 → `<Box>` 组件**
**2b. Footer → `<Box>` 组件**
**2c. Spinner → `memo()` 组件**
**2d. Select/Dropdown → 条件渲染**

**验证标准**:组件树能被 Yoga 正确布局,Ink 的 renderNodeToOutput 能正确渲染每个节点。

### 阶段 3:去掉 ConnectedApp 的 inline early return

`ConnectedApp.tsx:305-326`:不再区分 inline/alt-screen,统一走 `<App>`。

关键:需要确保 `<App>` 组件在 main-screen 模式下正确工作。Claude Code 的 `<App>` 组件同时支持 alt-screen 和 main-screen,通过 `altScreen` prop 切换。

**验证标准**:inline 模式下,`<App>` 组件树通过 Ink 的 `onRender → diffEach → writeDiffToTerminal` 管线输出到终端,scrollback 正确保留。

### 阶段 4:删除 InlineRenderer 及相关代码

删除文件:
- `src/tui/inline/InlineRenderer.ts`
- `src/tui/inline/InlineRenderState.ts`
- `src/tui/inline/layout.ts`(`layoutFooter` 不再需要)
- `src/tui/inline/SpinnerLine.tsx`(`buildSpinnerLines` 改为 React 组件)

删除逻辑:
- `bootstrap.tsx` 中 `inlineRenderer` 的创建和传递
- `ConnectedApp` 中 `_inlineRenderer` 的 prop
- `InlineApp` 整个组件(功能合并到 `<App>`)

**验证标准**:代码库中不再有 `InlineRenderer`、`CommitFrame`、`layoutFooter`、`buildSpinnerLines` 的引用。

### 工作量评估

| 阶段 | 改动量 | 风险 | 依赖 |
|---|---|---|---|
| 1. Ink main-screen patch | 中(~200 行 patch) | 中(需理解 Ink 的 log.js + ink.js) | 无 |
| 2. InlineApp → React 组件树 | 大(重构整个组件树) | 高(组件树 + 布局 + 数据流全部改变) | 阶段 1 |
| 3. 去掉 early return | 小(几行代码) | 低(前提是阶段 2 完成) | 阶段 2 |
| 4. 删除 InlineRenderer | 小(删除代码) | 低 | 阶段 3 |

总工作量:阶段 1 + 阶段 2 是核心,预计 1-2 周。阶段 3 + 4 是收尾,1-2 天。

### Claude Code 的关键提问

> 阶段 2 的改动量最大——把 InlineApp 的副作用渲染改成 React 组件树。这意味着 Message、StreamingMarkdown、TextInput、SpinnerLine、SuggestionList、StatusLine 这些组件都需要从"返回 ANSI 字符串"改成"返回 React 元素"。
> MiCode 现有的 `<App>`(alt-screen 模式)里,这些组件已经是 React 元素了吗?如果是,阶段 2 的工作量大幅减少。

---

## MiCode 实际情况(回答 Claude Code 的关键提问 + 修正清单)

### 好消息:React 组件库**已经存在且完整**

`src/tui/components/` 下已有 11 个 React 组件(用 `<Box>` + `<Text>`,走 Yoga):

- `<Spinner>` / `<SpinnerGlyph>` / `<GlimmerMessage>` / `<ThinkingIndicator>` — 完整 spinner 组件链
- `<Footer>` / `<StatusBar>` / `<SuggestionBar>` / `<SelectionText>` — 完整 footer 组件链
- `<ScrollBox>` — 历史消息虚拟滚动
- `<LogoBox>` / `<Overlay>` / `<DropdownOverlay>` / `<DotsCycle>`

这些组件已经是真正的 React 元素。`Footer.tsx:42` 已用 Ink `useCursor`,`Spinner.tsx` 已用 `useStore + useTheme + GlimmerMessage`。`<App>` 组件树(`src/tui/App.tsx`)已经把 `<LogoBox> + <ScrollBox> + <Footer>` 组装好,跑 alt-screen 模式。

**Claude Code 阶段 2 的工作量被高估了**——组件库现成,只需让 inline 模式也用它们,不需要重写。

### 坏消息:阶段 2 漏了**最关键的改动**——scrollback 模型

Claude Code 清单的阶段 2 只说"消息列表 → `<Box>` 组件",但没回答:**inline 模式下,已固化消息如何真实写进 stdout 流**?

- alt-screen 模式:`<ScrollBox>` 用虚拟滚动,只渲染可见区,已固化消息**没真正进 stdout**,resize/退出时整屏消失
- inline 模式:**已固化消息必须真实写进 stdout,进终端 scrollback,resize 后还在**

这是当初绕开 Ink 的根本原因。要让 inline 走 Ink,必须引入 Ink 的 `<Static>` 组件——已固化消息通过 `<Static>` 一次性写进 stdout,后续渲染只重绘活动区。**这是 Claude Code 清单阶段 2 漏掉的核心改动**。

### 修正后的实际工作量

| 阶段 | 实际改动 | 工作量 |
|---|---|---|
| 1. Ink main-screen patch | 移植 Claude Code 的 log-update + ink.tsx 的 main-screen 段,加入 `<Static>` 支持 | **中-大**(需要 stock Ink `<Static>` 与 main-screen 兼容性验证) |
| 2a. 组件树复用 | inline 也用现有 `<App>`(已有组件库) | **小**(几乎零成本) |
| 2b. **`<Static>` 模型重构**(Claude Code 漏掉) | 把 `messagesStore.messages` 拆成已固化(`<Static>`)+ 流式(活动区)。`<ScrollBox>` 的虚拟滚动模型与 inline 模式不兼容,需要分支 | **大**(组件树 + 数据流实质性改造) |
| 2c. spinner memo | `<Spinner>` 加 `memo()`(如果还没有) | **小** |
| 3. 去 early return | 几行 | 小 |
| 4. 删 InlineRenderer | 删 | 小 |

**核心障碍依然是 `<Static>` 模型重构**——这是 Claude Code 清单**没明说但实际必须**的硬骨头。

---

## 最终判断

- **方案 A(改架构)可行,但工作量比 Claude Code 估计的大**——主要多在 `<Static>` 模型重构 + main-screen patch 的兼容性验证。预估 2-3 周。
- **方案 B(分区 diff)在 InlineRenderer 内部解决,1-2 天**。保留现有架构,治本(spinner tick 只重写 spinner 行,不动正文/footer 其他行)。
- **方案 C 分两阶段** 最稳健:B 先快速治本让用户能用,A 后续按节奏推进。

---

## 第二轮核查:stock Ink 7.1.0 本身就支持 main-screen + `<Static>`

### 重大发现

我(assistant)在 MiCode 的 `node_modules/ink/build/` 里核查了 stock Ink 7.1.0 的源码,发现:

**1. stock Ink 内置 `<Static>` 组件**(`node_modules/ink/build/components/Static.js`):
```js
export default function Static(props) {
  const { items, children: render, style: customStyle } = props;
  const [index, setIndex] = useState(0);
  const itemsToRender = useMemo(() => items.slice(index), [items, index]);
  useLayoutEffect(() => { setIndex(items.length); }, [items.length]);
  // ... 用 <ink-box internal_static> 包裹,供 reconciler 识别
}
```
已固化消息通过 `<Static>` 一次性写进 stdout 流,后续渲染只重绘活动区。**这正是 inline 模式需要的 scrollback 语义**。

**2. stock Ink 的 `onRender` 已经处理 main-screen + scrollback**(`node_modules/ink/build/ink.js:437-449`):
```js
if (hasStaticOutput) {
  this.fullStaticOutput += staticOutput;  // 累积 <Static> 输出
}
// MI-CODE FORK: 自研 renderer 已直接写 stdout,跳过 Ink 的 renderInteractiveFrame
if (this.options.renderer) {
  this.lastOutput = output;
  this.lastOutputToRender = output;
  this.lastOutputHeight = outputHeight;
  return;   // ← MiCode 的 patch 主动堵死了 main-screen 这条路
}
this.renderInteractiveFrame(output, outputHeight, hasStaticOutput ? staticOutput : '');
```

**3. `renderInteractiveFrame` 内部用 `log-update`**(`node_modules/ink/build/log-update.js:33-46`):
```js
stream.write(returnPrefix +
  ansiEscapes.eraseLines(previousLineCount) +  // 擦上一帧所有行
  str +                                          // 重写当前帧
  cursorSuffix);                                 // 定位光标
```
**这正是 MiCode 的 `InlineRenderer` 手动做的事**——光标上移 + eraseLines + 重写。stock Ink 已经实现了等价机制。

### 核心结论

**当初绕开 Ink 的根本原因不存在了**——stock Ink 7.1.0 自带 main-screen + `<Static>` 支持。MiCode 的 `InlineRenderer` 实际上是**重复实现了 Ink 已有的能力**,而且实现得更糟(没有 cell-level diff、没有自动 memo、没有 `<Static>` 的 scrollback 累积)。

### 修正后的工作量

之前估计"2-3 周"过于悲观。实际:

| 阶段 | 实际工作量 |
|---|---|
| 1. Ink patch | **小**——不需要"移植 Claude Code 的 main-screen 逻辑",stock Ink 本身已支持。只需要**修改 patch**,让 inline 模式**不跳过** `renderInteractiveFrame`,或不注入 `options.renderer` |
| 2a. 组件树 | **小**——`<App>` + 现有组件库(`src/tui/components/` 下 11 个)现成 |
| 2b. `<Static>` 重构 | **中**——把 messagesStore 的已固化消息包装成 `<Static>` + 把活动区(spinner/streaming/footer)单独输出 |
| 2c. spinner memo | 小 |
| 3-4. 收尾 | 小 |

**实际工作量:1 周左右**(主要在 `<Static>` 数据流重构 + 大量回归测试)。

---

## 给 Claude Code 的第二轮针对性问题

### 问题背景

刚验证了 stock Ink 7.1.0 的 `ink.js:437-449` 和 `<Static>` 组件(`node_modules/ink/build/components/Static.js`),发现 main-screen + scrollback 的支持**stock Ink 本身就有**。MiCode 的 patch(`patches/ink+7.1.0.patch` 第 81-93 行)主动跳过了这条路。有 4 个代码级问题:

### Q1:为什么当初要绕开 stock Ink 的 `renderInteractiveFrame`?

stock Ink 7.1.0 的 `ink.js:437-449`:
```js
if (hasStaticOutput) {
  this.fullStaticOutput += staticOutput;  // 累积 <Static> 输出
}
if (this.options.renderer) {
  // MI-CODE FORK: 自研 renderer 已直接写 stdout,跳过 Ink 的 renderInteractiveFrame
  return;
}
this.renderInteractiveFrame(output, outputHeight, hasStaticOutput ? staticOutput : '');
```
stock Ink 的 `renderInteractiveFrame` 内部用 `log-update`(createStandard)做"光标上移 + eraseLines + 重写"——这和我手动写的 InlineRenderer 行为对等。**如果我在 inline 模式下不注入 `options.renderer`,直接让 Ink 走原生 `renderInteractiveFrame`,会出现什么问题?** 为什么当初要绕开?

### Q2:messagesStore 按什么维度切分 `<Static>` items vs 活动区?

stock Ink `<Static>` 的实现(`Static.js:1-32`)用 `useState(0)` + `useLayoutEffect(setIndex(items.length))` 跟踪已渲染项。流式期间的"临时流式消息"(messagesStore 末条的 `streamingText`)应该如何处理——放进 `<Static>` 还是活动区?如果放活动区,流式文本变长时会反复擦写底部行(这正是我们要的);但已固化的多行消息必须进 `<Static>`。**messagesStore 应该按什么维度切分 `<Static>` items vs 活动区?**

### Q3:活动区高度不稳定时,`eraseLines` 是否会出错?

stock Ink 的 `log-update.js:33-46`:
```js
stream.write(returnPrefix +
  ansiEscapes.eraseLines(previousLineCount) +
  str +
  cursorSuffix);
```
每次重渲染会 `eraseLines(previousLineCount)` 擦掉上一帧所有行再重写。**如果活动区高度不稳定(如 spinner 从 1 行变 3 行、suggestion 列表打开/关闭),这个擦除逻辑是否会出错?** MiCode 现有的 `cursorToTop` / `footerHeight` 账本是否还需要?

### Q4:`<App>` 组件是否应该按 `isInline` 分支?

MiCode 的 `<App>` 组件树(`src/tui/App.tsx`)当前用 `<ScrollBox>` 做虚拟滚动管理可见区——这是 alt-screen 模型的核心。inline 模式下不能用 ScrollBox(已固化消息必须真实写进 stdout),需要用 `<Static>`。**`<App>` 组件是否应该按 `isInline` 分支渲染不同的子树**(inline 用 `<Static>` + 活动区,alt-screen 用 `<ScrollBox>` + `<Footer>`)?还是统一一个组件树?

---

## Claude Code 的第二轮答案(4 个问题的答复)

### Q1:不注入 `options.renderer` 会出什么问题?——`outputHeight` 追踪的竞态

stock Ink 的 `renderInteractiveFrame`(等价于 log-update)内部做:
1. `cursorUp(previousLineCount)` — 光标上移上一帧的行数
2. `eraseLines(previousLineCount)` — 擦除上一帧的所有行
3. `write(newOutput)` — 写入新内容
4. `update previousLineCount` — 记录本帧行数

**问题出在步骤 1+2:`previousLineCount` 的计算**。

Claude Code 的 `src/ink/ink.tsx:594-595` 在每次渲染后做双缓冲交换:
```ts
this.backFrame = this.frontFrame;
this.frontFrame = frame;
```
`frontFrame.screen.height` 就是 `previousLineCount`。但 stock Ink 7.1.0 **没有双缓冲**——它用 `outputHeight` 追踪上一帧行数。当内容高度变化时(streaming 文本从 3 行变 5 行),`outputHeight` 的更新时机和 `eraseLines` 的执行时机之间的竞态会导致擦除行数不对。

**具体场景**:
```
帧 1: 活动区 3 行 → previousLineCount=3
帧 2: 活动区 5 行 → eraseLines(3) 只擦 3 行,剩余 2 行旧内容残留
帧 3: 活动区 4 行 → eraseLines(5) 擦 5 行,多擦 1 行已固化内容
```

**这就是当初绕开 Ink 的根本原因**。MiCode 的 `InlineRenderer` 手动维护 `cursorToTop` 和 `footerHeight` 账本,精确知道"footer 在屏幕的第几行",所以能正确定位和擦除。

**解法**:不是不注入 `options.renderer`,而是**修改 patch**,让 `renderInteractiveFrame` 使用双缓冲的 `frame.screen.height` 作为 `previousLineCount`。这正是 Claude Code 的 forked Ink 做的事——它用 `frontFrame` 追踪上一帧状态,而不是用一个简单的 `outputHeight` 计数器。

### Q2:切分规则——已固化 vs 活动区

切分规则(Claude Code 的做法):
- **`<Static>` items = 已固化消息**(`isFinal=true` 的消息,包括已固化的 assistant 消息、tool 结果等)
- **活动区 = 正在流式输出的内容 + spinner + footer**

Claude Code 的 `src/screens/REPL.tsx:4506-4509`:
```ts
const usesSyncMessages = showStreamingText || !isLoading;
const displayedMessages = usesSyncMessages ? messages : deferredMessages;
```
流式期间,`messages`(包含最新固化消息)直接传给 `<Static>`,streamingText(正在流式的内容)传给活动区。

**具体切分**:
```tsx
// 已固化消息 → <Static>(写进 scrollback,不再重写)
<Static items={finalizedMessages}>
  {msg => <Message key={msg.id} message={msg} />}
</Static>

// 活动区(每帧重写)
<Box flexDirection="column">
  {streamingText && <StreamingMarkdown text={streamingText} />}
  {spinnerVisible && <SpinnerLine view={spinnerView} />}
  <Box borderStyle="round">{border}</Box>
  <TextInput value={inputText} cursor={cursor} />
  {suggestionsVisible && <SuggestionList ... />}
  {statusText && <StatusLine text={statusText} />}
</Box>
```

**流式文本在活动区的原因**:它每秒变化多次(每 token 到达时),放进 `<Static>` 会导致每帧都追加新 item,`<Static>` 的 `fullStaticOutput` 无限增长。活动区的 `eraseLines(previousLineCount)` 能正确擦除和重写。

**消息固化的时机**:当 streamingText 结束(`isFinal=true`),消息从活动区移到 `<Static>`。Claude Code 的 `src/utils/messages.ts:2976-2979` 在同一微任务内清空 streamingText 并追加固化消息:
```ts
onStreamingText?.(() => null)  // 清空活动区
onMessage(message)              // 追加到 <Static>
```
确保渲染时活动区高度减少(streaming 消失)和 `<Static>` 增加(新消息)是原子的,不会出现中间态。

### Q3:`eraseLines(previousLineCount)` 在活动区高度不稳定时是否会出错?——不会

`eraseLines(previousLineCount)` 的语义是"擦除上一帧写入的所有行",不管当前帧高度是多少。

**具体流程**:
```
帧 1: 活动区 3 行 → write(3 行内容) → previousLineCount=3
帧 2: 活动区 5 行 → eraseLines(3) 擦掉帧 1 的 3 行 → write(5 行内容) → previousLineCount=5
帧 3: 活动区 1 行 → eraseLines(5) 擦掉帧 2 的 5 行 → write(1 行内容) → previousLineCount=1
```
每次擦除的是"上一帧写了多少行",不是"当前帧有多少行"。**所以高度变化是安全的**。

但有一个**边界条件**:当活动区高度减少时(比如 suggestion 列表关闭),擦除行数 > 新内容行数,多擦的行会露出空白。stock Ink 的 `log-update` 通过在写入后追加 `\n` + 空行来填充,或者依赖终端的自动换行。Claude Code 的 forked Ink 在 `src/ink/ink.tsx:644-649` 用 `ERASE_SCREEN` 处理这种情况:
```ts
if (this.needsEraseBeforePaint) {
  this.needsEraseBeforePaint = false;
  optimized.unshift(ERASE_THEN_HOME_PATCH);
}
```

MiCode 的 `cursorToTop` / `footerHeight` 账本在 stock Ink 路径下**不需要了**。stock Ink 的 `previousLineCount` 自动追踪上一帧行数。但需要确保 patch 中的 `renderInteractiveFrame` 正确使用 `outputHeight` 而不是手动计算。

### Q4:`<App>` 是否应该按 `isInline` 分支?——是

应该分支。原因是 `<ScrollBox>` 和 `<Static>` 的语义完全不同:

|  | alt-screen(`<ScrollBox>`) | inline(`<Static>`) |
|---|---|---|
| 已固化消息 | 存在 ScrollBox 内部缓冲区 | 写进 stdout(进 scrollback) |
| 滚动 | ScrollBox 管理虚拟滚动 | 终端原生 scrollback |
| 重绘范围 | 整个 viewport | 只有活动区 |
| 光标管理 | alt-screen 归零(CSI H) | main-screen 保持上一帧位置 |

Claude Code 的做法:`src/ink/components/App.tsx` 通过 `altScreen` prop 切换行为,但组件树结构基本一致。关键区别在渲染管线层面(`ink.tsx` 的 `altScreenActive` 分支),不在组件层面。

**MiCode 的建议**:
```tsx
function App({ isInline, ... }) {
  return (
    <Box flexDirection="column">
      {isInline ? (
        <>
          <Static items={finalizedMessages}>
            {msg => <Message key={msg.id} message={msg} />}
          </Static>
          <ActiveArea />  {/* streaming + spinner + footer */}
        </>
      ) : (
        <>
          <ScrollBox>
            {allMessages.map(msg => <Message key={msg.id} message={msg} />)}
          </ScrollBox>
          <Footer />
        </>
      )}
    </Box>
  );
}
```

**共享的子组件**(`<Message>`、`<SpinnerLine>`、`<StatusLine>`、`<TextInput>`)不需要分支——它们返回 React 元素,由 Yoga 算布局,Ink 管渲染。**分支只在顶层容器**。

---

## 第二轮答案的核心结论

**4 个问题的答案指向同一个结论**:stock Ink 7.1.0 的 main-screen 支持足够用,**不需要移植 Claude Code 的 fork**。需要做的是:

1. **修改 patch**:让 inline 模式走 `renderInteractiveFrame`,不跳过。修复 `outputHeight` 追踪逻辑(用双缓冲的 `frame.screen.height` 替代简单计数器)
2. **用 `<Static>` 包裹已固化消息**:流式文本在活动区,固化后移到 `<Static>`
3. **`eraseLines(previousLineCount)` 自动处理高度变化**:不需要手动账本
4. **`<App>` 按 `isInline` 分支**:inline 用 `<Static>` + 活动区,alt-screen 用 `<ScrollBox>`

---

## 第三轮核查:Claude Code Q1 论断被 stock Ink 源码**证伪**

### Claude Code Q1 的核心论断

> stock Ink 7.1.0 没有双缓冲——它用 `outputHeight` 追踪上一帧行数。当内容高度变化时,`outputHeight` 的更新时机和 `eraseLines` 的执行时机之间的竞态会导致擦除行数不对。**这就是当初绕开 Ink 的根本原因**。

### 直接核查 stock Ink 7.1.0 的 `log-update.js`

`node_modules/ink/build/log-update.js` 有**两套实现**:

**1. `createStandard`(line 7-104)** — 全量擦写:
```js
const render = (str) => {
  // ... hasChanges 短路:str !== previousOutput 则跳过(line 30)
  const lines = str.split('\n');
  stream.write(returnPrefix +
    ansiEscapes.eraseLines(previousLineCount) +   // 擦上一帧行数
    str + cursorSuffix);
  previousLineCount = lines.length;                // 同步更新(同一调用栈内,无竞态)
};
```

**2. `createIncremental`(line 105-245)** — **行级 diff**(更高级):
```js
for (let i = 0; i < visibleCount; i++) {
  if (nextLines[i] === previousLines[i]) {
    // 行内容相同 → 跳过(cursorNextLine 即可,不重写)
    buffer.push(ansiEscapes.cursorNextLine);
    continue;
  }
  buffer.push(ansiEscapes.cursorTo(0) + nextLines[i] + ansiEscapes.eraseEndLine + ...);
}
// 行数减少 → eraseLines(previousVisible - visibleCount + extraSlot) + cursorUp
// 行数增加 → cursorUp + 重写
```

**`createIncremental` 做的事比 MiCode 的 InlineRenderer 更精细**:逐行比较内容,只重写变化的行;行数减少时精确删除多余行。

### 关键事实(代码可证)

1. **stock Ink 默认有"内容未变则跳过"短路**:`createStandard` 的 `hasChanges` 检查(line 16-19 + line 30)——`str !== previousOutput || cursorChanged` 才进入写入路径。**这正是 MiCode 的 `prevFrameSnapshot` 在重做的事**,stock Ink 已经实现。

2. **stock Ink 默认有"行级 diff"**:`createIncremental`(line 105-245)逐行比较 `nextLines[i] === previousLines[i]`,只重写变化行。**这比 MiCode 的 InlineRenderer 更精细**(后者是整行 overwriteLine,不做行内容比较)。

3. **没有"双缓冲竞态"**:`previousLineCount`(standard)或 `previousLines`(incremental)是闭包变量,在同一个 `render(str)` 调用内先 `eraseLines(previousLineCount)` 再更新 `previousLineCount = lines.length`。**同一个调用栈内,没有异步竞态**。

4. **`incrementalRendering` 默认 false**(`node_modules/ink/build/render.js:17`),但**可以通过 options 开启**(`ink.js:218`)。开启后 Ink 自动用 `createIncremental`。

### Claude Code Q1 论断的问题

- Claude Code 说"stock Ink 没有双缓冲,有竞态" → **被 stock Ink 源码证伪**。`previousLineCount` 在同一调用栈内同步更新,没有竞态。
- Claude Code 说"stock Ink 用简单 outputHeight 计数器" → **不完整**。standard 模式确实只用计数器,但 incremental 模式用 `previousLines` 数组(完整行内容快照)。
- Claude Code 说"高度变化时擦错" → **被证伪**。`eraseLines(previousLineCount)` + 同步更新计数器 = 正确擦除上一帧行数,与当前帧高度无关。

### 为什么 MiCode 当初绕开 Ink?

Claude Code Q1 给的"竞态"理由不成立。真正的可能原因(我的推测):

1. **历史原因**:MiCode 的 InlineRenderer 是在 stock Ink 7.x 还没成熟时(或作者不熟悉 `<Static>` + `incrementalRendering` 时)写的,走了"自己实现更可控"的路。
2. **spinner 在 footer.lines 里需要定制位置**:stock Ink 不知道"spinner 在 footer 顶部,其他行不动"这种布局意图,只会整行 diff——但这其实正是 incremental 模式的强项,不是绕开的理由。
3. **`<Static>` 与流式文本交互复杂**:Q2 答案说"流式文本在活动区,固化后移到 `<Static>`",这需要 messagesStore 的状态机改造,**不是简单的"用 `<Static>` 就行"**。

### 最终结论(代码事实支撑)

**stock Ink 7.1.0 的能力足够**:
- `<Static>` 组件 → 已固化消息进 scrollback
- `createIncremental` → 行级 diff,只重写变化行
- `hasChanges` → 内容未变则跳过
- `setCursorPosition` → 光标定位

**MiCode 的 InlineRenderer 实际上是重复实现了 stock Ink 已有的能力,而且实现得更糟**(没有行级 diff、没有 `<Static>` 累积、需要手动 `cursorToTop`/`footerHeight` 账本)。

**方案 A(改架构)的技术可行性已经被代码核查完全证实**,工作量集中在:
1. 修改 Ink patch(让 inline 不跳过 `renderInteractiveFrame`,开启 `incrementalRendering`)
2. `<App>` 按 `isInline` 分支(inline 用 `<Static>` + 活动区)
3. messagesStore 切分已固化/活动区
4. 删除 InlineRenderer

**预估 1 周左右**,主要在回归测试。

---

## 第四轮:POC 实测验证(`scripts/ink-poc/poc-inline-diff.tsx`)

### POC 设计

写最小 Ink 程序,场景模拟 MiCode inline 渲染:
- `<Static items={finalizedMessages}>` 包 3 行已固化消息
- 活动区:`<Spinner time={time}>(memo)` + `<FooterLine>(memo)` + `<Text>❯</Text>` + `<FooterLine>(memo)` + `<StatusBar>(memo)`
- `setInterval(50ms)` 模拟 spinner tick(12 次/秒)
- Mock stdout 捕获所有写入
- `render(<App />, { stdout, incrementalRendering: true, isTTY: true })`
- 跑 600ms(12 个 tick)后分析

### POC 结果(决定性证据)

| 帧 | 字节 | Static? | Spinner? | Footer? | StatusBar? | 解读 |
|---|---|---|---|---|---|---|
| 0 | 8B | - | - | - | - | BSU `\e[?2026h` |
| 2 | **120B** | **✅** | - | - | - | **Static 一次性写 3 行** |
| 3 | 6B | - | - | - | - | hideCursor |
| 4 | **412B** | - | ✅ | ✅ | ✅ | **活动区首次完整写** |
| **7** | **44B** | - | ✅ | **❌** | **❌** | spinner tick 50ms,**只重写 spinner 行** |
| **10** | **45B** | - | ✅ | **❌** | **❌** | spinner tick 100ms,**只重写 spinner 行** |
| 13 | 46B | - | ✅ | ❌ | ❌ | spinner tick 150ms |
| 16 | 46B | - | ✅ | ❌ | ❌ | spinner tick 200ms |
| 19 | 46B | - | ✅ | ❌ | ❌ | spinner tick 250ms |
| ... | ... | | | | | |

### POC 验证的三个核心假设(全部通过)

**1. `<Static>` 一次性写入 scrollback** ✅
帧 2(120B)写了 3 行 Finalized 消息,**之后所有 spinner tick 都没再写 Static 内容**。Static 行进了 stdout 流,后续不被擦写。这正是 inline 模式需要的 scrollback 语义。

**2. `createIncremental` 行级 diff 有效** ✅
每个 spinner tick(帧 7/10/13/16/19...)只写 **44-46 字节**,而完整活动区是 412 字节。**Spinner 行变了,但 footer border 和 statusbar 没被重写**。每 tick 写入减少 **~89%**。

**3. React 重渲染 + Ink 行级 diff 组合** ✅
虽然 React 在 spinner tick 时重渲染了整个活动区(POC 未深测 memo 拦截),但 **`createIncremental` 在 React 重渲染后通过 `nextLines[i] === previousLines[i]` 行内容比较跳过了未变行**——这是关键。memo + Ink diff 双层保险。

### POC 暴露的额外事实

每个 spinner tick 实际触发 3 次 stdout write:
- 2 × 8B 控制符(BSU `\e[?2026h` + ESU `\e[?2026l`,原子更新包装)
- 1 × 实际内容(44-46B)

MiCode 的 `InlineRenderer` 也在做同样的事(`writeBuf` + BSU/ESU)。Ink 的实现与 MiCode 一致,但更精细(行级 diff)。

### POC 结论

**stock Ink 7.1.0 + `incrementalRendering: true` + `<Static>` + `memo()` = 完整解决 MiCode inline 模式的所有问题**:

- ✅ 已固化消息进 scrollback(`<Static>`)
- ✅ spinner tick 不重写未变行(行级 diff)
- ✅ 不需要手动 `cursorToTop`/`footerHeight` 账本(Ink 自动管)
- ✅ 不需要手动 BSU/ESU(Ink 自动加)
- ✅ 不需要 `useThrottledStreamingText`(Ink reconciler 自动合并多个 setState 到一帧)

**方案 A 的核心假设全部通过 POC 验证**,可以正式写设计文档。

---

## 第五轮:Claude Code 对设计方案的 6 个 review 问题

Claude Code 在评审设计方案时提出 6 个问题(2 个实质性、4 个优化)。以下是代码事实核查。

### 问题 1(优化):`<Footer>` 仍接收 `spinnerStore` prop

**Claude Code 担心**:第 3.5 节 Q&A 说"Footer 不再接收 spinnerView",但第 3.4 节代码仍传 `spinnerStore`。多余 prop 会让 memo 依赖变大。

**事实核查**:`<Footer>`(alt-screen 版本)当前**确实**在用 spinnerStore——通过 `<SpinnerWithVerb view={spinnerView} />` 渲染 spinner 行。但 V2 设计中 spinner 是 `<Footer>` 的**兄弟**(在 `<App>` 顶层),不是 `<Footer>` 的子。

**结论**:**V2 路径下 `<Footer>` 完全不需要 spinner 相关 prop**。设计文档需要明确:
- V2 `<Footer>` props 清单:`{ input, cursor, status, cols, inputRowY, viewportTop, completionStore, selectionStore }`
- 不含 `spinnerView` / `spinnerStore`
- alt-screen 模式 `<Footer>` 不变(仍接收 `spinnerView`,作为内部 `<SpinnerWithVerb>` 的输入)

### 问题 2(实质性):cursor 定位策略

**Claude Code 担心**:V2 不注入 `options.renderer`,`onSetCursorPosition` 回调不会被调用,Ink 如何定位 cursor?

**事实核查**:**Claude Code 这个担心基于误解**。

`onSetCursorPosition` 是 **MiCode 自研双缓冲 renderer 的桥**(patches/ink+7.1.0.patch 第 6 行),只在 alt-screen + USE_DOUBLE_BUFFER 时用。它不是 Ink 主路径的 cursor 机制。

stock Ink 的 cursor 定位机制完全独立:
- **`useCursor()` hook**(`node_modules/ink/build/hooks/use-cursor.js`):通过 `CursorContext` 把 cursor position 传给 log-update
- **`CursorContext`**(`node_modules/ink/build/components/CursorContext.js`):根组件 `<App>` 提供,内部调 `this.log.setCursorPosition(position)`
- **log-update** 接收 cursor position,在每次写入时附加 `buildCursorSuffix`(把 cursor 移到指定坐标)

**MiCode 现有 `<Footer>` 已经在用 `useCursor()`**(`src/tui/components/Footer.tsx:43`):
```tsx
const { setCursorPosition } = useCursor();
const pos = cursorScreenPos(input, cursor, PROMPT);
setCursorPosition({ x: pos.x, y: inputRowY + (pos.y - viewportTop) });
```

**结论**:**V2 路径 cursor 定位完全工作,不需要额外改造**。MiCode 现有 `<Footer>` 的 `useCursor()` 代码原样复用。`onSetCursorPosition` 只用于 alt-screen 自研 renderer,V2 不涉及。

### 问题 3(优化):`<Static>` 与 `incrementalRendering` 的交互

**Claude Code 担心**:POC 没验证 `<Static>` 在 `incrementalRendering: true` 下的行为。

**事实核查**:**POC 实际上已经验证了这个场景**。

`scripts/ink-poc/poc-inline-diff.tsx` 就是 `incrementalRendering: true`(代码第 232 行)+ `<Static items={finalizedMessages}>`(代码第 209 行)。POC 结果:
- 帧 2(120B)写了 `<Static>` 3 行 Finalized 消息
- **后续所有 spinner tick 都没有再写 Static 内容**
- spinner tick 时只写 spinner 行(44-46B)

**结论**:`<Static>` 与 `incrementalRendering` **完全兼容**。`<Static>` 通过 `internal_static` 标记被 reconciler 识别,输出走 `staticOutput` 通道(独立于 `output`),与 `incrementalRendering` 的行级 diff 互不干扰。

### 问题 4(实质性):`finalizeStreaming` 原子化是否需要改 store?

**Claude Code 担心**:第 4 节阶段 4 说"改 `messagesStore.finalizeStreaming` 确保同一 set() 调用内完成",但之前说"messagesStore 数据结构本身不改,只改消费方式"。矛盾。

**事实核查**:**`finalizeStreaming` 已经是原子的**,不需要改 store 实现。

`src/tui/state/messages-store.ts:165-181`:
```ts
finalizeStreaming: (lines) => set((s) => {
  const last = s.messages[s.messages.length - 1];
  if (!last || last.finalized) {
    // 无流式消息:当作普通 append
    const id = s._idCounter + 1;
    return {
      _idCounter: id,
      messages: [...s.messages, {
        uuid: `msg-${id}`, role: 'assistant', lines, finalized: true,
      }],
    };
  }
  // 有流式消息:同一个 set() 内完成"剥离 streamingText + 标记 finalized + 写 lines"
  const { streamingText: _removed, ...rest } = last;
  void _removed;
  const updated: TuiMessage = { ...rest, lines, finalized: true };
  return { messages: [...s.messages.slice(0, -1), updated] };
}),
```

**结论**:**store 实现已经原子化**,设计文档第 4 节阶段 4 的描述应改为"**确认** finalizeStreaming 原子性(已实现),不需要改 store"。

### 问题 5(优化):`useThrottledStreamingText` 删除时机

**Claude Code 担心**:Ink 的 16ms throttle 是 `scheduleRender` 的 throttle,不是 React batching。LLM token 到达间隔若跨越多个微任务(每个 SSE event 独立微任务),不会被 React 自动合并。

**事实核查**:**Claude Code 方向正确,但具体数值有误**。

- Ink 默认 `maxFps: 30`(`node_modules/ink/build/render.d.ts:62`),即 **33ms throttle**(不是 16ms)
- Ink 的 throttle 在 `ink.js:205-236` 实现:`throttle(this.onRender, renderThrottleMs, { leading: true, trailing: true })`
- React 19 concurrent 模式下,**同一个微任务内的多次 setState 会被合并**,但**跨微任务的 setState 不会**

**LLM token 到达频率实测**:Anthropic SSE 通常每 10-50ms 一个 token event。token 间隔 > 33ms 时 Ink throttle 够用;token 间隔 < 33ms 时(快速流式),Ink 33ms throttle 合并到 ~30fps,可能仍有"打印机感"。

**结论**:**Claude Code 建议正确**——不要急着删 `useThrottledStreamingText`。
- 设计文档第 4 节阶段 4 改为"**保留** `useThrottledStreamingText`,实测后再决定"
- 如果 Ink 33ms throttle 在实际场景下流畅(用户主观感受),则 V0 删除时一起删
- 如果仍有打印机感,保留节流层(它不冲突,只是冗余)

### 问题 6(优化):阶段 5"默认开启"时机

**Claude Code 建议**:把阶段 5 拆成 5a(边界场景 + 默认开启)和 5b(V0 删除)。

**结论**:**建议合理**,设计文档应调整阶段 5 结构:
- **5a**:边界场景处理(Select/Overlay/Resize/鼠标/ESC/长输入)+ 真实用户测试 → 完成后**默认开启 V2**
- **5b**:V0 删除 → 在 V2 默认开启**稳定 1-2 周后**执行

这个拆分让"默认开启"和"删除 V0"成为独立决策点,降低风险。

---

## 第五轮结论

6 个问题全部基于代码事实给出答案:

| 问题 | 类型 | 结论 |
|---|---|---|
| 1. Footer props | 优化 | V2 路径下 `<Footer>` 不需要 spinner 相关 prop,设计文档需明确 |
| 2. cursor 定位 | 实质性 | **MiCode 现有 `useCursor()` 完全可用,不需要改造**(Claude Code 误解了 `onSetCursorPosition` 的作用) |
| 3. Static + incrementalRendering | 优化 | **POC 已经验证**(incrementalRendering: true + `<Static>` 共存,Static 只写一次) |
| 4. finalizeStreaming 原子化 | 实质性 | **store 已经是原子的**,不需要改实现 |
| 5. useThrottledStreamingText 删除 | 优化 | **保留**,实测后再决定(Ink 默认 33ms throttle,可能不够) |
| 6. 阶段 5 拆分 | 优化 | **拆为 5a/5b**,默认开启和 V0 删除独立决策 |

**两个实质性问题的答案都是"不需要改"**(cursor 定位 + store 原子化),方案 A 的工作量不变。
