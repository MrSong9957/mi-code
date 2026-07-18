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