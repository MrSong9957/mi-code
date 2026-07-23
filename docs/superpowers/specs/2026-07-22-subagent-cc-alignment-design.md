# 子代理机制 CC 对标设计

日期：2026-07-22
状态：设计已批准

## 背景

基于 Claude Code 子代理源码分析，mi-code 已完成第一轮对标（commit 329c68c + 911570c）：RoleConfig 扩展（whenToUse/model/maxTurns）、防递归黑名单、环境信息注入、model per-role、动态工具描述。

本轮补充三个 CC 细节：环境信息更完整、子代理技能发现、fork 模式。

## 已落地（第一轮，不改动）

- RoleConfig：whenToUse / model / maxTurns
- 防递归黑名单：SUBAGENT_DISALLOWED_TOOLS = {spawn_agent, task, spawn_self_organizing}
- enhanceSubagentSystemPrompt：CWD + Platform + 行为约束
- model per-role：explore=small, plan/general=inherit
- 动态 whenToUse 注入 spawn_agent description

## 本轮改动

### 改动 1：环境信息更完整

CC 的 `computeEnvInfo` 返回完整 Environment 段：工作目录、git 仓库、平台、Shell、OS、模型名。mi-code 当前只有 CWD + Platform。

**改 `src/agent/subagent.ts` 的 `enhanceSubagentSystemPrompt`：**

追加：
- `Is a git repository: true/false`（检查 `.git` 存在）
- `Shell: ${process.env.SHELL ?? 'default'}`（或 Windows 的 process.env.ComSpec）
- 模型名：从 clientProvider 传入或从 options 获取

**实现**：`enhanceSubagentSystemPrompt` 新增可选参数 `modelName?: string`。subagent.ts 调用时从 `options.model` 或 client 的 model 属性传入。由于 client 是 StreamingLLMClient（不一定暴露 model 名），最简方案是在 system prompt 中不写模型名（子代理不需要知道自己用什么模型），或从 SubagentOptions 新增 `modelName` 字段由 spawn-agent-tool 注入。

决策：只加 git 仓库检测 + Shell（确定能获取的信息）。模型名跳过——子代理不需要知道自己用什么模型，且获取模型名需要额外传参增加复杂度。

### 改动 2：子代理技能发现

CC 的子代理可以调用 Skill 工具（在 ASYNC_AGENT_ALLOWED_TOOLS 白名单中，Explore 角色未禁止它）。Skill 工具只做提示词注入，不执行代码，不违反只读约束。

mi-code 的 `load_skill` 工具同样只做 `registry.loadFullText(name)`——纯提示词注入。explore/plan 角色白名单已含 `load_skill`。

**缺失的是技能发现描述**——主 agent 的 system prompt 含 `skillRegistry.describeAvailable()`（可用技能列表），但子代理没有。

**改 `src/agent/subagent.ts`：**

`SubagentOptions` 新增可选 `skillsDescription?: string`。`enhanceSubagentSystemPrompt` 追加技能描述。

**截断策略**：如果技能列表 >20 个，只保留前 20 个的名称+一行描述（避免占用子代理 context window）。

**改 `src/agent/tools/spawn-agent-tool.ts`：**

createSpawnAgentTool 接收 `skillRegistry` 或预计算的 `skillsDescription` 字符串。executor 中传给 `runSubagentFn` 的 options。

**改 `src/index.ts`：**

spawn_agent 注册时传入 `skillRegistry.describeAvailable()`（或 skillRegistry 实例）。

> 注意：技能列表在主 agent 每轮循环时动态生成（`skillRegistry.describeAvailable()`）。子代理 spawn 时取当前快照即可。

### 改动 3：fork 模式完善

CC 的 fork：`subagent_type` 省略 + feature flag 开启时触发。fork 子代理继承父进程完整 system prompt（字节级相同，利于 prompt cache），role 指令通过消息注入。

mi-code 已有 forkMode 字段（SubagentOptions）但从未触发——spawn-agent-tool 不传 forkMode。

**设计决策**：mi-code 不照搬 CC 的"省略 subagent_type 触发 fork"——mi-code 的 spawn_agent 工具 role 是必填参数。改为：新增 `fork` 布尔参数，LLM 可选择 fork 一个继承主 agent 上下文的子代理。

**改 `src/agent/tools/spawn-agent-tool.ts`：**

工具 parameters 新增 `fork: boolean`（可选）。executor 中：
- `fork=true` → 传 `forkMode: true, parentSystem: <主 agent system prompt>` 给 runSubagent，maxTurns 默认 50（fork 用于长任务，比普通子代理 15-25 大）
- `fork=false/省略` → 正常角色派发（现有行为）

工具 description 追加 fork 参数说明：
```
-fork (optional): Set to true when you need a subagent with your exact capabilities
  to work on an independent subtask in parallel. The fork inherits your full system
  prompt for consistent behavior.
```

**改 `src/index.ts`：**

spawn_agent 需要访问主 agent 的当前 system prompt。最干净的方案：createSpawnAgentTool 接收一个 `getParentSystemPrompt: () => string` 闭包，每次 spawn 时返回主 agent 最近一轮的 system prompt。

> 但主 agent 的 system prompt 是在 index.ts 主循环内每轮动态构造的（line 588-597）。spawn_agent 工具在工具执行阶段被调用，此时 system prompt 已经构造完毕。需要把它存到一个闭包能访问的变量。

**实现**：在 index.ts 主循环中，构造 systemPrompt 后存入模块级变量 `lastSystemPrompt`。createSpawnAgentTool 的 `getParentSystemPrompt` 闭包读这个变量。

## 不改动

- 白名单机制（不改为黑名单）
- exit_plan_mode/ask_user_question 在 plan 角色白名单中（保持当前状态）
- 递归保护（SUBAGENT_DISALLOWED_TOOLS 仅防递归）
- omitClaudeMd（mi-code 没有 CLAUDE.md 注入机制，不需要）

## 测试

- subagent.ts：enhanceSubagentSystemPrompt 含 git 仓库检测 + Shell + 技能描述
- spawn-agent-tool.ts：fork 参数 → forkMode/parentSystem 传递
- role-agents.test.ts：确认 explore/plan 白名单含 load_skill
- **fork 集成测试**：fork=true 时子代理继承 parentSystem + 黑名单仍生效（spawn_agent 被移除）

## 完成标准

- 子代理 system prompt 含完整环境信息（CWD/git/Shell/Platform）
- 子代理能看到可用技能列表
- fork 参数可触发继承主 agent system prompt 的子代理
- tsc + 相关测试通过
