# CLAUDE.md

---

## 所有代码的开端：全流程场景模拟

作为系统架构师，Vibe Coding 前必须遵守以下规则：
1. 上下文检索：提及“我的项目”、“昨天的Bug”时，主动检索历史与长期记忆，默认契合全局/项目/本地（.local.md）堆栈。
2. 反向追问：需求过宽时禁止写代码，必须先提出 2-3 个影响架构（并发、内存、I/O）的灵魂拷问，确认前只出大纲。
3. 极致防御：严禁使用 `localStorage/sessionStorage`；关键节点必须预留堆栈级错误日志，采用原生强类型捕获异常。
4. 输出规范：代码必须原子且完整，严禁使用 `// TODO` 或省略号占位。

【场景触发】：仅当用户触发测试或首次部署时，预设 [3个] 典型业务场景进行端到端模拟运行，交付要求：
- 场景定义：一句话说明核心问题。
- 流转模拟：展示“输入 -> 处理 -> 输出”的完整闭环及核心代码。
- 边界异常：模拟最易崩溃的边界（如超时、空数据）并优雅处理。
- 瓶颈分析：模拟后指出 2-3 个潜在瓶颈并给出修改建议。

---

## 解释规范
当要求解释时，严格按以下结构输出：
- 第一性原理：从底层本质/物理限制解释。
- 底层逻辑：写成零门槛保姆级操作手册，每一步都在教一个完全不懂的人怎么做，不假设用户懂任何前置概念；严禁高阶术语，必须用生活类比（如录像机、查字典）瞬间解构底层逻辑，全面且极限简洁。

---

## Superpowers 开发工作流

### 7阶段流转
1. `brainstorming`：写代码前通过提问细化需求，分段展示设计。
2. `using-git-worktrees`：创建隔离工作区，确保测试基线干净。
3. `writing-plans`：拆解 2-5 分钟小任务（含路径、完整代码、验证步骤）。
	- 实现计划总约束：严禁输出大段成品代码，摒弃机器自底向上死板开发逻辑；统一遵循【人类直觉开发流（由表及里、先看见再补全）】与【复用至上】第一性原理；任务排版由浅入深，优先前端界面交互任务，再执行后端数据解析、存储、传输任务，最终输出带有明确返回值类型的渐进式文件骨架视图。
    - 标准任务编写结构
      a. 前端交互流程与物理认知 (User Flow & Concept)
         - 前端交互：清晰描述用户完整操作链路、页面可见内容、操作行为与预期交互反馈
         - 物理本质：用生活化模型一句话概括业务底层逻辑
         - 防御边界：识别高频崩溃异常操作，配套对应的防护设计准则
      b. 轮子复用审查 (Wheel Reuse Check)，编码前强制执行
         - 可复用轮子：先检索项目本地现有函数、工具类、API、全局状态；同步检索 GitHub 等开源资源，匹配合适方案供用户选用
         - 本次仅需新造：划定最小开发边界，仅实现无法复用的内容，杜绝重复造轮子
4. `subagent-driven-development`：独立任务分派子代理，主代理进行规格与质量双审。
5. `test-driven-development`：严格 RED-GREEN-REFACTOR。先写失败测试 → 写最小代码 → 通过 → 提交。
6. `requesting-code-review`：任务间审查，CRITICAL 缺陷（漏洞/死锁）一票否决。拒绝表演式盲从。
7. `finishing-a-development-branch`：运行验证命令，出具终端证据，选择 Merge/PR 并清理工作区。

---

## 核心规则
- 语言：中文
- 工作流：自主闭环，多次失败才请求用户介入
- 日志：实现或推荐一个极简日志方案，自动在根目录 `logs/` 下创建 `.md` 文件，仅以 `Markdown` 列表严格记录“底层逻辑、TDD 测试点、失败原因、验证结果”四项要素，严禁任何冗长流水账。
- 子代理：可并行或需隔离时用，从 `agents` 文件夹选取合适的子代理；简单操作直接做
- 设计：最简单的办法往往最可靠，不要过度设计
- 调试：先使用技能调查根本原因，然后列出清单，用户核对无误后，才准动手修复。
- 验证：没有运行证据，不声称完成。
- SKILL 技能：积极使用技能，每轮对话的第一件事是选择合适的技能。

- TDD：禁止直接写生产代码，先写回归测试作为兜底机制。每次修复或重构后，必须运行相关的回归测试（非全量测试），确保历史功能无退化。为了防止 AI 写假测试，每次修改测试后，都必须故意制造错误进行验证和补救盲区。
- 回归测试执行分级（控 token、防滥用全量）：禁止开发循环中无脑跑 `npm test` 全量。按「先窄后宽」三级执行：
  - L1 单文件（RED↔GREEN 循环、改完即验）：`npx vitest run src/路径/xxx.test.ts`，只跑当前改的测试文件。
  - L2 受影响目录（一个功能点改完、提交前自检）：`npx vitest run src/tui/inline/`（或被改模块对应的目录）。影响域判断：只改单文件→L1 即可；改了被多处 import 的核心逻辑→跑该模块目录。
  - L3 全量（仅当：用户明确要求「跑全量」/「提交」/「合并」，或改动跨多个模块时）：`npm test`。
  - 反例：前两次修复各跑了 2 次全量（1111 个 / 46s），其中开发循环中的全量纯属浪费。开发循环只跑 L1，改完最多 L2，L3 留给提交节点。

---

## 坚守 AAA 结构（三段式写测试）

不管是单元测试还是集成测试，好的测试只由三步组成：

- Arrange（准备）：初始化对象或设置模拟的 API 返回值。
- Act（执行）：调用被测的核心函数或接口。
- Assert（断言）：检验执行结果是否完美符合预期。拒绝假测试，必须进行现场物理验证：不仅检查返回值，还要实体核对副作用（如：断言不允许写文件时，必须实际检查磁盘确保无对应文件生成）。

---

## VCR 磁带模式（可选）

- 拒绝“本地通、线上挂”。能内测就纯单机，涉及外网立刻用 VCR 模式录制全量流量。确保测试在断网、无 API 密钥时也能一键秒级通过。

---

## 静态检查（Linting 规范）

- 拒绝隐患脏代码：代码不仅要通过 TypeScript 类型检查，还必须严格符合静态检查（Lint）规范。严禁留下未使用的变量/引用（no-unused-vars）、严禁出现漂流不等待的异步请求（no-floating-promises），必须保持语法树（AST）层面无任何潜在死循环或代码异味。

---

## E2E 端到端测试

TDD 测试开发完成后，进行端到端测试：

- Web 端到端（E2E）测试：模拟真实人类操作。通过无头浏览器（如 Playwright 和配套 SKILL 技能）在后台启动完整项目，自动执行输入、点击等真实动作，最终通过校验网页 DOM 结构并结合系统日志来交叉验证功能。

- CLI 端到端（E2E）测试：模拟真实人类操作。通过虚拟终端会话（如并发测试库 @commander-cli/test-utils、expect-cli 和配套 Xterm.js 布局校验技能）在后台启动完整 CLI/TUI 工具，自动执行命令输入、组合键触发等真实动作，最终通过校验终端 ANSI 渲染输出（TTY DOM）并结合系统日志来交叉验证功能。

---

## 项目信息

Claude Code 借鉴了 Ink 的组件 API 设计（Box/Text/ScrollBox 等），但整个渲染后端都是自研的 — 包括 Reconciler、Yoga 绑定、cell buffer、diff 引擎、输出管线。

目的是极致性能（cell 级 intern、blit 优化、最小 ANSI 补丁）和功能扩展（文本选择、搜索高亮、bidi 支持、OSC 8 超链接等 Ink 原版没有的能力）。

---

### 一、运行时与语言

| 约束 | 值 | 源码依据 |
|------|------|---------|
| Node.js | >= 18.0.0 | `package.json` engines |
| 模块系统 | ESM (`"type": "module"`) | `package.json` |
| TypeScript | target ES2022, strict: false, module ESNext, bundler resolution | `tsconfig.json` |
| 包管理 | pnpm + npm 双支持 | `pnpm-lock.yaml` + `package-lock.json` 共存 |
| 构建（原始） | Bun 编译时内联（`feature()`、`MACRO`、`bun:bundle`） | `scripts/build.mjs` 注释 |
| 构建（重建） | esbuild `--platform=node --target=node18 --format=esm --bundle` | `scripts/build.mjs` |

---

### 二、核心框架依赖

| 框架 | 版本 | 说明 | 源码依据 |
|------|------|------|---------|
| **React** | ^19.2.7 | UI 层核心，所有组件、hooks 基础 | `package.json` |
| **Ink** | ^7.1.0 | 声明在 `package.json` 但运行时不导入；`src/ink/` 是自研替代实现，保留 Ink 组件 API 风格 | `package.json`、`src/ink/` |
| react-dom | ^19.2.7 | React DOM 支持 | `package.json` |
| react-reconciler | ^0.33.0 | 自定义 reconciler 驱动终端渲染 | `src/ink/reconciler.ts` |
| Commander.js | ^13.1.0 | CLI 参数解析，配合 `@commander-js/extra-typings` | `package.json` |
| Zod | ^4.4.3 | Schema 验证，工具输入用 `z.strictObject` | `src/tools/` |
| lodash-es | ^4.18.1 | ESM-only 工具库 | `package.json` |
| chalk | ^5.6.2 | ESM-only 行内样式 | `package.json` |
| strip-ansi | ^7.2.0 | 可见字符宽度计算、光标定位 | `package.json` |
| usehooks-ts | ^3.1.1 | React hooks 工具集 | `package.json` |

---

### 三、UI 渲染架构（React + 自研渲染引擎）

#### 3.1 渲染管线

Claude Code 的终端 UI 基于 **React + 自研 Ink-like 渲染引擎**构建。`ink` npm 包虽然在 `package.json` 中声明，但运行时**从不导入**——`src/ink/` 是完整的自研实现，保留 Ink 的组件 API 设计但替换了全部渲染后端：

```
React 组件树 (<Box>, <Text>, <ThemedText>...)
  ↓ JSX 编译
src/ink/reconciler.ts (自定义 react-reconciler, 直接对接 React 19)
  ↓ Fiber commit → DOM 树
src/ink/dom.ts (ink-text / ink-box 节点, textStyles 结构体)
  ↓ onComputeLayout
src/ink/layout/yoga.ts (Yoga flexbox 计算位置/尺寸)
  ↓ 遍历 DOM 树
src/ink/render-node-to-output.ts (1462行: squish → wrap → applyTextStyles → 写入 Output)
  ↓
src/ink/output.ts → src/ink/screen.ts (cell buffer + CharPool/StylePool intern)
  ↓ 前后帧对比
src/ink/log-update.ts (cell 级 diff, DECSTBM 滚动优化)
  ↓
src/ink/optimizer.ts (合并光标移动, 丢弃空操作)
  ↓
src/ink/terminal.ts → writeDiffToTerminal()
  ↓
process.stdout.write()
```

关键自研模块说明：
- **`render-node-to-output.ts`**（1462行）：核心绘制器，遍历 DOM 树，将 `ink-text` 节点的文本 squish 成 `StyledSegment[]`，应用换行/截断，通过 `applyTextStyles()` 转成 ANSI，写入 Output
- **`screen.ts`**（1486行）：cell 级缓冲区，`CharPool`/`StylePool` 做字符串 intern 以最小化内存和加速 diff 比较
- **`log-update.ts`**（773行）：cell 级前后帧 diff，支持 DECSTBM 滚动优化和 BSU/ESU 原子更新
- **`optimizer.ts`**：diff 后优化，合并连续光标移动、丢弃空操作

### 3.2 关键目录

| 目录 | 职责 |
|------|------|
| `src/ink/` | 自研渲染引擎（reconciler、DOM、screen、diff、输出管线，51个文件，替代 Ink 运行时） |
| `src/ink/components/` | 基础 UI 原语（Box、Text、Button、Link、ScrollBox 等） |
| `src/components/` | 业务组件（数百个 `.tsx` 文件） |
| `src/hooks/` | React hooks（状态、副作用、键盘、语音等） |
| `src/context/` | React Context providers |
| `src/screens/` | 页面级组件（REPL、Doctor、ResumeConversation） |

### 3.3 渲染模式

- **默认模式**：Inline TUI，行级增量重绘，不使用备用屏
- **备用屏模式**：支持 `ENTER_ALT_SCREEN` / `EXIT_ALT_SCREEN`（`src/ink/termio/dec.ts`）
- `src/ink/components/AlternateScreen.tsx` 提供备用屏组件
- 两种模式共存，非互斥

### 3.4 `process.stdout.write` 的实际用途

`process.stdout.write` 在 22 个文件中使用，但**不是主渲染循环**，而是：
- 桥接层输出（`src/bridge/`）
- 流式原始输出（`src/cli/print.ts`）
- 调试/诊断边界
- 主渲染由自研引擎的 `writeDiffToTerminal()` 驱动（`src/ink/terminal.ts`）

---

## 四、工具系统架构

### 4.1 定义模式

- 核心接口 `Tool<Input, Output, P>` 含约 25-28 个方法
- 使用 `buildTool()` 构建器模式，`TOOL_DEFAULTS` 提供默认值
- Schema 用 `lazySchema(() => z.strictObject({...}))` 延迟构建

### 4.2 注册与发现

- `getAllBaseTools()` 硬编码所有内置工具数组（`src/tools.ts:193`）
- `process.env.USER_TYPE === 'ant'` 控制内部专属工具
- `feature('FLAG')` 控制实验性工具（编译时替换为 `false`）
- `assembleToolPool()` 合并内置工具 + MCP 工具（`src/tools.ts:345`）

### 4.3 权限检查链

工具执行前的三层校验：
1. `validateInput` — 输入合法性
2. `checkPermissions` — 工具特定权限逻辑
3. `ToolPermissionContext` — 通用权限规则

### 4.4 结果序列化

- `mapToolResultToToolResultBlockParam` 将 Output 转为 API 格式
- `maxResultSizeChars` 系统级上限 50000（`DEFAULT_MAX_RESULT_SIZE_CHARS`），各工具可单独声明更低值（BashTool 30K、GrepTool 20K），FileReadTool 设为 Infinity；超阈值自动持久化到磁盘

---

## 五、服务层与 MCP

### 5.1 MCP 客户端

- 3 种标准传输：StdioClientTransport、SSEClientTransport、StreamableHTTPClientTransport
- `InProcessTransport`（`src/services/mcp/InProcessTransport.ts`）：同进程内 `queueMicrotask` 异步双向通信
- 7 种配置作用域：local / user / project / dynamic / enterprise / claudeai / managed
- 完整 OAuth 2.0 流程

### 5.2 API 服务层

- 多云客户端工厂：Anthropic 直连 / AWS Bedrock / Azure Foundry / Vertex AI
- 统一 Anthropic SDK 接口（`@anthropic-ai/sdk ^0.107.0`）
- 重试策略：默认 10 次，529 过载最多 3 次

---

## 六、权限与安全模型

### 6.1 权限模式

`default | plan | acceptEdits | bypassPermissions | dontAsk | auto`

### 6.2 Auto 模式

- 两级快速路径：acceptEdits 快速通道 + safe-tool 白名单
- AI 分类器 `classifyYoloAction()` 做最终裁决
- 连续 3 次拒绝或累计 20 次拒绝 → 强制回退手动审批

### 6.3 沙箱

- 封装 `@anthropic-ai/sandbox-runtime`（bubblewrap / Seatbelt）
- 文件系统四象限：allowWrite / denyWrite / allowRead / denyRead
- 始终 denyWrite 所有 settings.json 路径

### 6.4 安全存储

- macOS：Keychain 优先 + 明文降级
- Linux/Windows：纯明文 `.credentials.json`，文件权限 `chmod 0o600`

---

## 七、构建系统

### 7.1 原始构建（Bun）

Claude Code 原始使用 Bun 的编译时内联机制：
- `feature('X')` → 编译时求值，`false` 时触发死代码消除
- `MACRO.VERSION` 等替换为字符串字面量
- `bun:bundle` 提供模块内联

### 7.2 开源重建（esbuild）

`scripts/build.mjs` 提供近似重建，5 阶段：
1. copy src → build-src
2. transform（`feature()` → `false`，MACRO 替换，bun:bundle 移除）
3. create entry wrapper
4. scan imports + 自动 stub 缺失模块
5. esbuild bundle → dist/cli.js

esbuild 参数：`--platform=node --target=node18 --format=esm --bundle`

### 7.3 启动入口

- CLI 入口 → 主入口，大量 fast-path（`--version` / `daemon` / `bridge` 等）
- 仅非 fast-path 时动态 import 主逻辑
- 顶层副作用：`profileCheckpoint`、`startMdmRawRead`、`startKeychainPrefetch`

---

## 八、关键代码模式

| 模式 | 约束 | 源码依据 |
|------|------|---------|
| Schema 定义 | `lazySchema(() => z.strictObject({...}))` | `src/entrypoints/sdk/coreSchemas.ts` |
| Feature Flag | `feature('FLAG_NAME')` 编译时替换 | `scripts/build.mjs` |
| 延迟加载 | `await import()` 为主，`require()` 用于同步场景 | `src/cli/print.ts` 等 |
| 终端渲染 | React + 自研 Ink-like 渲染引擎，`ink` npm 包运行时不使用 | `src/ink/`（51个自研文件）、`src/components/` |
| 副作用标记 | 顶层副作用需 `eslint-disable` + 原因说明 | 源码惯例 |
| 遥测埋点 | `profileCheckpoint('name')` + `logEvent()` | `src/bootstrap/state.ts` |
| 错误处理 | `toError()` 规范化 + `logError()` 记录 | `src/utils/log.ts` |
| 日志 | 优先 `logForDebugging` / `logForDiagnosticsNoPII`，`console.log` 在边界场景存在 | `src/bridge/bridgeMain.ts` |
| 结果持久化 | `maxResultSizeChars` 超阈值自动写磁盘 | `src/tools.ts` |

---

## 九、注意事项（非绝对禁止）

| 事项 | 实际约束 | 源码现实 |
|------|---------|---------|
| React/Ink | **核心依赖**，`ink` npm 包声明但运行时不导入；`src/ink/` 是自研替代 | React 250+ 文件 import；Ink 零运行时导入 |
| `require()` | **在用**，用于同步延迟加载 | `src/cli/print.ts` 等 20+ 处 |
| `console.log` | 优先用 `logForDebugging`，但边界场景允许 | `src/bridge/bridgeMain.ts` |
| localStorage/sessionStorage | Node.js 环境无此 API，自然不存在 | N/A |
| 备用屏 | 支持但非默认，inline 为主模式 | `src/ink/components/AlternateScreen.tsx` |
| `Array.toSorted` | 需兼容 Node 18，用 copy-then-sort | 运行时约束 |

---

## 十、依赖清单（核心）

```
运行时:
  react ^19.2.7          react-dom ^19.2.7       react-reconciler ^0.33.0
  ink ^7.1.0             (声明但运行时不导入)    usehooks-ts ^3.1.1      commander ^13.1.0
  zod ^4.4.3             lodash-es ^4.18.1       chalk ^5.6.2
  strip-ansi ^7.2.0      @anthropic-ai/sdk ^0.107.0
  @anthropic-ai/bedrock-sdk ^0.31.0               @anthropic-ai/vertex-sdk ^0.18.0
  @anthropic-ai/foundry-sdk ^0.4.0                sharp ^0.35.2

开发:
  esbuild ^0.27.4        typescript ^6.0.2
```

---
