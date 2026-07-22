# 子代理 CC 对标 — 环境信息 + 技能发现 + fork 模式

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让子代理有更完整的环境感知、能看到可用技能、支持 fork 继承主 agent system prompt。

**Architecture:** 三个独立改动，都聚焦在 subagent.ts / spawn-agent-tool.ts / index.ts 三个文件。TDD 优先。

**Tech Stack:** TypeScript ESM, Vitest, Node.js

---

### Task 1: 环境信息补全（git 仓库检测 + Shell）

**Files:**
- Modify: `src/agent/subagent.ts:89-100`（enhanceSubagentSystemPrompt）

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/role-agents.test.ts` 末尾的 describe 块内新增（或新建测试文件）：

```ts
import { existsSync } from 'fs';
import { join } from 'path';

it('enhanceSubagentSystemPrompt 含 git 仓库检测和 Shell 信息', () => {
  // enhanceSubagentSystemPrompt 是私有函数，通过 runSubagent 的输出间接验证不现实。
  // 改为导出它（或测试其效果——子代理 system prompt 含这些字段）。
  // 最简方案：导出 enhanceSubagentSystemPrompt 供测试。
  const { enhanceSubagentSystemPrompt } = require('../agent/subagent.js');
  const result = enhanceSubagentSystemPrompt('base prompt');
  expect(result).toContain('Platform:');
  expect(result).toContain('Shell:');
  expect(result).toContain('git repository');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/role-agents.test.ts -t "git 仓库检测"`
Expected: FAIL（enhanceSubagentSystemPrompt 未导出，且不含 git/Shell 字段）

- [ ] **Step 3: 实现**

改 `src/agent/subagent.ts`：

1. 导出 `enhanceSubagentSystemPrompt`（加 export）
2. 补充 git 检测 + Shell：

```ts
import { existsSync } from 'fs';
import { join } from 'path';

export function enhanceSubagentSystemPrompt(baseSystem: string): string {
  const isGitRepo = existsSync(join(process.cwd(), '.git'));
  const shell = process.env.SHELL ?? process.env.ComSpec ?? 'unknown';
  return [
    baseSystem,
    '',
    'Notes:',
    '- Use absolute file paths in your responses.',
    '- Do not use emojis.',
    '- Do not use a colon before tool calls.',
    `- Working directory: ${process.cwd()}`,
    `- Platform: ${process.platform}`,
    `- Shell: ${shell}`,
    `- Is a git repository: ${isGitRepo}`,
  ].join('\n');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/role-agents.test.ts -t "git 仓库检测"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/subagent.ts src/__tests__/role-agents.test.ts
git commit -m "feat(subagent): add git repo detection and shell info to env prompt"
```

---

### Task 2: 子代理技能发现

**Files:**
- Modify: `src/agent/subagent.ts`（SubagentOptions + enhanceSubagentSystemPrompt）
- Modify: `src/agent/tools/spawn-agent-tool.ts`（接收 skillsDescription）
- Modify: `src/index.ts`（传入 skillRegistry.describeAvailable()）

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/role-agents.test.ts` 新增：

```ts
it('enhanceSubagentSystemPrompt 追加技能描述', () => {
  const { enhanceSubagentSystemPrompt } = require('../agent/subagent.js');
  const result = enhanceSubagentSystemPrompt('base', { skillsDescription: 'Available skills: test-skill' });
  expect(result).toContain('Available skills: test-skill');
});

it('enhanceSubagentSystemPrompt 无技能描述时不追加', () => {
  const { enhanceSubagentSystemPrompt } = require('../agent/subagent.js');
  const result = enhanceSubagentSystemPrompt('base');
  expect(result).not.toContain('Available skills');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/role-agents.test.ts -t "技能描述"`
Expected: FAIL（enhanceSubagentSystemPrompt 不接收第二个参数）

- [ ] **Step 3: 改 subagent.ts**

1. SubagentOptions 新增字段：

```ts
export interface SubagentOptions {
  // ... 现有字段 ...
  /** 可用技能描述（注入子代理 system prompt） */
  skillsDescription?: string;
}
```

2. enhanceSubagentSystemPrompt 签名改为接收可选参数：

```ts
export function enhanceSubagentSystemPrompt(
  baseSystem: string,
  options?: { skillsDescription?: string },
): string {
  const isGitRepo = existsSync(join(process.cwd(), '.git'));
  const shell = process.env.SHELL ?? process.env.ComSpec ?? 'unknown';
  const lines = [
    baseSystem,
    '',
    'Notes:',
    '- Use absolute file paths in your responses.',
    '- Do not use emojis.',
    '- Do not use a colon before tool calls.',
    `- Working directory: ${process.cwd()}`,
    `- Platform: ${process.platform}`,
    `- Shell: ${shell}`,
    `- Is a git repository: ${isGitRepo}`,
  ];
  if (options?.skillsDescription) {
    lines.push('', 'Available skills:', options.skillsDescription);
  }
  return lines.join('\n');
}
```

3. runSubagent 中调用处改为传 options：

```ts
// 约在 runSubagent 函数内 effectiveSystem 构造处
const effectiveSystem = enhanceSubagentSystemPrompt(baseSystem, {
  skillsDescription: options.skillsDescription,
});
```

- [ ] **Step 4: 改 spawn-agent-tool.ts**

createSpawnAgentTool 新增参数 `skillsDescription?: string`（或 `skillRegistry?: SkillRegistry`）。
executor 中传给 runSubagentFn 的 options：

```ts
const result = await runSubagentFn(prompt, childTools, {
  role: role as Role,
  client: clientProvider ? clientProvider(modelChoice) : undefined,
  permissionChecker,
  maxSteps,
  skillsDescription,
});
```

- [ ] **Step 5: 改 index.ts**

createSpawnAgentTool 调用处传入 skillsDescription：

```ts
const spawnAgentTool = createSpawnAgentTool(
  childToolRegistry,
  subagentClientProvider,
  permissionChecker,
  runSubagent,
  skillRegistry.describeAvailable(),  // skillsDescription 快照
);
```

> 技能列表如果 >20 个，describeAvailable() 应只返回前 20 个名称+一行描述。如果 describeAvailable() 本身不截断，在传入前截断：`skillRegistry.describeAvailable().split('\n').slice(0, 20).join('\n')`。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run src/__tests__/role-agents.test.ts`
Expected: PASS

- [ ] **Step 7: tsc 检查**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add src/agent/subagent.ts src/agent/tools/spawn-agent-tool.ts src/index.ts src/__tests__/role-agents.test.ts
git commit -m "feat(subagent): inject skill discovery into subagent system prompt"
```

---

### Task 3: fork 模式

**Files:**
- Modify: `src/agent/tools/spawn-agent-tool.ts`（fork 参数 + description）
- Modify: `src/index.ts`（lastSystemPrompt + getParentSystemPrompt 闭包）

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/role-agents.test.ts` 的 createSpawnAgentTool describe 块新增：

```ts
it('fork=true 时传 forkMode + parentSystem 给 runner', async () => {
  const captured = { options: null as SubagentOptions | null };
  const tool = createSpawnAgentTool(
    fakeRegistry,
    undefined,
    undefined,
    makeFakeRunner(captured),
    undefined,
    () => 'parent system prompt',  // getParentSystemPrompt
  );
  await tool.executor({ role: 'general', prompt: 'do something', fork: true });
  expect(captured.options?.forkMode).toBe(true);
  expect(captured.options?.parentSystem).toBe('parent system prompt');
});

it('fork=false/省略时不传 forkMode', async () => {
  const captured = { options: null as SubagentOptions | null };
  const tool = createSpawnAgentTool(
    fakeRegistry,
    undefined,
    undefined,
    makeFakeRunner(captured),
    undefined,
    () => 'parent system prompt',
  );
  await tool.executor({ role: 'general', prompt: 'do something' });
  expect(captured.options?.forkMode).toBeFalsy();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/role-agents.test.ts -t "fork"`
Expected: FAIL（createSpawnAgentTool 不接收 getParentSystemPrompt 参数，executor 不处理 fork）

- [ ] **Step 3: 改 spawn-agent-tool.ts**

1. 函数签名加 `getParentSystemPrompt?: () => string`：

```ts
export function createSpawnAgentTool(
  childTools: ToolRegistry,
  clientProvider?: SubagentClientProvider,
  permissionChecker?: PermissionChecker,
  runSubagentFn: SubagentRunner = runSubagent,
  skillsDescription?: string,
  /** 获取主 agent 当前 system prompt（fork 模式用） */
  getParentSystemPrompt?: () => string,
): { definition: ToolDefinition; executor: ToolExecutor } {
```

2. 工具 parameters 加 fork：

```ts
properties: {
  role: { type: 'string', description: 'Role of the subagent.' },
  prompt: { type: 'string', description: '...' },
  fork: {
    type: 'boolean',
    description: 'Set to true for a subagent that inherits your full system prompt. Use when you need a worker with your exact capabilities for an independent parallel subtask.',
  },
},
```

3. description 追加 fork 说明。

4. executor 处理 fork：

```ts
const fork = input.fork === true;
if (fork && !getParentSystemPrompt) {
  return 'Error: fork mode requires parent system prompt access, which is not configured.';
}

const result = await runSubagentFn(prompt, childTools, {
  role: fork ? undefined : role as Role,  // fork 不走角色白名单，继承父工具池
  client: clientProvider ? clientProvider('inherit') : undefined,
  permissionChecker,
  maxSteps: fork ? 50 : maxSteps,  // fork 用更大的步数
  skillsDescription,
  forkMode: fork,
  parentSystem: fork ? getParentSystemPrompt!() : undefined,
});
```

- [ ] **Step 4: 改 index.ts**

1. 模块级变量存当前 system prompt：

```ts
// 在文件顶部（模块级变量区）
let lastSystemPrompt = '';
```

2. 主循环 systemPrompt 构造后存入：

```ts
const systemPrompt = [...].join('\n');
lastSystemPrompt = systemPrompt;  // 供 fork 子代理继承
```

3. createSpawnAgentTool 调用传入 getParentSystemPrompt：

```ts
const spawnAgentTool = createSpawnAgentTool(
  childToolRegistry,
  subagentClientProvider,
  permissionChecker,
  runSubagent,                       // 默认
  skillRegistry.describeAvailable(), // skillsDescription
  () => lastSystemPrompt,            // getParentSystemPrompt
);
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/__tests__/role-agents.test.ts`
Expected: PASS

- [ ] **Step 6: tsc 检查**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools/spawn-agent-tool.ts src/index.ts src/__tests__/role-agents.test.ts
git commit -m "feat(subagent): fork mode — inherit main agent system prompt"
```

---

### Task 4: 最终验证

- [ ] **Step 1: 全部相关测试**

Run: `npx vitest run src/__tests__/role-agents.test.ts src/__tests__/plan-mode-filter.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts`
Expected: ALL PASS

- [ ] **Step 2: tsc**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 3: gen-prompts 幂等**

Run: `node scripts/gen-prompts.mjs`
Expected: planner.generated.ts 无变化
