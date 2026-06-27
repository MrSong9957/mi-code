# MiMo Code 提示词注入与约束机制详解

> 本文面向小白，用通俗语言解释 MiMo Code（开源 AI 编程助手）如何把"提示词"注入给大模型，以及如何约束模型的行为。每个机制都附带关键代码片段。

---

## 一句话总结

MiMo Code 通过**四层提示词拼接** + **工具描述注入** + **运行时约束标签** + **权限防火墙**，把一个"听话的编程助手"人格注入给底层大模型。

---

## 一、提示词的四个来源

模型收到的 system message 不是一段话，而是**四个来源按顺序拼接**的结果。就像做三明治一样，一层一层往上叠。

```
┌─────────────────────────────────────┐
│  ① 模型专属 Prompt（最底层）          │  ← 根据你用的模型自动选择
├─────────────────────────────────────┤
│  ② 环境 + 技能 + 指令                │  ← 你的工作目录、可用技能、规则文件
├─────────────────────────────────────┤
│  ③ 用户指令文件                      │  ← AGENTS.md / CLAUDE.md 的内容
├─────────────────────────────────────┤
│  ④ 记忆系统指令（最顶层）            │  ← 告诉模型如何使用记忆系统
└─────────────────────────────────────┘
```

### ① 模型专属 Prompt —— "你是谁"

MiMo Code 会根据你选择的模型，自动加载不同的 prompt 文件。每个文件定义了模型的"人设"和行为规范。

**关键代码** — `packages/opencode/src/session/system.ts:19-33`：

```typescript
export function provider(model: Provider.Model) {
  // 如果是 GPT-4/o1/o3 系列 → 用 "beast" prompt（最激进）
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  // 如果是 Claude 系列 → 用 "anthropic" prompt
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  // 如果是 Gemini 系列 → 用 "gemini" prompt
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  // 其他模型 → 用通用 "default" prompt
  return [PROMPT_DEFAULT]
}
```

这些 prompt 文件存放在 `packages/opencode/src/session/prompt/` 目录下：

| 文件 | 适用模型 | 风格特点 |
|------|----------|----------|
| `anthropic.txt` | Claude 系列 | 强调任务管理、代码质量、Git 安全 |
| `gpt.txt` | GPT 系列（非 4） | 强调极简主义、最小改动、前端设计 |
| `beast.txt` | GPT-4/o1/o3 | 最激进：要求模型自主迭代直到问题解决 |
| `gemini.txt` | Gemini 系列 | 强调核心规范、安全规则、工具使用 |
| `default.txt` | 其他所有模型 | 通用版本，简洁直接 |

**举个例子** — `default.txt` 开头是这样写的：

```
You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming.
```

翻译：你是 MiMoCode，一个帮助用户完成软件工程任务的交互式命令行工具。你绝不能随意生成 URL。

### ② 环境 + 技能 + 指令 —— "你在哪，能做什么"

这一层包含三个子部分：

#### 环境信息（environment）

告诉模型当前的工作环境。**关键代码** — `packages/opencode/src/session/system.ts:48-68`：

```typescript
environment(model, now) {
  return [
    [
      `You are MiMo Code Agent, built by Xiaomi MiMo Team.`,
      `You are powered by the model named ${model.api.id}.`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${Instance.directory}`,
      `  Workspace root folder: ${Instance.worktree}`,
      `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date(now).toDateString()}`,
      `</env>`,
    ].join("\n"),
    `IMPORTANT: Your response must ALWAYS strictly follow the same major language as the user.`,
  ]
}
```

这就像告诉模型："你现在在 Windows 系统上，工作目录是 E:\Files\GitHub\MiMo-Code，今天是 2026 年 6 月 26 日。"

#### 技能列表（skills）

列出所有可用的技能，告诉模型可以加载哪些专业技能。**关键代码** — `packages/opencode/src/session/system.ts:71-83`：

```typescript
skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
  const list = yield* skill.available(agent)
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    Skill.fmt(list, { verbose: true }),  // 详细列出每个技能的描述
  ].join("\n")
})
```

#### 用户指令文件（instructions）

加载项目中的 `AGENTS.md`、`CLAUDE.md` 等规则文件。**关键代码** — `packages/opencode/src/session/instruction.ts:17-21`：

```typescript
const FILES = [
  "AGENTS.md",                    // 首选：项目级指令
  ...(Flag.MIMOCODE_DISABLE_CLAUDE_CODE_PROMPT ? [] : ["CLAUDE.md"]),  // 备选
  "CONTEXT.md",                   // 已废弃
]
```

这些文件从当前工作目录**向上搜索**，找到第一个匹配的就加载。相当于把你在项目里写的"规则手册"喂给模型。

### ③ 用户指令文件的内容

当模型读取 `AGENTS.md` 或 `CLAUDE.md` 时，文件内容会作为 system message 的一部分注入。例如你的项目根目录有一个 `AGENTS.md`，里面写了：

```markdown
# 项目规范
- 使用 TypeScript 编写
- 所有函数必须有类型注解
- 测试覆盖率要求 80%
```

这些内容会被拼接到 system prompt 中，模型就会遵守这些规范。

### ④ 记忆系统指令 —— "如何记住东西"

最后一层是记忆系统的操作指南，告诉模型如何使用文件记忆系统。**关键代码** — `packages/opencode/src/session/llm.ts:99-179`：

```typescript
function buildMemoryInstructions(sessionID, projectID, memoryRoot) {
  return `# Memory system

You have a persistent file-based memory system. Four file types:

- Project memory at \`${memoryFile}\` — persistent across all sessions in this project.
- Session checkpoint at \`${checkpointFile}\` — current session's structured state.
- Per-task progress at \`${sessionMemoryDir}/tasks/<id>/progress.md\` — writer-derived splitover.
- Global memory at \`${globalMemoryFile}\` — user-level preferences.

## When to Edit MEMORY.md directly
You may Edit MEMORY.md when:
- User states a project-level rule that should hold across sessions → ## Rules
- User states a project-level architectural decision → ## Architecture decisions
...

## Active recall protocol
After a checkpoint rebuild, the following dumps may be already in your context...
`
}
```

这就像给模型一本"记忆操作手册"：告诉它哪些文件可以读、哪些不能改、什么时候该记住什么。

---

## 二、提示词的拼接流程

所有四层最终会在 `buildSystemArray()` 函数中拼接成一个字符串数组。**关键代码** — `packages/opencode/src/session/llm.ts:234-296`：

```typescript
const buildSystemArray = Effect.fn("LLM.buildSystemArray")(function* (input) {
  const system: string[] = []
  system.push(
    [
      // 第一层：agent 的 prompt（如果有）或模型专属 prompt
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      // 第二层：调用方传入的额外内容（环境 + 技能 + 指令）
      ...input.system,
      // 第三层：用户消息中附带的 system 内容
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  )

  // 第四层：记忆系统指令（仅主 agent，跳过系统生成的 actor）
  if (!isSystemActor) {
    system.push(buildMemoryInstructions(...))
  }

  return system  // 返回字符串数组，每个元素最终变成一条 system message
})
```

最终，这个 `system` 数组会和用户消息、工具定义一起发送给模型 API：

```typescript
// packages/opencode/src/session/llm.ts:362-370
const messages = [
  ...system.map((x) => ({
    role: "system",
    content: x,
  })),
  ...input.messages,  // 用户消息和历史对话
]
```

---

## 三、工具如何被"介绍"给模型

MiMo Code 不只是给模型一段话，还会把每个工具的**名称、描述、参数 schema** 一起发送给模型。这样模型就知道"我有哪些能力"。

### 工具定义方式

每个工具通过 `Tool.define()` 定义，包含 id、description、parameters 和 execute 函数。**关键代码** — `packages/opencode/src/tool/tool.ts:38-53`：

```typescript
export interface Def<Parameters extends z.ZodType> {
  id: string                    // 工具名称，如 "bash", "read", "edit"
  description: string           // 工具描述，告诉模型这个工具干什么
  parameters: Parameters        // 参数 schema（用 Zod 定义）
  execute(args, ctx): Effect    // 实际执行逻辑
  shell?: { ... }               // 可选的 shell 模式定义
}
```

### 工具描述文件

每个工具的描述存放在对应的 `.txt` 文件中。例如 `bash.txt` 告诉模型：

```
Executes a given bash command in a persistent shell session...

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc.
DO NOT use it for file operations (reading, writing, editing, searching, finding files) —
use the specialized tools for this instead.
```

翻译：这个工具用来执行终端命令。不要用它来读写文件，用专门的工具。

### 工具注册中心

所有工具在 `registry.ts` 中统一注册。**关键代码** — `packages/opencode/src/tool/registry.ts:209-264`：

```typescript
const tool = yield* Effect.all({
  bash: Tool.init(bash),
  read: Tool.init(read),
  glob: Tool.init(globtool),
  grep: Tool.init(greptool),
  edit: Tool.init(edit),
  write: Tool.init(writetool),
  actor: Tool.init(actor),      // 子代理工具
  task: Tool.init(tasktask),    // 任务管理工具
  skill: Tool.init(skilltool),  // 技能加载工具
  // ... 还有十几个其他工具
})

return {
  builtin: [
    tool.bash, tool.read, tool.glob, tool.grep,
    tool.edit, tool.write, tool.actor, tool.task,
    // ...
  ],
}
```

### 动态工具描述

某些工具的描述会根据 agent 动态变化。例如 `actor` 工具会附带当前可用的子代理列表：

```typescript
// packages/opencode/src/tool/registry.ts:366-373
return {
  id: tool.id,
  description: [
    description,
    tool.id === ActorTool.id ? yield* describeTask(input.agent) : undefined,  // 动态添加子代理列表
    tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined, // 动态添加技能列表
  ]
    .filter(Boolean)
    .join("\n"),
}
```

---

## 四、Agent 角色系统 —— "不同角色不同人格"

MiMo Code 定义了多个内置 agent，每个 agent 有独立的 prompt、权限和工具白名单。

**关键代码** — `packages/opencode/src/agent/agent.ts:122-389`：

```typescript
const agents: Record<string, Info> = {
  build: {
    name: "build",
    description: "Executes tools based on configured permissions.",
    mode: "primary",           // 主 agent，用户直接交互
    permission: Permission.merge(defaults, { question: "allow" }, user),
  },
  plan: {
    name: "plan",
    description: "Plan mode. Disallows all edit tools.",
    mode: "primary",
    // 硬编码权限：只允许编辑计划文件，其他文件一律禁止
    hardPermission: Permission.fromConfig({
      edit: {
        "*": "deny",                                    // 默认禁止所有编辑
        [".mimocode/plans/*.md"]: "allow",              // 但计划文件可以编辑
      },
    }),
  },
  explore: {
    name: "explore",
    prompt: PROMPT_EXPLORE,    // 专用的探索 prompt
    mode: "subagent",          // 子代理模式
    permission: Permission.merge(defaults, {
      "*": "deny",             // 默认禁止所有工具
      grep: "allow",           // 只允许搜索类工具
      glob: "allow",
      read: "allow",
      bash: "allow",           // 允许 bash（用于 git status 等）
    }),
  },
  "checkpoint-writer": {
    name: "checkpoint-writer",
    mode: "subagent",
    // 没有 prompt 字段！它继承父 agent 的完整 LLM 请求前缀
    // 这是 fork agent 合约：在生成时冻结父 agent 的 system + tools + messages
  },
}
```

### 角色差异对比

| Agent | 用途 | 能做什么 | 不能做什么 |
|-------|------|----------|------------|
| `build` | 执行构建任务 | 几乎所有工具 | 无特殊限制 |
| `plan` | 制定计划 | 只读工具 + 编辑计划文件 | 不能编辑其他文件 |
| `explore` | 探索代码库 | grep/glob/read/bash | 不能编辑文件 |
| `general` | 通用子代理 | 大部分工具 | 不能切换目录 |
| `title` | 生成标题 | 无工具 | 只能输出文本 |
| `checkpoint-writer` | 写入检查点 | 继承父 agent 的工具 | 受内存路径守卫限制 |

---

## 五、运行时约束机制 —— "对话中途塞入额外指令"

除了静态的 system prompt，MiMo Code 还会在对话过程中**动态注入约束**。

### `<system-reminder>` 标签

当模型进入计划模式时，会在用户消息中注入一个巨大的 `<system-reminder>` 标签。**关键代码** — `packages/opencode/src/session/prompt.ts:536-618`：

```typescript
const part = yield* sessions.updatePart({
  type: "text",
  text: `<system-reminder>
Plan mode is active. The user wants you to research and design, NOT to execute yet.

## What you SHOULD do (recommended)
- Prefer the dedicated read-only tools: \`read\`, \`grep\`, \`glob\`, \`lsp\`
- Spawn \`explore\`/\`general\` subagents for parallel research.

## What you MUST NOT do
- Do NOT edit or create any file other than the plan file below.
- Do NOT run \`test\`, \`lint\`, \`typecheck\`, \`build\`, or similar project commands.
- Do NOT run any other side-effecting \`bash\`.

## Plan File Info:
A plan file exists at ${plan}. You should read it and make incremental edits.
</system-reminder>`,
  synthetic: true,  // 标记为"合成"消息，不是用户真实输入
})
userMessage.parts.push(part)
```

这就像在用户消息后面偷偷塞了一张"小纸条"，告诉模型："你现在只能看不能动。"

### MAX_STEPS 提示

当模型执行步数达到上限时，会注入停止提示。**关键代码** — `packages/opencode/src/session/prompt.ts:3156`：

```typescript
messages: [
  ...modelMsgs,
  ...(isLastStep ? [{ role: "user", content: MAX_STEPS }] : []),
],
```

### 文本循环恢复

如果模型陷入重复输出（比如一直说同样的话），系统会检测并注入恢复提示：

```typescript
// packages/opencode/src/session/prompt/text-loop-recovery.ts
export const RECOVERY_PROMPT_MILD = "..."
export const RECOVERY_PROMPT_STRONG = "..."
```

---

## 六、权限防火墙 —— "模型想做但不被允许"

权限系统是最后一道防线。即使 prompt 告诉模型"你可以做 X"，权限系统也可能阻止它。

### 权限评估流程

每次工具调用前，都会经过权限检查。**关键代码** — `packages/opencode/src/session/prompt.ts:684-698`：

```typescript
ask: (req) =>
  permission.ask({
    ...req,
    sessionID: input.session.id,
    ruleset: Agent.runtimePermission(input.agent, input.session.permission),
    interactive: !SYSTEM_SPAWNED_AGENT_TYPES.has(input.agent.name),
  })
```

### 权限合并规则

权限由三层合并而成：**默认权限 + 用户配置 + 硬编码权限**。**关键代码** — `packages/opencode/src/agent/agent.ts:84-86`：

```typescript
export function runtimePermission(agent: Info, permission?: Permission.Ruleset) {
  return Permission.merge(
    agent.permission,      // agent 自身的权限
    permission ?? [],      // 用户/会话级权限
    agent.hardPermission ?? []  // 硬编码权限（不可被用户覆盖）
  )
}
```

### Plan 模式的硬编码约束

Plan agent 的 `hardPermission` 确保即使用户配置了 `edit: "allow"`，也**无法编辑计划文件以外的任何文件**：

```typescript
hardPermission: Permission.fromConfig({
  edit: {
    "*": "deny",                                    // 默认拒绝
    [".mimocode/plans/*.md"]: "allow",              // 仅允许计划文件
  },
}),
```

### 内存路径守卫

`checkpoint-writer` agent 只能写入特定的内存文件，不能越界。**关键代码** — `packages/opencode/src/tool/memory-path-guard.ts`：

```typescript
// Main agent CAN write <pid>/MEMORY.md and <sid>/checkpoint.md
// 但不能写入其他路径
```

---

## 七、完整流程图

```
用户输入: "帮我修复这个 bug"
         │
         ▼
┌─────────────────────────────────────────────┐
│ 1. 加载模型专属 Prompt                        │
│    (anthropic.txt / gpt.txt / ...)           │
├─────────────────────────────────────────────┤
│ 2. 拼接环境信息                               │
│    工作目录、git 状态、平台、日期               │
├─────────────────────────────────────────────┤
│ 3. 拼接技能列表                               │
│    可用的 skill 名称和描述                     │
├─────────────────────────────────────────────┤
│ 4. 加载用户指令文件                            │
│    AGENTS.md / CLAUDE.md 的内容              │
├─────────────────────────────────────────────┤
│ 5. 拼接记忆系统指令                            │
│    如何读写 MEMORY.md / checkpoint.md         │
├─────────────────────────────────────────────┤
│ 6. 注入工具定义                               │
│    bash, read, edit, grep, glob, ...         │
│    每个工具的名称 + 描述 + 参数 schema         │
├─────────────────────────────────────────────┤
│ 7. 发送给模型 API                             │
│    system messages + tool definitions        │
│    + user message + history                  │
└─────────────────────────────────────────────┘
         │
         ▼
模型返回: 调用 bash 工具运行测试
         │
         ▼
┌─────────────────────────────────────────────┐
│ 8. 权限检查                                   │
│    这个 agent 能用 bash 吗？                  │
│    这个操作需要用户确认吗？                    │
├─────────────────────────────────────────────┤
│ 9. 执行工具                                   │
│    运行命令，返回结果                          │
├─────────────────────────────────────────────┤
│ 10. 结果注入对话                               │
│     工具输出作为 tool-result 消息              │
│     可能触发 <system-reminder> 注入           │
└─────────────────────────────────────────────┘
         │
         ▼
     继续下一轮循环...
```

---

## 八、关键文件速查表

| 机制 | 文件路径 | 行号 |
|------|----------|------|
| System prompt 拼接入口 | `packages/opencode/src/session/llm.ts` | 234-296 |
| 模型 prompt 选择 | `packages/opencode/src/session/system.ts` | 19-33 |
| 环境信息注入 | `packages/opencode/src/session/system.ts` | 48-68 |
| 技能列表注入 | `packages/opencode/src/session/system.ts` | 71-83 |
| 指令文件加载 | `packages/opencode/src/session/instruction.ts` | 17-21, 181-198 |
| 记忆系统指令 | `packages/opencode/src/session/llm.ts` | 99-179 |
| Agent 定义 | `packages/opencode/src/agent/agent.ts` | 122-389 |
| 工具注册中心 | `packages/opencode/src/tool/registry.ts` | 209-264 |
| 工具定义接口 | `packages/opencode/src/tool/tool.ts` | 38-53 |
| RunLoop 主循环 | `packages/opencode/src/session/prompt.ts` | 3099-3156 |
| 计划模式约束注入 | `packages/opencode/src/session/prompt.ts` | 536-618 |
| 权限合并逻辑 | `packages/opencode/src/agent/agent.ts` | 84-86 |
| Plan 硬编码权限 | `packages/opencode/src/agent/agent.ts` | 188-194 |
| 内存路径守卫 | `packages/opencode/src/tool/memory-path-guard.ts` | 全文 |

---

## 九、总结

MiMo Code 的提示词系统可以概括为 **"四层拼接 + 工具注入 + 运行时约束 + 权限防火墙"**：

1. **四层拼接**：模型 prompt → 环境/技能/指令 → 用户规则文件 → 记忆系统指令，按顺序拼成完整的 system message
2. **工具注入**：每个工具的名称、描述、参数 schema 作为 `tools` 参数发送给模型，让模型知道"我有哪些能力"
3. **运行时约束**：通过 `<system-reminder>` 标签在对话中途动态注入额外指令（如 plan 模式的只读约束）
4. **权限防火墙**：即使 prompt 允许，权限系统也可能阻止危险操作；`hardPermission` 确保某些约束不可被用户覆盖

这套机制确保了模型既能高效完成任务，又不会做出危险或越界的操作。
