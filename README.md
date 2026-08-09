# MiCode

> TypeScript CLI 工具 · 自研差量渲染引擎 · Agent 循环系统

一个用 TypeScript 从零构建的终端 AI 助手，具备完整的 Agent 循环、工具调用、技能协商、定时调度、团队协作等能力。

## 特性

### 🎨 自研 TUI 渲染引擎
- **差量渲染**：基于 `ScreenBuffer` 的双缓冲 diff 引擎，只重绘变化区域
- **CJK 全角支持**：中文字符宽度正确处理（全角=2，ASCII=1）
- **光标定位**：精确的终端光标定位，支持中文输入

### 🤖 Agent 循环
- **核心循环**：模型调用 → 工具执行 → 结果注入 → 继续推理
- **并发分区**：只读工具并行执行，写工具串行执行
- **上下文压缩**：L1/L2/L3/L4 四级压缩策略，防止上下文溢出
- **预算控制**：费用限制、轮数限制、max_output_tokens 自动升级

### 🛠 工具系统
- 内置工具：`run_bash`、`read_file`、`write_file`、`edit_file`
- 调度工具：`schedule_create`、`schedule_list`、`schedule_remove`、`schedule_update`
- 任务工具：`task`（子代理派发）、`todo_write`
- 团队工具：`send_message`、`read_inbox`、协商工具链
- 技能工具：`load_skill`（按需加载）

### 📋 技能协商协议（S10）
- **三阶段协商**：`skill()` → 子集确认 → 用户确认 → 全文加载
- **拦截机制**：`!` 前缀强制拦截，`/skill off` 永久禁用
- **跳过不可重试**：同场景内跳过的技能不会自动重试
- **置信度阈值**：`confidence >= 0.7` 自动建议

### ⏰ 定时调度（S14）
- **5 段式 Cron**：支持 `*`、`*/N`、`N-M`、`N,M`、精确匹配
- **时区对齐**：通过 `Intl.DateTimeFormat` 支持任意时区
- **持久化**：`durable` 字段控制重启后是否保留
- **冷启动追赶**：`checkCatchUp` 自动补发错过的任务
- **进程锁**：`ProcessLock` 基于 pid 的单例互斥锁

### 🔐 权限系统
- 三级模式：`build`（交互确认）、`plan`（只读）、`auto`（全自动）
- 工具级权限控制
- 模式即时切换

### 👥 团队协作
- 消息总线：`TeammateManager` 管理多代理通信
- 协商协议：`NegotiationManager` 实现任务协商
- 计划审批：提交/审批工作流

### 🔌 可扩展
- **Hook 系统**：`PreToolUse`、`PostToolUse`、`SessionStart` 钩子
- **MCP 支持**：Model Context Protocol 客户端
- **Worktree 隔离**：基于 Git worktree 的任务隔离

## 快速开始

```bash
# 安装依赖
npm install

# 运行
npx tsx src/index.ts

# 构建
npm run build
```

## 开发命令

```bash
npm test              # 运行测试
npm run test:watch    # 监听模式
npm run test:coverage # 覆盖率报告
npm run lint          # ESLint 检查
npm run typecheck     # TypeScript 类型检查
npm run build         # 编译
```

## 项目结构

```
mi-code/
├── src/
│   ├── index.ts              # 入口：TUI 渲染 + 输入处理 + Agent 集成
│   ├── render/               # 自研差量渲染引擎
│   │   ├── renderer.ts       # 节点树渲染
│   │   ├── screen.ts         # 网格屏幕缓冲区
│   │   ├── optimizer.ts      # ANSI 序列优化
│   │   └── emit.ts           # 终端输出
│   ├── agent/                # Agent 核心
│   │   ├── loop.ts           # 核心循环
│   │   ├── types.ts          # 类型定义
│   │   ├── tool-registry.ts  # 工具注册表
│   │   ├── tools/            # 内置工具
│   │   ├── scheduler/        # 定时调度系统
│   │   ├── team/             # 团队协作
│   │   └── subagent.ts       # 子代理
│   ├── skills/               # 技能协商协议
│   │   ├── negotiator.ts     # 协商器核心
│   │   ├── registry.ts       # 技能注册表
│   │   └── types.ts          # 类型定义
│   ├── commands/             # 斜杠命令系统
│   ├── config/               # 配置管理
│   ├── permission/           # 权限系统
│   ├── hooks/                # Hook 系统
│   ├── background/           # 后台任务
│   ├── memory/               # 记忆系统
│   ├── mcp/                  # MCP 客户端
│   ├── task-board/           # 任务看板
│   └── worktree/             # Git Worktree 隔离
├── skills/                   # 技能文档
├── rules/                    # ECC 规则
└── package.json
```

## 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript 6.0 |
| 运行时 | Node.js (ES2022, ESM) |
| AI SDK | Vercel AI SDK + Anthropic |
| 测试 | Vitest |
| Lint | ESLint + typescript-eslint |
| 渲染 | 自研差量引擎（ANSI 转义序列） |

## 架构演进

```
v1  Ink (React)           → 依赖重、性能差
v2  自研差量渲染引擎       → 只重绘变化区域，CJK 支持
v3  Agent 循环 + 工具系统  → 完整的 LLM 工具调用能力
v4  技能协商 + 定时调度    → S10/S14 协议实现
```

## License

ISC
