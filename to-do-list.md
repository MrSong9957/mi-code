<!--
  schema: agent-todo/v1
  statuses: [ ] todo [~] doing [x] done [-] cancelled
  priority: !!! urgent !! high ! low (无标记=normal)
  assignee: @name   tags: #tag
  id: AUTO-0001 (四位自增)
-->

# 核心规则：

- 状态由 checkbox 控制，任务变更状态时移动到对应分区
- 日志只追加不删改，保持时间线完整
- 备注用 > 缩进块，跟在任务行下方

---

# ⭐ 待办事项

## 进行中

（暂无）

## 待办

- [ ] AUTO-0005: 探索 Tip 机制
  > 调研输入提示/补全的交互方案
  > 注意：与 spinner 区域的 Tip（AUTO-0020，已实现）不同；本任务关注输入框 placeholder / ghost text / 自由文本补全，当前代码零实现。

## 已完成

- [x] AUTO-0001: 图片输入支持
  > 支持在输入中附加图片，作为多模态输入发送给模型。
  > 完成：`/image <路径>` 与 Windows 图片剪贴板读取均可构造 ImageBlock；魔数格式检测、3.75MB 校验、磁盘缓存、Anthropic/OpenAI/Google provider 发送及 resume 回填链路完整。AUTO-0027 经 brainstorming 确认为非必要便捷入口并取消，不阻塞父任务完成。
  > 依赖：AUTO-0026、AUTO-0028

- [x] AUTO-0025: AskUserQuestion 接入下拉选择菜单
  > AUTO-0006 原作答 UX 为纯文本输入。本任务重构 overlay 交互 + 固化结果结构化展示，分两 PR 完成。
  > 完成 PR1（`2882666`）：新建 `computeTabLayout` 纯函数（权重分配 + CJK 安全截断 + 极窄降级）；重写 `AskQuestionOverlayV2`（圆角边框 + suggestion 色 + 单选 ◉/◯ 多选 [x]/[ ] + 聚焦 ❯ + tabs 导航）。5 列宽/窄/极窄终端覆盖。
  > 完成 PR2（`8263009`）：解决回答提交后 tool_result 被当 Bash 折叠的痛点。meta 旁路双通道隔离——`StructuredAskResult` 走 UI 通道（`askOutcomeStore` set/take/sweep/clear + TTL），API 通道（`ToolResultBlock.content`）零污染（Task 15 三重证明）。渲染层 3 个 contract 修正：Answered 子项统一 `  ⎿ ` 前缀、assistant 续行缩进（统一走 `wrapStreamingText`）、agent-completion 块间距（删 `height={1}` + 补尾 `\n`）。新增 ConPTY 真实终端验收工具（`npm run test:tty`，node-pty + ANSI Screen 还原，12 项断言）。TDD 全程 RED→GREEN，影响域 245+ passed、全量 1971 passed（6 failed 全 pre-existing/flaky）。
  > follow-up（`b96516c`/`c52b173`/`5d1caae`）：code review 发现 `streamingQuery finally` 误调 `sweep()`（TTL 清理，对本 turn orphan 是 no-op）的生命周期契约错误，改调 `clear()`（turn 确定性清理）。补 spy 契约测试 + mutation 验证锁住 finally→clear 调用关系。
  > 依赖：AUTO-0006、AUTO-0007

- [x] AUTO-0030: 修复 end_turn 时 assistant 消息未持久化
  > AUTO-0028 实测时发现:resume 后 JSONL 只有 user 消息,0 条 assistant。根因 `src/agent/streaming-query.ts:255-258` 的 end_turn 提前 `return`,跳过了阶段 4 把 `assistantMessages` 合并进 `messages` 的步骤。所有以纯文本回复收尾的会话(绝大多数),最后一条 assistant 都丢失。day-1 bug(`ddb7725` 持久化功能引入时就在)。
  > 完成:在 end_turn return 前补一段 `if (assistantMessages.length > 0) messages = [...messages, { role:'assistant', content: assistantMessages.flatMap(m => m.content) }]`。新增 2 条集成测试(纯文本 end_turn + 多轮工具调用末尾 end_turn)到 `streaming-query.test.ts`,均 RED 验证 → GREEN。全量 1687 passed、tsc exit 0。

- [x] AUTO-0026: OpenAI / Google provider 发送图片
  > 补齐 OpenAI 与 Google 两家 stream client 的图片输入支持，对齐已实现的 Anthropic provider。
  > 完成：抽取 3 个共享 helper 到 `image-utils.ts`（`ensureImageData` mediaType+空 data 校验、`buildOpenAIImagePart` 拼 data URL、`buildGeminiInlineData` 纯 base64）；三家 client 统一接入空 data 防御（含 Anthropic 补漏）；修复 OpenAI client 原 `else if (textParts.length > 0)` 导致纯图片消息被完全丢弃的 bug，组装改为四分支；新增 helper 单测 14 条 + OpenAI/Google mock SDK 集成测试 4 条。49 个 agent 测试全过、tsc exit 0、grep `// image block:MVP 跳过` 零命中。

- [x] AUTO-0028: 会话恢复（resume）回填图片
  > resume 后历史消息中的 ImageBlock 从 cachePath 读回 base64，替换原 throw 兜底。
  > 完成：ensureImageData 新增冷路径，委托私有 rehydrateFromCache(existsSync + readFileSync + 0 字节校验)。三家 provider client 零改动,经 ensureImageData 统一受益。4 种错误路径(cachePath 缺失 / 文件不存在 / 0 字节 / 系统 EACCES 等)分级处理,前三种 throw 中文消息,系统错误不包装自然冒泡。改写 2 条原契约测试(去掉 /AUTO-0028/ 正则) + 新增 6 条回填测试(通用 + PNG/JPEG/GIF/WebP + 0 字节边界)。不引入缓存(YAGNI),不回写 block.data(保持无副作用)。55 个 agent 测试全过、tsc exit 0、全量 1678 passed。

- [x] AUTO-0029: resume 回显格式化（user 消息内容）
  > AUTO-0028 实测暴露：resume 后带图历史消息显示成 `(结构化内容)`，用户看不到自己当初发了什么。本任务把数组 content 转人类可读字符串。
  > 完成：新建 `src/utils/format-content.ts` 纯函数 `formatUserContentForResume`,text 原文 / image `[图片 <cachePath>]`(无 cachePath 降级 `[图片]`) / tool_use `[工具调用]` / tool_result `[工具结果]`,非空片段空格连接。接入 `src/index.ts:891` 替换 `(结构化内容)` 三元表达式。6 条单测覆盖字符串透传 / 纯 text / text+image / 无 cachePath 防御 / 空数组 / tool 混合。tsc exit 0、全量 1684 passed。

- [x] AUTO-0002: 斜杠命令体系
  > 实现 /command 交互方式，支持如 /help、/clear 等快捷指令
  > 完成：18 条命令（`parser.ts` 解析 + `executor.ts` 分发 + `suggestion-data.ts` 注册表 + `completion-store.ts` Fuse.js 模糊补全 + `SuggestionBar.tsx`/`DropdownOverlay.tsx` UI + TAB/方向键/Enter/Esc 交互）。

- [x] AUTO-0003: ESC 中断 LLM 连接和打断 spinner 动画
  > 按 ESC 可中断正在进行的 LLM 请求并停止加载动画
  > 完成：`use-input-handler.ts:150-166` 键盘监听 → `currentAbortController.abort()`（`index.ts:390`）→ Anthropic/OpenAI/Google 三家 stream client 绑定 signal → `finally` → `stopSpinner` 闭环；含双击 ESC 撤回 turn；单测 + e2e 覆盖（`e2e-stream-interrupt.test.tsx`）。

- [x] AUTO-0004: 修改 spinner 动画
  > 调整加载动画的样式或帧率
  > 完成：已被 AUTO-0009~0024 整体覆盖并完成（12 帧旋转序列、50ms 单调时钟、120ms 帧派生、字素级 shimmer、reducedMotion 静态圆点、stalled 渐变、thinking/tool-use 呼吸、完成消息转换）。

- [x] AUTO-0006: AskUserQuestion
  > 实现 Agent 主动向用户提问的交互机制
  > 完成：`ask-user-tool.ts` 工具入口 + `ask-user-manager.ts` 挂起-应答状态机 + `index.ts:491-512` 输入框接线 + plan 角色白名单（`roles.ts:54,58`）+ `ask-user.test.ts` 测试覆盖。作答 UX 增强见子任务 AUTO-0025。

- [x] AUTO-0007: 下拉菜单
  > 实现下拉选择菜单组件

- [x] AUTO-0008: 切换模型
  > 支持在不同 LLM 模型之间切换

- [x] AUTO-0009: Claude Code Spinner 对齐（总任务）
  > 依据源码探索结果，拆分 Spinner 的数据模型、动画、生命周期和测试任务；本次仅建单，不执行。

- [x] AUTO-0010: 梳理 Spinner 状态与数据模型
  > 明确 requesting/responding/thinking/tool-use/tool-input 五种模式、SpinnerVerb、TurnCompletionVerb、动画时钟和 query 生命周期数据的所有权。
  > 依赖：AUTO-0009

- [x] AUTO-0011: 统一动画时钟与帧派生机制
  > 以 50ms 单调时钟作为唯一时间源，派生 120ms 旋转帧、200ms/50ms shimmer、计时器、token 平滑计数、thinking 呼吸动画；清理重复定时器。
  > 依赖：AUTO-0010

- [x] AUTO-0012: 实现 SpinnerGlyph 旋转与 reducedMotion
  > 接入 12 帧往返序列；支持 reducedMotion 下静态圆点及亮暗切换；补齐符号宽度和终端输出布局契约。
  > 依赖：AUTO-0011

- [x] AUTO-0013: 实现 SpinnerVerb 与完成动词配置
  > 整理约 200 个进行时动词，支持配置追加/覆盖；每个 turn 固定一个 verb；任务结束从 8 个过去式完成动词中随机选择。
  > 依赖：AUTO-0010

- [x] AUTO-0014: 实现 GlimmerMessage 字素级 shimmer
  > 使用 grapheme segmenter 处理多字节字符，按 before/shim/after 分段；保持尾随空格宽度稳定；实现 requesting 左→右、其他模式右→左、stalled 停止闪烁。
  > 依赖：AUTO-0011

- [x] AUTO-0015: 实现 tool-use 整体呼吸灯
  > 在 tool-use 模式下对整段文字按正弦波在 messageColor 与 shimmerColor 间插值，并与普通 shimmer 路径互斥。
  > 依赖：AUTO-0014

- [x] AUTO-0016: 接入 Spinner 计时器与暂停生命周期
  > 管理 loadingStartTime、当前暂停起点和累计暂停时长；暂停时冻结 elapsedTimeMs；格式化秒/分钟；仅在 verbose、teammate 或超过 30 秒时显示。
  > 依赖：AUTO-0011

- [x] AUTO-0017: 实现 token 计数与平滑追赶
  > 用 response 字符数除以 4 粗估 token；按差距使用 +3、+15%、+50% 的策略平滑追赶目标值；支持 teammate token 汇总；复用计时器显示条件。
  > 依赖：AUTO-0011、AUTO-0016

- [x] AUTO-0018: 完善 thinking 状态机与摘要显示
  > 进入 thinking 时记录开始时间和 effort 后缀；退出时计算持续时间；显示灰色/浅灰正弦呼吸文字，延迟 3 秒启动；输出 thought for 摘要并按生命周期消失。
  > 依赖：AUTO-0011、AUTO-0016

- [x] AUTO-0019: 实现 stalled 检测与颜色渐变
  > 监听 responseLength 增长并重置 lastTokenTime；无 token 且无活跃工具超过 3 秒判定 stalled；3-5 秒将 stalledIntensity 线性提升到 1，并平滑追赶；驱动符号和文字渐变到错误红。
  > 依赖：AUTO-0011

- [x] AUTO-0020: 实现 Spinner Tip 与时间阈值
  > 超过 30 秒且用户未使用 /btw 时显示 quick side question 提示；超过 30 分钟显示 /clear 提示；其余时间使用 spinnerTip prop；避免每帧重复计算粗粒度阈值。
  > 依赖：AUTO-0016

- [x] AUTO-0021: 完成 Spinner 到静态完成消息的转换
  > Spinner 卸载时生成 SystemTurnDurationMessage，输出 `✻ <verb> for <duration>`；插入 messages 列表并参与滚动；确保 Thinking 摘要与完成消息的空行和 dim 样式正确。
  > 依赖：AUTO-0013、AUTO-0016、AUTO-0018

- [x] AUTO-0022: 对齐 Spinner 入口与组件依赖关系
  > 整理 SpinnerWithVerb、BriefSpinner、SpinnerWithVerbInner、SpinnerAnimationRow、TeammateSpinnerTree/TaskListV2、Tip/Budget/NextTask 的分支和数据流，确认 normal/brief 模式边界。
  > 依赖：AUTO-0010、AUTO-0011

- [x] AUTO-0023: 补齐 Spinner 单元与集成测试
  > 覆盖模式切换、帧序列、reducedMotion、字素 shimmer、计时暂停、token 平滑、thinking、stalled、Tip 阈值、完成消息转换和端到端消息顺序。
  > 依赖：AUTO-0012、AUTO-0015、AUTO-0017、AUTO-0019、AUTO-0020、AUTO-0021

- [x] AUTO-0024: 完成 Spinner 对齐后的验证与文档
  > 运行相关测试、类型检查和 lint；记录实际输出与源码探索结论的差异；更新必要的架构说明。仅在验证通过后关闭 AUTO-0009。
  > 依赖：AUTO-0023

## 已取消

- [-] AUTO-0027: 支持拖拽 / 直接粘贴图片
  > 取消：拖拽图片到终端后，终端本身已会输入文件路径；现有 `/image <路径>` 和 `/image`（Windows 图片剪贴板）已覆盖图片发送。自动把拖拽路径转成 ImageBlock 仅节省 `/image ` 前缀，却会引入路径误判与终端兼容成本，当前无必要实现。
  > 原依赖：AUTO-0001

---

## 日志

| 日期 | ID | 操作者 | 内容 |
|------|------|--------|------|
| 2026-07-15 | AUTO-0003 | @agent | 创建 |
| 2026-07-16 | AUTO-0003 | @agent | ⚠️ 阻塞：等待密钥 |
| 2026-07-18 | AUTO-0009~AUTO-0024 | @agent | 根据 Claude Code Spinner 源码探索结果拆分任务；仅建单，未执行 |
| 2026-07-18 | AUTO-0010、AUTO-0011、AUTO-0013 | @agent | 完成 Spinner 数据模型、统一时钟基础、帧派生与动词配置；相关测试通过 |
| 2026-07-18 | AUTO-0012 | @agent | 完成 SpinnerGlyph 12 帧旋转、reducedMotion 静态圆点亮暗切换、stalledIntensity 颜色插值；聚焦测试、类型检查和目标 lint 通过 |
| 2026-07-18 | AUTO-0014、AUTO-0015 | @agent | 完成字素簇安全 shimmer、双向扫描、stalled 停闪、尾随空格及 tool-use 整体正弦呼吸灯；Ink/inline 路径验证通过 |
| 2026-07-18 | AUTO-0016 | @agent | 完成可暂停计时生命周期、有效时长格式化，以及 verbose/活跃 teammate/30 秒显示条件；Ink/inline 与完成消息时长验证通过 |
| 2026-07-18 | AUTO-0017 | @agent | 完成字符数 token 粗估、50ms 三档平滑追赶、teammate token 汇总及按模式显示箭头；聚焦测试、类型检查和目标 lint 通过 |
| 2026-07-18 | AUTO-0018 | @agent | 完成 thinking effort、重复模式防重置、退出耗时摘要 2 秒生命周期，以及 3 秒延迟/2 秒周期灰色呼吸；thinking 相关回归、类型检查和目标 lint 通过 |
| 2026-07-18 | AUTO-0019 | @agent | 完成 responseLength 增长检测、活跃工具抑制、3-5 秒 stalledIntensity 平滑追赶，以及 Glyph/Glimmer 固定错误红渐变；聚焦与流式工具链回归、类型检查通过 |
| 2026-07-19 | AUTO-0020、AUTO-0021、AUTO-0022 | @agent | 完成共享 `selectSpinnerView()` 统一 normal/brief、Tip 阈值、活动区与 rowCount；完成消息工厂 `createTurnDurationMessage()` 固化随机动词与 dim 样式；BootstrapHandle 暴露 `setSpinnerContext`、finally 唯一 stop 接通 Thinking→空行→dim 完成消息顺序；Ink/inline 共享 View 与 `useSpinnerClock` 统一时钟；Task 1-7 全部 GREEN |
| 2026-07-19 | AUTO-0023、AUTO-0024、AUTO-0009 | @agent | 修复 9 个 inline footer 回归文件（cursor-drift/logo/physical-line-footer/commit-footer-erase/dropdown-shrink/input-wrap/overwrite-wrap/decawm-wordwrap/truncate-status）的「无 spinner 2 预留位」旧假设，统一为动态 `reserveRows = 1 + spinnerLines.length`；新增完成消息进入 flatten / scrollback 回归测试；L1/L2 重点集合 49 文件 430 测试全过、`tsc --noEmit` exit 0；全量 `npm test` 仅余 StatusBar 多色高亮导致的 2 条既有无关失败（设计文档明确豁免）；总任务 AUTO-0009 关闭 |
| 2026-07-21 | AUTO-0002、0003、0004、0006 | @agent | 派子代理核实代码现状后批量标记完成：AUTO-0002 斜杠命令体系（18 条命令 + 解析/分发/补全 UI 全链路）；AUTO-0003 ESC 中断链路（三家 provider signal + spinner 停止闭环 + e2e 测试）；AUTO-0004 已被 AUTO-0009~0024 整体覆盖；AUTO-0006 AskUserQuestion（工具入口 + 挂起-应答状态机 + plan 角色白名单 + 单测）。 |
| 2026-07-21 | AUTO-0001、AUTO-0025~0028 | @agent | 核实 AUTO-0001 现状后拆分子任务：AUTO-0026（OpenAI/Google provider 发图，当前 MVP 跳过）、AUTO-0027（拖拽/粘贴捕获，paste-handler 有 TODO）、AUTO-0028（resume 会话恢复回填，cachePath 只写不读）；AUTO-0006 新建子任务 AUTO-0025（接入下拉选择菜单）。 |
| 2026-07-21 | - | @agent | 顺手按文件顶部「核心规则」归位：AUTO-0009~0024 已是 `[x]` 但原堆在「待办」分区，现一并移入「已完成」。 |
| 2026-07-21 | AUTO-0026 | @agent | 完成 OpenAI/Google provider 图片输入支持（feat/openai-google-image-support 分支，6 个 TDD commit）：3 个共享 helper + 类型、三家统一空 data 防御、OpenAI 纯图片丢弃 bug 修复；49 个 agent 测试全过、tsc exit 0；经 brainstorming→writing-plans→subagent-driven 全流程 + 三轮 code review。 |
| 2026-07-21 | AUTO-0028 | @agent | 完成 resume 图片 rehydrate:ensureImageData 新增冷路径 + 私有 rehydrateFromCache(existsSync + readFileSync + 0 字节校验);2 条原契约测试改写 + 6 条新增;55 个 agent 测试全过、tsc exit 0、全量 1678 passed(StatusBar 2 条既有失败按设计豁免)。AUTO-0001 父任务仍不关闭(剩 AUTO-0027)。 |
| 2026-07-21 | AUTO-0029 | @agent | AUTO-0028 实测暴露 resume 回显 `(结构化内容)` 缺口,顺手补:新建 `src/utils/format-content.ts` 纯函数 + 接入 `index.ts:891`;6 条单测全过,tsc exit 0,全量 1684 passed 不回归。 |
| 2026-07-21 | AUTO-0029 | @agent | 实测发现 C 方案 `[图片 <完整 cachePath>]` 在 Windows 长路径下视觉糟糕(90+ 字符),改用 `path.basename` 只显示文件名 `[图片 1.jpg]`;新增 1 条 Windows 反斜杠路径测试(共 7 条)。 |
| 2026-07-21 | AUTO-0030 | @agent | AUTO-0028 实测暴露 resume 后 JSONL 只存 user 不存 assistant 的严重数据完整性 bug。根因:`streaming-query.ts:255-258` end_turn 提前 return 跳过阶段 4 assistantMessages 合并。修复 + 2 条集成测试(纯文本 + 工具调用末尾),全量 1687 passed、tsc exit 0。day-1 bug 自持久化功能(`ddb7725`)引入就在。 |
| 2026-07-21 | AUTO-0001、AUTO-0027 | @agent | brainstorming 复核范围：拖拽路径显示由终端原生提供，自动转图片仅属便捷入口；现有 `/image <路径>`、Windows 图片剪贴板、三家 provider 与 resume 链路已满足父任务。取消 AUTO-0027，关闭 AUTO-0001。 |
| 2026-07-24 | AUTO-0025 | @agent | 完成 AskUserQuestion overlay 重构 + 固化结果结构化展示。PR1（`2882666`）：`computeTabLayout` + `AskQuestionOverlayV2` 圆角边框/radio-checkbox/聚焦符。PR2（`8263009`）：meta 旁路双通道（StructuredAskResult 走 UI 通道，API content 零污染）+ 渲染层 3 contract 修正（子项统一 ⎿ / 续行缩进 / agent-completion 间距）+ ConPTY 验收工具（`npm run test:tty`）。follow-up（`b96516c`/`c52b173`/`5d1caae`）：code review 发现 finally 误调 sweep 的生命周期契约错误，改 clear + spy 契约测试 + mutation 验证。 |
