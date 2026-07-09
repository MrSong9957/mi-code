# Plan 模式实现方案（代码级强约束）

> **现状说明（2026-07 更新）**
>
> 本文档下半部分的 `PlanModeManager` + `plan-mode-interceptor` 设计**未采纳**，仅作为
> 思想参考保留（"代码级强制优于提示词"这一核心观点仍然成立）。
>
> 实际落地采用**基于现有 `PermissionChecker` 的收口方案**——理由：
> 1. 项目里 Plan 模式早已是 `PermissionChecker` 的一种 mode（`src/permission/checker.ts`
>    闸门 3），并行新建一套 `PlanModeManager` 会与现有权限规则、危险命令检查、越界路径
>    检查重复甚至冲突。
> 2. 原 `ToolRegistry` 是薄壳，没有"注册时包装 executor"的扩展点；强行加会侵入核心。
> 3. 真正的痛点是：主入口 `streamingQuery` 路径**根本没接 `PermissionChecker`**，
>    `/mode plan` 对主循环零生效。原方案没识别到这点。
>
> **实际实现位置**：
> - `src/agent/streaming-executor.ts` —— 构造函数新增可选 `permissionChecker`，在
>   `executeTool()` 调 registry 前做 deny 检查。
> - `src/agent/streaming-query.ts` —— `StreamingQueryOptions.permissionChecker` 字段；
>   透传给 `StreamingToolExecutor`；兜底串行分支用 `checkPermissionOrBlock()` 预检。
> - `src/index.ts` —— 把已有的 `permissionChecker` 实例（与 `/mode` 命令共用）传给
>   `streamingQuery`。
> - 测试：`src/__tests__/plan-mode-streaming.test.ts`。
>
> **拦截策略**：deny 决策拦下并返回 `[Blocked by permission] <reason>`；ask 决策保持
> 旧行为（放行），因为流式路径暂无用户确认通道，强降级会回归 default 模式的写功能。

---

## 问题

Claude Code 的 Plan 模式只靠提示词约束，AI 经常忽略限制直接执行修改。
需要在**代码层**强制拦截，不依赖 AI 自觉。

## 架构设计

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Loop                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Tool Registry                        │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │         Plan Mode Interceptor               │  │  │
│  │  │  ┌─────────┐  ┌──────────┐  ┌───────────┐  │  │  │
│  │  │  │ State   │→ │ Checker  │→ │ Executor  │  │  │  │
│  │  │  │ Manager │  │          │  │ (wrapped) │  │  │  │
│  │  │  └─────────┘  └──────────┘  └───────────┘  │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. Plan Mode 状态管理器

```typescript
// src/agent/plan-mode.ts

export interface PlanModeState {
  /** 是否处于 plan 模式 */
  isActive: boolean;
  /** Plan 文件路径 */
  planFilePath: string | null;
  /** Plan 文件内容缓存 */
  planContent: string;
  /** 允许写入的路径列表（plan 文件 + 临时文件） */
  allowedWritePaths: Set<string>;
  /** 进入时间 */
  enteredAt: Date | null;
}

export class PlanModeManager {
  private state: PlanModeState = {
    isActive: false,
    planFilePath: null,
    planContent: '',
    allowedWritePaths: new Set(),
    enteredAt: null,
  };

  /** 进入 plan 模式 */
  enter(planDir: string): string {
    // 生成 plan 文件路径
    const planFileName = `plan-${Date.now()}.md`;
    const planFilePath = join(planDir, planFileName);
    
    this.state = {
      isActive: true,
      planFilePath,
      planContent: '',
      allowedWritePaths: new Set([planFilePath]),
      enteredAt: new Date(),
    };

    return planFilePath;
  }

  /** 退出 plan 模式 */
  exit(): { planContent: string; planFilePath: string } {
    const result = {
      planContent: this.state.planContent,
      planFilePath: this.state.planFilePath!,
    };

    this.state = {
      isActive: false,
      planFilePath: null,
      planContent: '',
      allowedWritePaths: new Set(),
      enteredAt: null,
    };

    return result;
  }

  /** 检查是否允许写入 */
  canWrite(filePath: string): boolean {
    if (!this.state.isActive) return true;
    return this.state.allowedWritePaths.has(resolve(filePath));
  }

  /** 更新 plan 内容 */
  updatePlanContent(content: string): void {
    this.state.planContent = content;
  }

  /** 获取当前状态 */
  getState(): Readonly<PlanModeState> {
    return this.state;
  }
}
```

### 2. Plan Mode 拦截器（核心）

```typescript
// src/agent/plan-mode-interceptor.ts

import type { ToolExecutor, ToolDefinition } from './types.js';
import type { PlanModeManager } from './plan-mode.js';

/**
 * Plan Mode 拦截器
 * 
 * 物理本质：门卫。
 * 所有要出门（写文件）的快递都要先过门卫检查。
 * 门卫只认一张通行证（plan 文件），其他一律拦下。
 */
export function createPlanModeInterceptor(
  manager: PlanModeManager,
): (definition: ToolDefinition, executor: ToolExecutor) => ToolExecutor {
  
  return (definition, originalExecutor) => {
    return async (input) => {
      const state = manager.getState();
      
      // Plan 模式未激活，直接执行
      if (!state.isActive) {
        return originalExecutor(input);
      }

      // 根据工具类型检查
      switch (definition.name) {
        case 'write_file':
        case 'edit_file':
          return this.checkWriteTool(definition.name, input, state, originalExecutor);
        
        case 'run_bash':
          return this.checkBashTool(input, state, originalExecutor);
        
        case 'exit_plan_mode':
          // exit_plan_mode 总是允许
          return originalExecutor(input);
        
        case 'enter_plan_mode':
          // 已在 plan 模式，拒绝再次进入
          return 'Error: Already in plan mode. Use exit_plan_mode to leave.';
        
        default:
          // 其他工具（read_file, glob, grep 等）总是允许
          return originalExecutor(input);
      }
    };
  };

  /**
   * 检查写工具
   */
  async function checkWriteTool(
    toolName: string,
    input: Record<string, unknown>,
    state: PlanModeState,
    executor: ToolExecutor,
  ): Promise<string> {
    const filePath = resolve(input.path as string);
    
    // 检查是否在允许列表中
    if (state.allowedWritePaths.has(filePath)) {
      return executor(input);
    }

    // 被拦截！返回错误信息
    const message = [
      `[PLAN MODE BLOCKED] ${toolName} was blocked because you are in plan mode.`,
      ``,
      `Plan mode restrictions:`,
      `- You can ONLY write to the plan file: ${state.planFilePath}`,
      `- All other file modifications are blocked by the system.`,
      ``,
      `To exit plan mode and make changes, call exit_plan_mode tool.`,
      `To write to the plan file, use the plan file path: ${state.planFilePath}`,
    ].join('\n');

    return message;
  }

  /**
   * 检查 bash 工具
   */
  async function checkBashTool(
    input: Record<string, unknown>,
    state: PlanModeState,
    executor: ToolExecutor,
  ): Promise<string> {
    const command = input.command as string;
    
    // 检测写操作命令
    const writePatterns = [
      /\bmkdir\b/,
      /\btouch\b/,
      /\brm\b/,
      /\bcp\b/,
      /\bmv\b/,
      /\bchmod\b/,
      /\bchown\b/,
      /\bsudo\b/,
      /\bgit\s+(add|commit|push|pull|merge|rebase)\b/,
      /\bnpm\s+(install|publish)\b/,
      /\byarn\s+(add|install|publish)\b/,
      /\bpip\s+install\b/,
      />\s*\S/,  // 重定向写入
      /\|\s*tee\b/,
    ];

    for (const pattern of writePatterns) {
      if (pattern.test(command)) {
        return [
          `[PLAN MODE BLOCKED] Bash command blocked because it may modify the system.`,
          ``,
          `Command: ${command}`,
          ``,
          `Plan mode only allows read-only commands:`,
          `- ls, find, grep, cat, head, tail`,
          `- git status, git log, git diff`,
          `- Any command that doesn't modify files`,
          ``,
          `To exit plan mode, call exit_plan_mode tool.`,
        ].join('\n');
      }
    }

    // 只读命令，允许执行
    return executor(input);
  }
}
```

### 3. 修改 ToolRegistry

```typescript
// src/agent/tool-registry.ts (修改)

import { PlanModeManager } from './plan-mode.js';
import { createPlanModeInterceptor } from './plan-mode-interceptor.js';

export class ToolRegistry {
  private _tools = new Map<string, RegisteredTool>();
  private _planModeManager: PlanModeManager;
  private _interceptor: ReturnType<typeof createPlanModeInterceptor>;

  constructor() {
    this._planModeManager = new PlanModeManager();
    this._interceptor = createPlanModeInterceptor(this._planModeManager);
  }

  /** 注册工具（自动应用 plan mode 拦截） */
  register(definition: ToolDefinition, executor: ToolExecutor): void {
    // 应用拦截器
    const wrappedExecutor = this._interceptor(definition, executor);
    this._tools.set(definition.name, { definition, executor: wrappedExecutor });
  }

  /** 获取 plan mode 管理器 */
  get planMode(): PlanModeManager {
    return this._planModeManager;
  }

  // ... 其他方法不变
}
```

### 4. Plan Mode 工具

```typescript
// src/agent/tools/plan-mode-tools.ts

import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { PlanModeManager } from '../plan-mode.js';

/**
 * enter_plan_mode: 进入计划模式
 */
export function createEnterPlanModeTool(
  manager: PlanModeManager,
  planDir: string,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'enter_plan_mode',
      description: 'Enter plan mode. Only read-only operations allowed until exit_plan_mode.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    executor: async () => {
      if (manager.getState().isActive) {
        return 'Already in plan mode.';
      }

      const planFilePath = manager.enter(planDir);

      return [
        `Entered plan mode.`,
        ``,
        `Plan file: ${planFilePath}`,
        ``,
        `Restrictions:`,
        `- You can ONLY write to the plan file`,
        `- All other file modifications are BLOCKED by the system`,
        `- Read-only operations (read, grep, glob) are allowed`,
        ``,
        `When your plan is ready, call exit_plan_mode.`,
      ].join('\n');
    },
  };
}

/**
 * exit_plan_mode: 退出计划模式
 */
export function createExitPlanModeTool(
  manager: PlanModeManager,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'exit_plan_mode',
      description: 'Exit plan mode and submit plan for approval.',
      parameters: {
        type: 'object',
        properties: {
          approved: {
            type: 'boolean',
            description: 'Whether the plan is approved (for internal use)',
          },
        },
        required: [],
      },
    },
    executor: async (input) => {
      if (!manager.getState().isActive) {
        return 'Not in plan mode.';
      }

      const { planContent, planFilePath } = manager.exit();

      return [
        `Exited plan mode.`,
        ``,
        `Plan submitted for review.`,
        ``,
        `Plan content:`,
        `---`,
        planContent || '(empty plan)',
        `---`,
        ``,
        `The plan is now ready for implementation.`,
      ].join('\n');
    },
  };
}
```

### 5. 修改 Agent Loop

```typescript
// src/agent/loop.ts (修改)

export async function agentLoop(
  state: ExtendedLoopState,
  config: AgentConfig,
  client: LLMClient,
  registry: ToolRegistry,  // 现在包含 plan mode 拦截
  callbacks: LoopCallbacks = {},
  hookRunner?: HookRunner,
  backgroundManager?: BackgroundManager,
  toolUseContext?: ToolUseContext,
): Promise<string> {
  // ... 原有逻辑

  // 4. 执行工具（现在自动经过 plan mode 拦截）
  const toolCalls: ToolCall[] = response.content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use')
    .map(b => ({ id: b.id, name: b.name, input: b.input }));

  const batches = partitionToolCalls(toolCalls);
  const results: ToolResultBlock[] = [];

  for (const batch of batches) {
    for (const call of batch.calls) {
      callbacks.onToolCall?.(call.name, call.input);

      // Plan mode 拦截在这里自动生效
      // 因为 registry.execute() 内部调用的是 wrapped executor
      const rawOutput = await registry.execute(call.name, call.input);
      
      // ... 后续处理
    }
  }

  // ... 其余逻辑
}
```

## 使用流程

### 1. 进入 Plan 模式

```
用户: "帮我实现一个用户认证系统"

AI: [调用 enter_plan_mode]

系统: "Entered plan mode. Plan file: plan-123456.md"
```

### 2. Plan 模式中探索

```
AI: [调用 read_file 读取 auth.ts]  ✅ 允许
AI: [调用 glob 搜索相关文件]       ✅ 允许
AI: [调用 grep 搜索认证模式]       ✅ 允许

AI: [调用 write_file 修改 auth.ts]  ❌ BLOCKED
系统: "[PLAN MODE BLOCKED] You can ONLY write to the plan file"
```

### 3. 写入 Plan 文件

```
AI: [调用 write_file 写入 plan-123456.md]  ✅ 允许
系统: "File written: plan-123456.md"
```

### 4. 退出 Plan 模式

```
AI: [调用 exit_plan_mode]

系统: "Exited plan mode. Plan submitted for review."
     "The plan is now ready for implementation."
```

## 优势

1. **代码级强制**：不依赖 AI 自觉，系统自动拦截
2. **清晰错误信息**：告诉 AI 为什么被拦截，如何解决
3. **精确控制**：只有 plan 文件可写，其他一律禁止
4. **Bash 保护**：检测写操作命令并拦截
5. **向后兼容**：不影响非 plan 模式的正常使用

## 与 Claude Code 的区别

| 特性 | Claude Code | MiMoCode (新) |
|------|-------------|---------------|
| 约束方式 | 提示词 | 代码级强制 |
| 拦截位置 | 无 | ToolRegistry.execute() |
| 错误处理 | 忽略提示词继续执行 | 返回错误，阻止执行 |
| 用户体验 | 可能意外修改文件 | 严格保护，只能写 plan 文件 |
