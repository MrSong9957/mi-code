# mi-code Agent / Prompt Baseline

> 状态：冻结
> 基线日期：2026-07-26
> 仓库基线：`master@f5b88a8`
> 产物类型：只读分析产物；Phase 1-6 设计的必要输入
> 不属于本文范围：目标架构、优先级排序、迁移方案、实施计划

## 1. 目的与证据规则

本文固定 mi-code 当前 Agent、Prompt、Context、Tool、Memory、Lifecycle、Security、Observability 的可复现基线，防止后续设计基于印象或直接照搬 Claude Code 功能。

本文使用四类证据：

| 标记 | 含义 |
|---|---|
| **执行观察** | 已运行只读脚本或测试并记录结果 |
| **源码事实** | 可从当前提交中的明确调用关系、类型或常量直接确认 |
| **证据推断** | 由多个源码事实支持，但尚未用专门实验隔离验证 |
| **未知** | 当前系统没有测量能力，或本次 Baseline 未调用真实 Provider |

静态 token 数采用 `ceil(字符数 / 4)`，仅用于同一基线内比较。它不是任何 Provider tokenizer 的真实计费结果。该近似只适合当前以 ASCII 英文为主的 Prompt 与 tool schema；加入大量中文、emoji 或其他非 ASCII 内容后可能明显低估，不能用于跨语言、跨 Provider 的绝对比较。

## 2. 基线摘要

当前 mi-code 已经拥有可工作的流式 Agent 循环、工具注册表、三家 Provider 适配、工具结果压缩、Memory 工具、Plan Mode、权限检查器、会话持久化和较完整的测试基础。

但从 Agent Operating Model 视角看，当前系统仍是“分散规则 + 平面字符串 + 工具循环”：

- system prompt 在入口处由字符串数组直接拼接，没有统一 Prompt Compiler。
- 工具 schema 通过 Provider 的原生 tool plane 单独传递，这是现有系统中边界最清晰的一层。
- 项目规则文件没有进入运行时上下文；Memory 可由工具读写，但没有自动选择和注入主请求。
- Plan Mode 的写保护主要依赖工具过滤和现有权限逻辑；bash 当前通过 parser 识别已知写命令并拒绝，未实现“默认拒绝、仅放行已知安全命令”的 frozen allowlist 语义。
- PermissionChecker 的 `ask` 结果在主流式执行路径中没有形成用户决策门。
- 会话只持久化消息，没有显式 Turn、Phase、Outcome、待决策状态或验证证据。
- 压缩以字符数而非 Provider token 为预算单位。
- 系统能显示总输入 token，但不能解释 token 来自哪个 Prompt Section、工具 schema 或上下文来源。
- 没有行为评测集，因此“模型违反哪些规则、频率多高”目前不可量化。

这些结论描述现状，不构成 Phase 1-6 的优先级判断。

## 3. 当前请求数据流

当前主链路为：

```text
src/index.ts
  ├─ 拼接 systemPrompt
  ├─ SkillRegistry.loadFromDir("skills")
  ├─ ToolRegistry 创建工具
  ├─ Plan Mode 过滤 WRITE_TOOLS
  └─ streamingQuery(...)
       ├─ 压缩 messages
       ├─ ProviderClient.createMessage(...)
       ├─ 接收 tool_use
       ├─ PermissionChecker 检查
       ├─ 执行工具
       ├─ 追加 tool_result
       └─ 继续同一循环
```

Provider 映射：

| Provider | system prompt 的承载方式 | tools 的承载方式 |
|---|---|---|
| Anthropic | `system` 字符串 | 原生 `tools` 数组 |
| OpenAI | prepend system message | 原生 tools 定义 |
| Google | `systemInstruction` | 原生 function/tool 定义 |

**源码事实：** 三个 Provider 共享同一个上游 system prompt 字符串和工具定义来源，但各 Provider 最终封装不同。

**源码事实：** 当前不存在单一的“最终请求对象”保存 section provenance、预算决策、截断原因和最终 hash。

## 4. 静态请求包络

以下数字由当前 TypeScript 源码和运行时工具工厂进行只读构造后得到，没有发出 Provider 请求，也没有执行任何业务工具。

### 4.1 System prompt

| 模式 | 字符数 | UTF-8 bytes | 粗略 token | SHA-256 |
|---|---:|---:|---:|---|
| Normal | 1,250 | 1,276 | 313 | `835f72c97ec425aa75ae0ba4f7d7c8143a87db6254566ba56825bb04070aaffc` |
| Plan | 5,037 | 5,085 | 1,260 | `c57461fc50fee2904ddb6f03db207b2039bd82557d82484275a5873cd112ffd3` |

Plan Mode 比 Normal Mode 多 3,787 个字符，主要来自 `planner.md` 生成内容。

### 4.2 Tool schemas

| 模式 | 可见工具数 | JSON 字符数 | UTF-8 bytes | 粗略 token | SHA-256 |
|---|---:|---:|---:|---:|---|
| Normal | 33 | 13,963 | 13,967 | 3,491 | `2cca34b10d0f87207c927243ce8779aac8d596aeda6de5fd3f0e96a1354508f6` |
| Plan | 16 | 6,298 | 6,302 | 1,575 | `325fc9e75074ad14cd46768639f3e52e98ebd54fb179ddecfaae977556d91279` |

### 4.3 静态最小开销

静态最小开销定义为：

```text
system prompt + tool schema JSON
```

不包含当前用户消息、会话历史、工具结果、图像、Provider wrapper 和 tokenizer 差异。

| 模式 | 字符数 | 粗略 token |
|---|---:|---:|
| Normal | 15,213 | 3,804 |
| Plan | 11,335 | 2,835 |

**执行观察：** 尽管 Plan Mode 的 system prompt 更长，但工具数量从 33 降至 16，使其静态总包络小于 Normal Mode。

**未知：** 一次真实请求最终发送多少 token。当前只能得到 Provider 返回的总 input tokens，无法在发送前按 section 精确归因。

### 4.4 子 Agent system prompt

第 4.1-4.3 节只测量主 Agent，不包含子 Agent 请求。子 Agent 的 system prompt 由两条互斥路径产生：

```text
普通角色路径：
role system prompt
  → 追加环境与行为约束
  → 追加 skill catalog

fork 路径：
parent system prompt
  → 追加环境与行为约束
  → 追加 skill catalog
```

fork 路径会用父 system prompt 替换角色 prompt，不是把两者叠加。子任务文本作为动态 user prompt 发送，也不计入下面的静态 system 体积。

在当前工作目录、Windows 平台、当前 shell 和 50 字符 skill catalog 下，执行观察为：

| 子 Agent 路径 | base system 字符数 | 环境 + skill 后字符数 | 粗略 token |
|---|---:|---:|---:|
| `explore` role | 546 | 860 | 215 |
| `plan` role | 385 | 699 | 175 |
| `general` role | 75 | 389 | 98 |
| fork Normal parent | 1,250 | 1,564 | 391 |
| fork Plan parent | 5,037 | 5,351 | 1,338 |

fork 两行使用第 4.1 节的父 Prompt 快照；该测量时 `todoManager.getReminder()` 与 `getVerificationNudge()` 都未触发，因此 reminder 为空。fork 并不会固定排除 reminder：真实执行会继承当轮完整父 Prompt，条件式 reminder 一旦出现也会计入 fork 子 Agent。真实值还会随工作目录、平台、shell、Git 仓库状态和 skill catalog 改变。

**范围说明：** 表中仍不包含子 Agent 的角色工具 schema 和动态任务/历史；因此它是子 Agent system 基线，不是子 Agent 完整请求包络。

## 5. System Prompt 构成

`src/index.ts` 当前按固定顺序拼接：

1. 基础助手与工具使用说明。
2. 强制委派给子 Agent 的说明。
3. 子 Agent 失败处理说明。
4. skill catalog。
5. TODO reminder。
6. Plan Mode instruction（仅 Plan Mode）。

当前形式近似：

```text
systemPrompt = [A, B, C, D, E, optional(F)].join("\n\n")
```

不存在以下结构：

- section ID；
- 来源和版本；
- Authority / Trust / Freshness / Retention / Placement 元数据；
- section 依赖；
- 模式适用条件的统一声明；
- token 预算；
- 冲突检查；
- 去重；
- 编译后快照；
- 单 section hash。

### 5.1 Prompt 来源分布

Prompt 内容至少分散在：

- `src/index.ts`：主 system prompt；
- `src/prompts/planner.md` 及其生成 TS：Plan Mode prompt；
- `src/agent/roles.ts`：角色 prompt；
- `src/agent/subagent.ts`：子 Agent 环境补充；
- self-organizing Agent 相关模块：编排 prompt；
- 各工具定义：tool description 与 input schema；
- `skills/*/SKILL.md`：skill 内容。

为避免把搜索口径伪装成规则数量，本基线改用固定口径：在 `src/` 下的生产 `.ts` / `.tsx` 文件中排除 `__tests__`，大小写敏感搜索 `You are|MUST|NEVER`，得到 11 个匹配行、分布于 7 个文件。

**执行观察：** 11 是包含字符串和注释的候选匹配行数，不是去重后的 Prompt rule 数量，也不能单独证明规则重复。其价值仅在于确认高强度指令分散在多个生产文件；精确 Prompt 机制归类属于后续 Mechanism Index / Gap Matrix。

### 5.2 已观察到的漂移

| 现象 | 证据状态 |
|---|---|
| 主 prompt 与 planner prompt 都包含强制委派语义 | 源码事实 |
| planner 声称只允许规划相关操作，但实际 Plan Mode 还暴露 TODO、Memory read、schedule list、spawn agent 等工具 | 源码事实 |
| Prompt 规则没有 Registry 元数据，无法从运行时回答“为何存在、适用于谁、经过何种评测” | 源码事实 |
| 重复规则是否造成模型行为退化 | 未知，无行为评测集 |

## 6. Skill 注入基线

当前 `SkillRegistry` 从相对路径 `skills` 加载两个 skill：

- `code-review`
- `git-workflow`

两个文件的 frontmatter 都明确包含非空 description：

```text
code-review: Checklist for reviewing code changes
git-workflow: Branch and commit guidance for git operations
```

但运行时生成的 catalog 为：

```text
Skills available:
- code-review:
- git-workflow:
```

即名称存在，描述为空。

**执行观察：** runtime catalog 的 description 未被加载，根因已确认：

- `parseFrontmatter` 使用 `^---\n([\s\S]*?)\n---\n([\s\S]*)$`，只接受 LF；
- `code-review/SKILL.md` 含 24 个 CRLF、0 个裸 LF；
- `git-workflow/SKILL.md` 含 25 个 CRLF、0 个裸 LF；
- 当前正则对两个原文件都匹配失败；
- 只把 CRLF 归一化为 LF 后，两个文件都匹配成功。

因此这里不再标记为证据推断。独立回归测试仍是未来修复的验证要求，但不是确认当前根因的前置条件。

**源码事实：** skill catalog 被直接拼入 system prompt；没有独立预算、排名、按任务选择或版本记录。

## 7. Tool Plane 基线

### 7.1 Normal Mode 工具

```text
run_bash
read_file
write_file
edit_file
glob
grep
todo_write
idle
schedule_create
schedule_list
schedule_remove
schedule_update
background
create_task_matrix
mark_task_done
worktree
task
spawn_self_organizing
spawn_agent
load_skill
send_message
read_inbox
shutdown_request
respond_request
submit_plan
approve_plan
memory_write
memory_read
memory_list
ask_user_question
write_plan_file
exit_plan_mode
read_plan_file
```

### 7.2 Plan Mode 工具

```text
run_bash
read_file
glob
grep
todo_write
idle
schedule_list
spawn_agent
load_skill
read_inbox
memory_read
memory_list
ask_user_question
write_plan_file
exit_plan_mode
read_plan_file
```

### 7.3 Schema 体积

当前较大的单工具 schema：

| 工具 | JSON 字符数 |
|---|---:|
| `spawn_agent` | 1,197 |
| `ask_user_question` | 1,080 |
| `spawn_self_organizing` | 889 |
| `worktree` | 847 |

**源码事实：** tools 通过 Provider 原生 tool plane 发送，没有被复制进主 system prompt。

**源码事实：** Plan Mode 使用静态 `WRITE_TOOLS` 过滤工具，但“可见”与“实际允许执行”由不同位置的规则共同决定。

### 7.4 `ask_user_question` 当前行为

当前工具链路为：

```text
模型调用 ask_user_question
  → validateAskUserInput
  → AskUserManager.ask
  → 取消并 resolve 前一个 pending ask
  → 生成 UUID 并打开 TUI 问卷
  → Promise 等待 UI callback
  → 返回序列化 tool_result
  → 同源结构化 outcome 经临时 store 交给 UI 展示
```

当前边界：

- `AskUserManager` 进程内最多保存一个 pending ask；新 ask 会取消旧 ask。
- **源码事实 + 执行观察：** streaming executor 会串行处理 deferred `ask_user_question` 调用，避免并行问卷互相覆盖；对应串行行为测试已执行通过。
- 工具没有自动超时；正常情况下会一直等待 UI callback。
- pending ask、UUID 和未回答问题不进入 SessionStore，进程退出后不能恢复。
- structured outcome store 是一次性 UI 旁路，正常消费即删除；`TTL_MS = 5 * 60 * 1000` 是硬编码过期阈值，不是可配置项。`sweep()` 只有在被调用时才按该阈值删除过期记录，当前没有周期定时器；正常 streaming 收尾另行调用 `clear()` 清空残留。它不是会话持久化。
- 子 Agent 的全局工具黑名单移除了 `ask_user_question`，用户交互由主 Agent 独占。

**源码事实：** `ask_user_question` 与 PermissionChecker 返回的 `ask` 是两套未接通的机制。前者是模型主动调用的交互工具；后者是权限决策值，当前 streaming 路径没有把它转换为 `AskUserManager` 请求或 `awaiting_user` 状态。

## 8. Context Sources 基线

| Context 来源 | 当前是否进入主请求 | 加载时机 | 生命周期/约束现状 |
|---|---|---|---|
| 基础 system prompt | 是 | 每次请求构造 | 固定字符串 |
| Plan prompt | Plan Mode 是 | 每次请求构造 | 固定生成内容 |
| Skill catalog | 是 | 启动加载后拼接 | 全量名称；当前描述为空 |
| 当前用户消息 | 是 | 当前 Turn | 消息历史的一部分 |
| 会话历史 | 是 | session load / Turn 追加 | 整体进入压缩管线 |
| Tool results | 是 | 工具调用后 | 纯文本 tool_result |
| TODO 状态提醒 | 条件式 | 多轮后 | prompt 字符串提醒 |
| Project rules（CLAUDE.md / AGENTS.md 等） | 否 | 无 | 无发现、排序、冲突处理 |
| Memory 自动选择 | 否 | 无 | 仅工具可主动读写；MemoryManager 存在关键词选择/注入辅助方法，但未接入主请求链路 |
| Git 状态/差异 | 否 | 无 | 需要 Agent 主动调用工具 |
| 环境摘要 | 否 | 无统一入口 | 部分子 Agent prompt 单独追加 |
| Prompt Registry | 否 | 无 | 不存在 |

根目录虽然存在 `AGENTS.md` 和 `CLAUDE.md`，但当前生产请求链路没有发现读取和注入逻辑。

**源码事实：** `MemoryManager` 有索引、关键词选择和注入相关方法，但主请求链路没有调用这些方法。

## 9. Memory 基线

当前生产实现为 `src/memory/memory-manager.ts`，提供：

- `memory_write`
- `memory_read`
- `memory_list`
- memory index；
- keyword selection / inject 辅助方法。

另有 `src/agent/memory.ts` 的旧实现，但没有进入当前生产主链路。

当前特征：

- Memory 由 Agent 通过工具显式读写。
- 主 prompt 不自动加载相关 Memory。
- 没有 frozen Context Model 中的 Authority、Trust、Freshness 等元数据。
- 没有成功/失败/取消三种 Outcome 的差异化写入策略。
- 没有 evidence、confidence、失效条件、适用版本的强制字段。
- Memory 写入不是 Turn completion contract 的组成部分。

**源码事实：** 构造 `MemoryManager` 可能创建 `.memory` 目录；本次 Baseline 没有调用写入工具。

## 10. Context Lifecycle 与压缩基线

`src/agent/compression.ts` 的当前关键常量：

| 常量 | 当前值 | 实际语义 |
|---|---:|---|
| `PERSIST_THRESHOLD` | 5,000 | 大工具结果持久化阈值 |
| `CONTEXT_LIMIT` | 100,000 | 字符型上下文估算上限 |
| `KEEP_RECENT` | 3 | 保留最近工具结果数量 |
| `SNIP_THRESHOLD` | 50 | 结果行数裁剪阈值 |
| compact 最小长度 | 120 | 微压缩触发相关阈值 |

当前循环中的处理顺序近似：

```text
tool result append
  → persist oversized result
  → snip older tool results
  → micro compact
  → 若仍超过字符上限，调用模型总结
  → 下一次 Provider 请求
```

已确认的语义：

- 上下文估算以字符数为主，不是 Provider tokenizer。
- 大工具结果写入 `.task_outputs/tool-results`。
- transcript 写入 `.transcripts`。
- L4 summary 使用简短总结 prompt。
- summary 序列化时，工具结果内容被替换为 `[tool result]`。
- session resume 从 JSONL 恢复消息。
- UI 的 context percentage 使用固定 200,000 token 分母，不区分模型。

**证据推断：** 将所有工具结果替换为统一占位符会损失失败原因和验证证据；具体行为影响尚无回归评测。

**源码事实：** 当前没有显式建模 `tool_use` / `tool_result` 配对在压缩和恢复过程中的不变量。

## 11. Agent Lifecycle 与 Session 基线

当前没有 Phase 0 已冻结的正交状态模型。现有状态主要散落在 streaming loop、事件总线、UI thinking 状态、Plan Mode flag 和 session history 中。

### 11.1 当前事件

`StreamEventBus` 当前主要事件：

```text
stream_event
assistant_message
tool_call
tool_result
error
loop_end
```

不存在 frozen lifecycle 中的：

- `TurnStarted`
- `ControlModeChanged`
- `SessionSuspended`
- `SessionResumeStarted`
- `SessionResumed`
- `VerificationRepairScheduled`
- 明确的 awaiting-user / verification / outcome 事件

### 11.2 当前 Session 持久化

JSONL session 当前主要保存：

- role；
- content；
- timestamp。

未保存：

- turn ID；
- `SessionStatus`；
- `ControlMode` 快照；
- `TurnPhase`；
- `TurnOutcome`；
- pending user decision；
- verification level 与证据；
- repair budget；
- termination reason。

`AskUserManager` 只维护单个进程内 pending ask，没有持久化和恢复语义；其完整工具链路和与 PermissionChecker `ask` 的区别见第 7.4 节。

### 11.3 当前循环终止

主流式循环可因以下情况结束：

- Provider 返回 `end_turn`；
- 用户 abort；
- 可选 `maxTurns`；
- Provider / tool 异常；
- 子 Agent 达到自身轮次上限。

但这些终止原因没有统一映射为 `completed`、`partial`、`failed`、`cancelled`。

**源码事实：** 当前没有独立 verification phase，也没有“达到最低验证等级才允许 completed”的运行时契约。

## 12. Plan Mode 基线

Plan Mode 当前通过以下组合形成：

- 添加 planner prompt；
- 从 Tool Registry 过滤 `WRITE_TOOLS`；
- 对 plan output directory 提供特定写入能力；
- `write_plan_file`、`read_plan_file`、`exit_plan_mode` 等控制面工具；
- bash 写命令识别与权限逻辑。

当前与 frozen Phase 0 语义的差异：

| 项 | 当前实现 |
|---|---|
| bash 策略 | 识别写命令的 denylist / parser 思路 |
| frozen 目标语义 | 安全命令 allowlist AND 参数约束 AND 路径白名单 |
| 未知命令 | 当前不等同于统一默认拒绝 |
| 控制面写路径 | 存在 plan directory 特例 |
| 单次越权 | 当前权限体系仍存在 `ask` 未真正阻断的问题 |

这张表只记录差异，不决定后续由哪个 Phase 实现。

## 13. Permission 与 Security 基线

### 13.1 PermissionChecker

Permission policy 支持：

- `deny`
- `ask`
- `allow`

但在当前主 streaming 路径：

- `deny` 会阻止执行；
- `ask` 没有进入用户决策流程，而是继续执行。

这是已存在的 expected-failure regression test 所固定的缺口。

### 13.2 Hook

主入口注册了 PreToolUse / PostToolUse 相关 hook，但当前 streaming executor 在工具执行前没有完整调用 PreToolUse；PostToolUse 在主链路有调用。

### 13.3 子 Agent 权限

- 部分 `spawn_agent` / self-organizing 路径会传递 PermissionChecker。
- `task` 子 Agent 路径未完整传递 PermissionChecker。

### 13.4 Tool Result 信任

当前 tool result 结构近似：

```json
{
  "type": "tool_result",
  "tool_use_id": "...",
  "content": "..."
}
```

没有：

- trusted / untrusted flag；
- 来源类型；
- producer identity；
- schema validation 状态；
- content provenance；
- 允许 Placement；
- 是否经过 trusted extraction。

### 13.5 未发现的边界

本次对主请求链路的检查没有发现：

- 工具结果 prompt injection envelope；
- deterministic trusted loader；
- secret scrubbing 的统一请求出口；
- Context trust promotion 的集中检查。

“未发现”只针对本次检查范围，不等同于证明整个仓库不存在任何局部处理。

## 14. Verification 基线

当前系统存在：

- TypeScript / lint / test / build scripts；
- TODO 完成后的验证提醒；
- Agent 可自行运行测试和命令；
- 测试覆盖多个工具与流式执行路径。

当前系统不存在：

- 变更类型到 V0-V3 的硬映射；
- 最低 verification level；
- verification evidence 结构；
- verification failure kind；
- repair budget；
- verified independent deliverable；
- “无法达到最低等级只能 partial”的完成门。

因此当前“完成”主要由模型输出和循环终止表达，未被运行时契约证明。

## 15. Observability 基线

当前可观察：

- Provider 返回的 input/output token 总数；
- tool call / tool result / stream events；
- session 消息；
- debug / task logs；
- UI thinking 和 context percentage。

当前不可观察：

- 单个 Prompt Section 的字符/token 成本；
- project rules、memory、history、tools 的分别占比；
- 最终编译 prompt；
- prompt provenance；
- prompt hash 与 tool schema hash 的运行时记录；
- 某条规则是否被注入；
- 规则冲突和淘汰原因；
- Provider prompt cache hit / write 的可靠统计；
- 工具结果信任级别；
- 行为规则违反率；
- verification level 与证据；
- lifecycle state transitions。

Anthropic 客户端当前映射基础 input/output usage，但没有形成可用的 prompt cache 基线。Usage 类型虽有可选 cache 字段，不能据此证明缓存已启用或被记录。

## 16. 测试基线

仓库当前约有：

- 186 个测试文件；
- 28,194 行测试代码。

本次运行了 14 个与 Baseline 直接相关的测试文件，覆盖 permission、compression、memory、Plan Mode filter、streaming、recovery、roles、session 和已知 regression gaps。

结果：

```text
Test Files  14 passed (14)
Tests       198 passed (198)
Duration    11.01s
```

注意：198 个绿色测试中有 4 个 `it.fails` expected-failure tests，另有 194 个普通正向通过测试。`it.fails` 表示“已知缺口仍按预期存在”，不表示缺口已经修复。

当前被测试锁定的关键缺口：

1. streaming executor 缺少完整 PreToolUse hook wiring；
2. PermissionChecker 的 `ask` 在 streaming 路径被静默放行；
3. `task` 子 Agent 未完整继承 PermissionChecker；
4. 另有 worktree safety expected failure，与本 Prompt/Agent Baseline 非核心相关。

本次未运行真实 Provider、真实 TTY 和全量 E2E，因此没有 V3 证据。

## 17. 当前重复与分叉

| 领域 | 当前分叉/重复 |
|---|---|
| 基础与 Plan prompt | 委派、工具限制、行为规则在多个 prompt 重复表达 |
| Memory | `src/memory/memory-manager.ts` 与未进入生产主链路的 `src/agent/memory.ts` |
| Permission | 工具过滤、PermissionChecker、bash parser、planDir 特例共同决定 |
| Lifecycle | streaming loop、event bus、UI thinking、session store 各自保存局部状态 |
| Context budget | compression 使用字符阈值，UI 使用固定 200k token，Provider 返回真实总 token |
| Tool capability | registry 可见性、prompt 声明、runtime permission 三处可能漂移 |

本文不判断这些重复都应消除；它们是 Gap Matrix 的输入。

## 18. Baseline 未知项

以下问题不能从当前静态结构可靠回答：

1. 不同 Provider / 模型下一次真实请求的最终 input token。
2. system、tools、history、memory、tool results 各自的真实 token 占比。
3. Prompt cache 的实际命中率和节省量。
4. 哪些规则经常被模型违反，以及违反率。
5. 重复规则对遵循率是正增益还是上下文污染。
6. 压缩后关键证据丢失的真实任务失败率。
7. Plan Mode bash 判定的误拒绝率与漏放率。
8. 子 Agent 委派对成功率、成本和延迟的净影响。
9. Memory 的实际使用率、命中率与错误记忆影响。
10. 恢复长会话后环境漂移造成的失败率。

这些未知项需要后续 Observability / Evaluation 设计提供测量能力；不能在 Gap/Value Matrix 中伪装成已确认收益。

## 19. 对后续设计的事实约束

后续 Phase 1-6 设计至少必须尊重以下现状：

1. 工具 schema 已有独立 Provider tool plane，不应无理由复制进 system prompt。
2. 三家 Provider 的 system 承载方式不同，需要共享语义但允许适配层不同。
3. 当前工具数量和 schema 已构成主要静态 token 成本。
4. Project rules 当前完全缺席，不能把“已有根目录规则文件”误写成“运行时已支持”。
5. Memory 当前是工具能力，不是自动 Context Source。
6. 压缩、UI 和 Provider 对 context size 使用不同口径。
7. 权限的 `ask`、PreToolUse 和子 Agent 传播存在已测试缺口。
8. session message persistence 不能等同于 lifecycle persistence。
9. tool result 当前没有信任元数据。
10. 行为改进没有现成评测基线，后续不能只用 prompt 字符串变更宣称提升。

## 20. 可复现性

### 20.1 静态指标

复现原则：

- 从 `src/index.ts` 的实际拼接顺序构造 system prompt；
- 通过真实 Tool Registry 工厂构造工具定义，但不调用工具；
- 使用稳定 JSON 序列化计算 tool schema 体积；
- 分别对 Normal / Plan 模式测量；
- SHA-256 用于识别基线内容是否变化；
- token 估算统一采用 `ceil(chars / 4)`。

高强度指令候选行使用固定搜索口径：

```powershell
Get-ChildItem src -Recurse -File -Include *.ts,*.tsx |
  Where-Object { $_.FullName -notmatch '[\\/]__tests__[\\/]' } |
  Select-String -CaseSensitive -Pattern 'You are|MUST|NEVER'
```

该命令统计匹配行和去重文件数，不进行 Prompt rule 语义去重。

### 20.2 测试

本次使用 Windows 可执行入口运行针对性 Vitest：

```powershell
npx.cmd vitest run <14 个相关测试文件>
```

执行结果见第 16 节。完整文件列表应在未来自动化 Baseline 脚本中固化；当前仓库尚无该脚本。

### 20.3 基线失效条件

满足任一条件，应重新生成至少相关章节：

- system prompt 拼接顺序或内容变化；
- tool registry / schema 变化；
- Provider 请求封装变化；
- compression 常量或算法变化；
- permission / hook / subagent wiring 变化；
- session persistence schema 变化；
- project rules 或 memory 自动注入上线；
- Prompt Registry / Compiler 上线。

## 21. Baseline 完成边界

本文完成的是“当前状态证据冻结”，没有完成：

- Claude Mechanism Index；
- mi-code Gap / Value Matrix；
- Phase 1-6 目标设计；
- Prompt 选择或移植；
- Prompt Governance Registry 内容；
- 任何生产代码修改；
- 任何实施计划。

下一产物必须以本文事实为 mi-code 侧输入，再对约 4,500 行 Claude Code 资料建立逐条机制索引。不能因 Claude Code 存在某机制，就预设 mi-code 必须迁移该机制。
