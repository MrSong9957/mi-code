# Ink 渲染层迁移进度（feat/ink-rewrite 分支）

## 目标
按 AGENTS.md 新 charter，用 React19+Ink7+Yoga 替换手写 ANSI 渲染栈，对标 Claude Code。
footer 紧贴（flexbox 副产品）+ ScrollBox 虚拟滚动 + Markdown 流式 + alt screen。

## 当前分支状态
- 分支：`feat/ink-rewrite`（从 master a498e0a 开出，当前目录直接开分支，未用 worktree）
- 工作区有大量预存改动（会话开始前就存在的，非迁移产物）
- 提交链（本分支独有）：
  - `b963400` feat(tui): Phase 0-4（脚手架/数据层/骨架/输入/store 桥）
  - `b0006eb` feat(tui): Phase 5-6（Markdown 渲染 + ScrollBox 虚拟滚动）
  - `fe5fc14` feat(tui): Phase 7 准备（bootstrap + ConnectedApp + statusStore）

## 已完成 Phase（7.5/10）
- ✅ Phase 0：脚手架（react19/ink7/marked/cli-highlight/zustand5 + ink-testing-library；tsconfig jsx:react-jsx；src/tui/ 骨架）
- ✅ Phase 1：数据层解耦（block-pipeline 去 renderer/cell.js 依赖，Style→UIMessageStyle；block-pipeline.print 按 kind 透传 role）
- ✅ Phase 2：前端骨架（App/Footer/MessageRow/StatusBar + useTerminalSize + useAltScreen；footer 紧贴 TDD 过）
- ✅ Phase 3：输入（input-store zustand vanilla + useInputHandler；Ink Ctrl+letter 契约：input===字母+key.ctrl）
- ✅ Phase 4：store 桥（messages-store + PipelineToStoreAdapter 实现 PipelineRenderer + 端到端集成）
- ✅ Phase 5：Markdown（render-markdown.tsx marked.lexer→Ink Text + StreamingMarkdown 稳定/不稳定分段缓存）
- ✅ Phase 6：ScrollBox（scroll-state + mouse-wheel SGR 解析 + ScrollBox 虚拟滚动自动跟随 + ?1000h/?1006h）
- ✅ Phase 7 准备：bootstrap + ConnectedApp + statusStore

测试：116 个新 TUI 测试全过（types13/input13/layout4/hooks5/handler7/store9/adapter10/e2e6/render-markdown11/streaming6/scroll-state15/mouse-wheel6/scrollbox4/status7）。
typecheck/build 干净。master 全量 950 绿；feat 全量 1204 绿（history.test.ts 偶发 flaky 是预存 async 竞态，与迁移无关）。

## 新建文件（src/tui/）
- types.ts（TuiMessage + styleToInkProps 语义→Ink 映射）
- App.tsx（顶层 flexbox）+ ConnectedApp.tsx（stores 接线）
- components/{Footer,MessageRow,StatusBar,ScrollBox,scroll-state}.tsx
- hooks/{useTerminalSize,useAltScreen}.ts
- input/{use-input-handler,mouse-wheel}.ts
- markdown/render-markdown.tsx + streaming/streaming-markdown.tsx
- state/{input-store,messages-store,status-store,pipeline-adapter}.ts
- bootstrap.tsx（装配 + render + cleanup）

## 剩余 Phase
### Phase 7 主体：重写 src/index.ts（高风险，surgical map 已完整）
**已完成的 explore 报告**给出精确手术图（见对话历史）。要点：
- 删 imports L20（UILayout）、L22-25（ansi 原语）
- 删 L156-200（UILayout/旧 pipeline adapter/printLine/printStyled）→ 改用 bootstrap()
- 删 L249-428（scroll mode + ctrl+o overlay）
- 删 L436-942（stdin/handleInput）→ useInputHandler 接管
- **但 L563-872 Enter 块的 agent 驱动逻辑必须迁移到 bootstrap 的 onSubmit 回调**：
  - pending question 处理（askManager.hasPending → resolve）
  - /approve //reject 特判
  - 命令解析（skill/trigger/y/n/edit/plan/build/auto）
  - agent loop 触发（streamingQuery + pipeline.emit 全保留）
- L972 layout.enter() → bootstrap({status, onSubmit, onExit})
- L1010-1013 resize listener 删（useTerminalSize 接管）
- L1016-1022 cleanupOnExit：layout.exit()→handle.cleanup()；保留 resume hint（exitAltScreen 后写）
- rewire ~15 个 status/spinner 调用：layout.setStatus→statusStore.setStatus；startSpinner→statusStore.startSpinner；setHint→statusStore.setHint 等
- rewire ~6 个 exit 调用：layout.exit()→handle.cleanup()
- **关键：所有 pipeline.emit 调用零改动**（PipelineToStoreAdapter 透明路由）

**循环依赖处理**：askManager(L211) 依赖 printLine+layout.setHint，但 bootstrap 在 L972。
解法：用前向声明 `let tui: BootstrapHandle` + 延迟绑定 setHint/printLine，或把 bootstrap 提前。
推荐：`let tuiHandle: BootstrapHandle | null = null`，askManager 的 setHint 用 `(s) => tuiHandle?.statusStore.getState().setHint(s)`。

### Phase 8：清理旧栈
- 删 src/renderer/ 全部 17 文件
- 删 src/ui/{ui-layout,message-formatter,content-region}.ts（保留 types.ts、block-pipeline.ts、block-format.ts、expandable-store.ts）
- 删旧 renderer 测试 ~12 文件（main-screen*.test.ts、screen/virtual-screen/cell/diff/frame-scheduler/ansi/spinner/status-bar.test.ts、ui-layout.test.ts、layout.test.ts、highlight.test.ts）

### Phase 9：验证
- npm test/typecheck/build/lint 全过
- 手动 E2E：node dist/index.js → alt screen + banner 紧贴 + footer 紧贴 → 输入 → 流式 Markdown → 工具配对 → 滚轮翻 ScrollBox → resize → Ctrl+C 干净退出

## 关键技术约束（踩过的坑）
1. **Ink Ctrl+letter 契约**：useInput 对 Ctrl+A 收到 input='a'+key.ctrl=true（不是 \x01）。parse-keypress.js 把 \x01 翻译成 name='a'+ctrl。
2. **ink-testing-library 不接受 stdout 参数**：用其内部 Stdout（columns=100），frames 捕获 write。hook 副作用（alt screen 序列、鼠标追踪）会出现在 frames。
3. **zustand v5**：vanilla `createStore`（测试 getState）+ react `useStore`（组件订阅）。store 实例可跨测试/组件共享。
4. **ScrollBox 自动跟随必须同步**：不能靠 useEffect 异步 setState，用 `effectiveScrollTop = userScrolledAway ? raw : maxScroll` 在 render 时算。
5. **marked v18**：`lexer(text)` 返回 Token[]，Tokens 命名空间下有各 token 接口；table/list 元素 map 回调要显式标类型（`as Tokens.List`）。
6. **history.test.ts flaky**：预存 async 文件写入竞态，master 全量也偶发，非迁移缺陷。
7. **CJK 光标错位（Phase 8 删旧 renderer 时丢失的修复，2026-07-06 修复）**：
   Ink Footer 用 `setCursorPosition({ x: PROMPT_WIDTH + cursor })`，其中 `cursor` 是 input-store 的**码点索引**（`[...str].length`，编辑器语义正确）。但 x 是**显示列**——CJK 全角字符（汉字/emoji）码点=1 但显示宽=2，导致光标每遇一个汉字少算 1 列，落在字符中间把字一分为二。
   **正确做法**：用 `string-width` 量「光标前文本」的显示宽度，绝不能把码点索引当列用。多行时按 `\n` 分割逐行算 `(x,y)`。已抽到 `src/tui/state/cursor-position.ts` 的 `cursorScreenPos(input, cursor, prompt)`。
   参照：Ink `useCursor()` README 官方示例 + 旧 `renderer.ts:computeInputCursorPos()`（commit a01c965 修过，6618e79 删 renderer 时丢）。
   **教训**：凡涉及「终端列坐标」的计算，必须走显示宽度（string-width），不可用 JS 字符串长度或码点数。
8. **自研双缓冲渲染（2026-07-06，二期落地，feat/double-buffer-render 分支）**：
   - **Fork Ink 7**：`patch-package` 暴露 `options.renderer` 注入点（`patches/ink+7.1.0.patch`）。保留 React/DOM/Yoga/输入端（useInput/useCursor/useFocus），重写输出端（renderer/screen/output-ops/yoga-walk/diff/optimizer/emit）。
   - **patch 的关键坑**：Ink 原生 `render(node, isScreenReaderEnabled: boolean)` 第二参是布尔，不是 options 对象。fork 必须**分支**：提供 `options.renderer` 时调自研 `(node, {width,height,...})`；不提供时**原样**调原生 `(node, boolean)`。若用 `rendererFn || render` 单表达式，fallback 路径会把 truthy 对象当布尔传，触发 screen-reader 路径，**全屏错乱**。
   - **数据结构**：`Int32Array` cell 网格（每 cell 2×Int32 = charId + encodedStyleId），跨帧累积池子（CharPool ASCII 快速路径 + StylePool transition 缓存），每 5 分钟 resetPools + ID 迁移。
   - **styleId 编码纪律**（最易返工，spec §3.6）：Int32Array 存编码值（`poolId << 1 | fullWidthFlag`），Patch 存解码后的纯 poolId + 独立 `isFullWidthContinuation` 布尔。`output-ops.blit`/`blitAnsi` 是编码值**唯一生产点**（铁律 4，grep 验证）。
   - **Ink DOM 文本提取（最易踩坑）**：real Ink DOM 用 `<#text>` 子节点 + `nodeValue`（DOM 规范），`<ink-text>`/`<ink-virtual-text>` 包裹。**不是** `node.textValue`（那是 mock 简化）。`yoga-walk.squashTextNodes` 必须按 Ink 的 `squash-text-nodes.js` 算法递归。Task 9 初版误用 textValue，导致**全屏空白**（commit `46d8a9c` 修复）。
   - **颜色在文本里，不在 node.style**：Ink `<Text color="red">` 在布局**前**调 `colorize()` 把颜色作为 **ANSI 字节嵌入文本**（`\x1b[38;2;255;0;0m...\x1b[39m`）。`node.style` 只存布局属性（margin/padding）。故 `blitAnsi` 用 `@alcalzone/ansi-tokenize` 解析嵌入 ANSI 重建每字符 Style——**不要**去 node.style 找 color。
   - **全角字符**（CJK/emoji）占 2 cell：head cell 存字符，tail cell（续位）存同 charId + styleId 但 `fullWidthFlag=1`，emit 时跳过字符输出（head 已写完整字符，终端自动覆盖续位）。
   - **cursor 绝对定位** `\x1b[<y+1>;<x+1>H`（项目自管 alt-screen，不依赖 Ink 相对底部模型）；每帧开头 reset 样式（混合 stdout 流量——alt-screen/鼠标/kitty——可能改 cursor，不能假设帧间状态）。
   - **DEC 2026 同步输出**由 emit 自己包裹（不再依赖 Ink throttledLog）。
   - **feature flag** `MICODE_DOUBLE_BUFFER=0` 秒回滚 Ink 原生（默认开）。
   - **性能基准**（2026-07-06）：1000 cell 全新帧 7ms、无变化帧 1ms（200×50 屏幕），远低于 30 FPS 帧预算。
   - 参照：Claude Code 的 Ink fork（保留上游 + 重写输出端的 renderer/screen/log-update/optimizer）。spec：`docs/superpowers/specs/2026-07-06-double-buffer-render-design.md`；plan：`docs/superpowers/plans/2026-07-06-double-buffer-render.md`。
9. **Windows PowerShell「一闪而过」+ LOGO 位置漂移（2026-07-07，3 个叠加 bug，systematic-debugging 5 次失败后定位）**：
   - **bug A（一闪而过）**：Ink 的 `shouldClearTerminalForFrame`（ink.js:100-101）在 **Windows** 上只要 `isFullscreen=true` 就触发 `clearTerminal`，产生 stderr 字节 → **PowerShell 的 `NativeCommandError`**（子进程 stderr 有内容就报错）→ 杀进程。修复：renderer 返回 `outputHeight: 0`（让 Ink 不判 fullscreen）+ `patchConsole: false`（console.* 不路由到 Ink 的 writeToStderr）。
   - **bug B（画面漂到底部）**：Ink 的 `renderInteractiveFrame`（ink.js:773）在 `outputHeight=0` 时算 `outputToRender = output + '\n'`，然后 `throttledLog('\n')` 往 stdout 写换行 → 每帧把光标往下推一行 → 画面漂到底部。修复：patch 第 3 个 hunk——`options.renderer` 提供时跳过整个 `renderInteractiveFrame`（自研 renderer 已直写 stdout）。
   - **bug C（LOGO 跟光标位置）**：Ink 的 `enterAlternativeScreen`（ansi-escapes/base.js:132）只发 `\x1b[?1049h`（切备用屏），**不发 `\x1b[H`（光标归位）** → alt screen 光标停在用户输命令的位置 → renderer 从那画。之前提前发 `?1049h` 被 Ink constructor 的第二次 `?1049h` 清掉。修复：patch 在 Ink `setAlternateScreen` 内部、发完 `?1049h` 后立即补 `\x1b[H`。
   - **教训**：① PowerShell 的 `NativeCommandError` 是 Windows 独有陷阱——子进程往 stderr 写**任何东西**（哪怕是 ANSI cursor 序列、Ink 内部输出、诊断日志）都会触发，把进程杀掉。在 Windows 上跑 TUI 必须确保**零 stderr 输出**。② Ink fork 不能只 patch renderer 注入点——必须同时堵住 `renderInteractiveFrame`（它会往 stdout 写额外字节干扰自研 renderer）和 `setAlternateScreen`（补光标归位）。③ 自研 renderer 返回 `outputHeight: 0` 是双刃剑——避免 clearTerminal，但 Ink 仍会走 `throttledLog` 路径，必须跳过。④ systematic-debugging 的诊断代码也要注意——`require('fs')` 在 ESM 下的行为、`appendFileSync` 的 cwd 问题、诊断本身往 stderr 写触发 PowerShell 报错——诊断方法本身可能制造假象。⑤ 隔离验证（`node -e "..."` 单独测 alt screen 序列）比在完整 TUI 里加诊断更可靠——能排除 Ink 的干扰。

10. **字符级选区 + 右键复制踩坑（2026-07-07，feat/double-buffer-render，9 任务 TDD）**：
    - **CJK 钳位规则**：落全角字符中间时，start 向左钳到字符起点（保留该字符）、end 向右钳到字符终点。永不切坏字符，但选区可能比拖拽位置多半/少半个字符。两个循环条件不对称：startIdx 用 `start >= cs && start < cs+cw`（左含），endIdx 用 `end > cs && end <= cs+cw`（右含）——这样落在字符边界时该字符被选入正确一侧。
    - **L 型选择语义**：多行选区首行（anchor 所在）取 `[anchorCol, lineWidth]`、末行（focus 所在）取 `[0, focusCol]`、中间整行。**首末按 anchor/focus 的 row 决定，不是 min/max**——向上拖时 anchor 在下，向下拖时 anchor 在上，但语义一致。
    - **显示列↔码点转换 bug**（code review 抓到）：`selectWordAt` 旧循环 `if (acc >= col)` 在字符左边界触发，CJK 全角字符（宽 2）的右半格 col=1 会解析到下一码点。修复改用 cell-containment 测试 `if (col < acc + w)`。教训：ASCII only 的测试会漏 CJK bug，词边界相关测试必须含 CJK 用例。
    - **colsForRow vs sliceLineBySelection 字段名不匹配**：store 的 `colsForRow` 返回 `{start, end}`，但 `sliceLineBySelection` 期望 `{startCol, endCol}`。需 adapter `cols && { startCol: cols.start, endCol: cols.end }`。plan 自审漏了这处类型不一致，靠 TDD 红灯抓到。
    - **clipboard 三级回退顺序**：本地非 SSH/非 tmux → OS 命令；tmux → `load-buffer -w`（转发外层）；否则 → OSC52。**tier-1 guard 是 `!isSSH && !isTmux`**（不是 `!isSSH`）——tmux 环境即使本地也该走 load-buffer，否则 xclip 写的是内层 pty 剪贴板不传播到外层终端。env 检测放函数体内（非模块顶层）便于测试注入。
    - **writeClipboard 不再 throw**：旧实现 spawn 失败 reject；新实现每级 try/catch，永远落到 OSC52（tier-3 不抛）。下游调用方（ScrollBox 右键）仍保留 try/catch 作 belt-and-suspenders。
    - **vanilla zustand getState 不订阅**：ScrollBox 里 `const sel = selectionStore.getState()` 在 render body 是死代码——不触发重渲染。正确做法是 MessageRow 在 render 时 inline 调 `getState()`（每帧读最新值）。React 重渲染由父级 props 变化（messages 等）驱动，选区高亮随父重渲染刷新。
    - **vitest ESM mock**：`vi.doMock('child_process', ...)` + 动态 `import()` 需配 `vi.resetModules()` in beforeEach，否则首个测试的 mock 实例缓存进模块图，后续测试的 mock 不生效。
    - **拖拽自动滚动 stale closure**（spec §7 实现期验证点）：`maybeStartAutoScroll` 的 setInterval 闭包捕获 `effectiveScrollTop`，在 setScrollTop updater 内可能 stale。updater 用 `prev` 算新 scrollTop 正确，但 row→text 映射（getLineContentByRow）读闭包值，首次启动正确，长时间滚动可能偏移。预留 `getLineContentByRowSnapshot` seam 待修。
