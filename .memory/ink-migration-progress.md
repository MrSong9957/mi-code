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
