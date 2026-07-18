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

- [ ] AUTO-0001: 图片输入支持
  > 支持在输入中附加图片，作为多模态输入发送给模型

- [ ] AUTO-0002: 斜杠命令体系
  > 实现 /command 交互方式，支持如 /help、/clear 等快捷指令

- [ ] AUTO-0003: ESC 中断 LLM 连接和打断 spinner 动画
  > 按 ESC 可中断正在进行的 LLM 请求并停止加载动画

- [ ] AUTO-0004: 修改 spinner 动画
  > 调整加载动画的样式或帧率

- [ ] AUTO-0005: 探索 Tip 机制
  > 调研输入提示/补全的交互方案

- [ ] AUTO-0006: AskUserQuestion
  > 实现 Agent 主动向用户提问的交互机制

- [ ] AUTO-0009: Claude Code Spinner 对齐（总任务）
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

- [ ] AUTO-0020: 实现 Spinner Tip 与时间阈值
  > 超过 30 秒且用户未使用 /btw 时显示 quick side question 提示；超过 30 分钟显示 /clear 提示；其余时间使用 spinnerTip prop；避免每帧重复计算粗粒度阈值。
  > 依赖：AUTO-0016

- [ ] AUTO-0021: 完成 Spinner 到静态完成消息的转换
  > Spinner 卸载时生成 SystemTurnDurationMessage，输出 `✻ <verb> for <duration>`；插入 messages 列表并参与滚动；确保 Thinking 摘要与完成消息的空行和 dim 样式正确。
  > 依赖：AUTO-0013、AUTO-0016、AUTO-0018

- [ ] AUTO-0022: 对齐 Spinner 入口与组件依赖关系
  > 整理 SpinnerWithVerb、BriefSpinner、SpinnerWithVerbInner、SpinnerAnimationRow、TeammateSpinnerTree/TaskListV2、Tip/Budget/NextTask 的分支和数据流，确认 normal/brief 模式边界。
  > 依赖：AUTO-0010、AUTO-0011

- [ ] AUTO-0023: 补齐 Spinner 单元与集成测试
  > 覆盖模式切换、帧序列、reducedMotion、字素 shimmer、计时暂停、token 平滑、thinking、stalled、Tip 阈值、完成消息转换和端到端消息顺序。
  > 依赖：AUTO-0012、AUTO-0015、AUTO-0017、AUTO-0019、AUTO-0020、AUTO-0021

- [ ] AUTO-0024: 完成 Spinner 对齐后的验证与文档
  > 运行相关测试、类型检查和 lint；记录实际输出与源码探索结论的差异；更新必要的架构说明。仅在验证通过后关闭 AUTO-0009。
  > 依赖：AUTO-0023

## 已完成

- [x] AUTO-0007: 下拉菜单
  > 实现下拉选择菜单组件

- [x] AUTO-0008: 切换模型
  > 支持在不同 LLM 模型之间切换

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
