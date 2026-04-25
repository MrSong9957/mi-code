# Stop Hook Memory Review — 设计文档（V4）

## 目标

用户输入"复盘"关键词时，Claude 启动后台 agent 回顾对话内容，评估是否有值得添加到记忆系统的知识。有价值则写入 wiki/ 和 MEMORY.md，无价值则静默停止。复盘在后台执行，不阻塞用户。

## 架构（V4：关键词触发）

```
用户输入"复盘" → Claude 启动后台 agent（run_in_background: true）
                              ↓
                后台 agent 拥有完整工具权限：
                  - Skill 工具调用 obsidian-remember
                  - 读取 MEMORY.md 去重
                  - 写入 wiki/ 和 MEMORY.md
                              ↓
                后台 agent 完成 → 通知弹出（不阻塞用户）
```

## 触发方式

用户在对话中输入"复盘"关键词。Claude 理解中文指令，直接启动后台 agent，无需任何 hook 配置。

## 组件

### 1. 触发机制（V4）

无需 hook 配置。用户在对话中输入"复盘"，Claude 理解指令后：
1. 启动后台 agent（`run_in_background: true`）
2. 立即回复用户"后台 agent 已启动"
3. 后台 agent 独立执行复盘任务

### 2. 后台 agent 执行流程

1. 使用 obsidian-remember 技能复盘对话
2. 读取 MEMORY.md 检查重复
3. 有价值则写入 wiki/ 并更新 MEMORY.md
4. 无价值则不输出

## 关键设计决策

### 1. 关键词触发（V4）vs 自动触发（V1-V3）

V1-V3 的核心问题是自动触发导致过度执行：评估器无法准确判断对话是否包含新知识，几乎每次回复都触发后台 agent。V4 改为用户主动触发：

- **零误触发**：只有用户明确要求时才执行
- **零额外 API 调用**：无需评估器 LLM
- **零配置**：不需要 hook，不需要 settings.json 修改
- **用户掌控**：用户决定何时复盘，而不是算法猜测

### 2. 后台 agent 复盘（继承 V3）

复盘在后台 agent 中执行（继承 V3 的核心优势）：

- **不阻塞主线程**：用户可以立即输入下一条消息
- **主对话 token 零消耗**：复盘在 agent 的独立上下文中执行
- **完整工具权限**：agent 拥有 Skill、Read、Write、Edit

## 限制与边界

- **后台 agent 上下文**：agent 从 transcript 读取对话，不拥有主对话的实时上下文（但 transcript 包含完整内容）
- **通知机制**：后台 agent 完成后通过通知弹出结果，不阻塞用户
- **用户需主动触发**：不会自动复盘，需要用户输入"复盘"

## 测试方法

1. 进行一次包含新知识发现的对话（如调试一个新问题）
2. 输入"复盘"，验证后台 agent 是否启动
3. 验证后台 agent 完成后是否收到通知
4. 验证不触发后台 agent 时对话正常结束（无额外开销）

## 实施记录与踩坑

### V1：command hook + claude -p（已废弃）

最初方案用 `command` hook + `claude -p` 后台子进程，经历了多个问题：

| # | 坑 | 根因 | 解法 |
|---|---|------|------|
| 1 | agent hook 无法调用技能 | agent hook 只有 Read/Grep/Glob | 改用 command hook + claude -p |
| 2 | agent hook 输出不可见 | agent hook 无 Write 工具，输出不进终端 | 改用 command hook |
| 3 | claude -p 输出导致终端乱码 | ANSI 转义码与 TUI 冲突 | setsid + 重定向到文件 |
| 4 | /tmp 日志宿主机看不到 | 容器 /tmp 不映射 | 用 $HOME/.claude/ |
| 5 | 阶段一误过滤中文消息 | `${#var}` 计算字节数不是字符数 | python3 len() 统计字符数 |
| 6 | heredoc 长 prompt 传递失败 | shell 转义/展开问题 | 写临时文件再 cat 展开 |
| 7 | settings.json 修改不立即生效 | hook 配置在会话启动时加载 | 需重启 Claude Code 会话 |

### V2：prompt hook + 主对话内复盘（已废弃）

V1 的核心问题是 `claude -p` 子进程需要从 transcript 重建上下文，而主 Claude 已经拥有完整上下文。prompt hook 让评估结果直接控制主 Claude 是否继续工作。

**劣势**：复盘在主对话内同步执行，用户会看到 Claude 继续工作，且消耗主对话 token。

### V3：prompt hook + 后台 agent（已废弃）

V3 将复盘工作交给后台 agent，主 Claude 只负责启动 agent 然后立即停止。

**关键改进**：后台 agent 不阻塞用户，主对话 token 零消耗。

**废弃原因**：评估器 LLM 无法准确判断对话是否有复盘价值，几乎每次回复都触发后台 agent（过度触发）。评估器还不严格输出 JSON 导致终端显示 "error" 标签（#8 #9）。

### V4：关键词触发 + 后台 agent（当前方案）

V4 移除了 Stop hook，改为用户输入"复盘"关键词时手动触发。继承 V3 的后台 agent 复盘机制，但由用户完全控制触发时机。

**关键改进**：
- **零过度触发**：只有用户明确要求时才执行
- **零额外 API 调用**：无需评估器 LLM
- **零配置**：不需要 hook，不需要 settings.json 修改
- **无 "error" 标签**：不涉及 hook 评估器
- 继承 V3 的所有优势：不阻塞、零 token 消耗、完整工具权限
