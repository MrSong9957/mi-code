# CLAUDE.md

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
- 专业解释：使用标准工程术语描述拓扑/流程。
- 通俗解释：使用直观类比降低认知负载。
- 本质：写成操作手册，每一步都像在教一个不懂的人怎么做。

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

### 核心铁律
- TDD 铁律：没有失败测试，不写生产代码。
- 调试铁律：先调查根本原因，然后列出清单，用户核对无误后，才准动手修复。
- 验证铁律：没有运行证据，不声称完成。
- 技能铁律：必须积极使用技能，每轮对话的第一件事是选择合适的技能。
- 回归测试：高风险功能的回归测试保存至根目录 `script/` 文件夹；现有 TDD 单元测试保留在 `src/__tests__/`（不迁移）。触发命令：`npm run test:regression`（仅跑回归集，约 21 个文件）；全量测试用 `npm test`。回归集清单见 `script/regression-suite.ts`。每次修复或重构后，必须运行回归测试，确保资金/权限/数据三道防线无退化。

### 子代理派发规则
派发子代理前，父代理必须先调用 Skill 工具加载技能，用 `---SKILL_NAME START/END---` 注入子代理 Prompt。

---

## 项目信息：Claude Code 源码技术栈约束（修正完整版）

### 一、运行时与语言

| 约束 | 值 |
|------|-----|
| Node.js | >= 18.0.0 |
| 模块系统 | ESM (`"type": "module"`) |
| TypeScript | target ES2022, strict: false, jsx react-jsx, module ESNext, bundler resolution |
| 包管理 | pnpm workspace |
| 构建 | esbuild（`--platform=node --target=node18 --format=esm --bundle`）|

### 二、核心框架依赖

| 框架 | 版本 | 约束 |
|------|------|------|
| Commander.js | ^13.1.0 | 必须用 `@commander-js/extra-typings` 获得类型安全 |
| React | ^19.2.7 | 通过 Ink 7 绑定终端，禁止直接操作 DOM |
| Ink | ^7.1.0 | 组件必须返回 `Box`/`Text`，不支持 HTML 标签 |
| Zod | ^4.4.3 | 所有工具输入必须用 `z.strictObject`，拒绝未知字段 |
| lodash-es | ^4.18.1 | 必须用 ESM import，禁止 `require('lodash')` |
| chalk | ^5.6.2 | ESM-only，禁止 CJS 版本 |
| strip-ansi | ^7.2.0 | ESM-only |

### 三、工具系统架构

**定义模式**
- 核心接口 `Tool<Input, Output, P>` 含约 25-28 个方法，分生命周期方法和渲染方法两类
- 使用 `buildTool()` 构建器模式，`TOOL_DEFAULTS` 提供默认值：`isEnabled→true`, `isConcurrencySafe→false`, `isReadOnly→false`, `checkPermissions→allow`
- Schema 必须用 `lazySchema(() => z.strictObject({...}))` 延迟构建，避免模块初始化时的循环依赖

**注册与发现**
- 单一入口 `getAllBaseTools()` 硬编码所有内置工具数组
- `process.env.USER_TYPE === 'ant'` 控制内部专属工具（REPLTool、ConfigTool、TungstenTool）
- `feature('FLAG')` 控制实验性工具
- `assembleToolPool()` 合并内置工具 + MCP 工具，`uniqBy` 去重（内置优先），排序保证 prompt cache 稳定性

**权限检查链**（工具执行前三层校验）
1. `validateInput` — 输入合法性（路径存在、格式正确）
2. `checkPermissions` — 工具特定权限逻辑，返回 allow/deny/ask/passthrough
3. `ToolPermissionContext` — 通用权限规则（mode + alwaysAllow/Deny/Ask rules）

**结果序列化**
- 每个工具必须实现 `mapToolResultToToolResultBlockParam`，将 Output 转为 Anthropic API 格式
- `maxResultSizeChars` 默认 16000，超过自动持久化到磁盘（模型收到预览 + 文件路径）；Read 等特定工具设为 Infinity

### 四、状态管理

**Store 原语**（极简自定义实现，非 Redux/Zustand）
- API：`getState()` / `setState(updater)` / `subscribe(listener)`
- `Object.is` 引用相等短路，避免无变化重渲染
- `onChange` 回调在 listener 通知前同步执行

**状态类型**
- `AppState` 巨型单一状态树，用 `DeepImmutable` 包装大部分字段
- `getDefaultAppState()` 提供完整初始值

**React 桥接**
- `useAppState(selector)` 基于 `useSyncExternalStore`，selector 禁止返回新对象（永远 `===` 不等导致无限重渲染）
- `useSetAppState()` 仅获取 `setState`，不订阅，零重渲染
- `AppStateProvider` 创建 Store 并通过 React Context 下发

**副作用监听**
- 监听 4 个字段变化：`toolPermissionContext.mode`、`mainLoopModel`、`expandedView`、`settings`
- 变更时同步到外部系统（userSettings、globalConfig、auth 缓存）

### 五、服务层与 MCP

**MCP 客户端**
- 3 种标准传输：StdioClientTransport、SSEClientTransport、StreamableHTTPClientTransport
- 自研 InProcessTransport（`queueMicrotask` 异步双向通信，同进程内 Server/Client 对接）
- SdkControlTransport（CLI→SDK 双向 JSON-RPC 桥接）
- 7 种配置作用域：local / user / project / dynamic / enterprise / claudeai / managed
- 完整 OAuth 2.0 流程（PKCE + Keychain 安全存储 + XAA 企业认证）

**API 服务层**
- 多云客户端工厂：Anthropic 直连 / AWS Bedrock / Azure Foundry / Vertex AI，统一 Anthropic SDK 接口
- 重试策略：默认 10 次，529 过载最多 3 次，基础延迟 500ms；仅前台查询重试 529，后台任务立即放弃
- 完整错误分类：PromptTooLong、RateLimit、ConnectionError 等

**插件系统**
- 纯函数操作层，无副作用（不调用 process.exit、不写 console）
- 作用域：user / project / local（安装），额外 managed（更新）
- 后台异步 marketplace 调和（diff → reconcile），UI 显示 pending 状态，不阻塞启动

**遥测与分析**
- 零依赖设计，事件先入队，sink 异步排空
- 双后端路由：Datadog（剥离 `_PROTO_*` PII 字段）+ 第一方日志（保留完整 payload）
- 安全标记类型强制验证元数据不含敏感信息

**工具编排并发**
- 只读工具并发执行（默认 max 10），写入工具串行
- `partitionToolCalls` 自动分类

### 六、权限与安全模型

**三层权限体系**（纵深防御链，执行顺序）
1. deny rule → 直接拒绝
2. ask rule → 提示用户（沙箱可绕过）
3. 工具 `checkPermissions()` → 具体结果
4. `requiresUserInteraction()` → 即使 bypass 也必须交互
5. 内容级 ask rule → 绕过 bypass 模式
6. **safetyCheck**（.git / .claude / .vscode / shell 配置）→ **绕过 bypass 模式**
7. bypassPermissions 模式 → 允许
8. allow rule → 允许
9. passthrough → 转为 ask

**权限模式**：default | plan | acceptEdits | bypassPermissions | dontAsk | auto

**Auto 模式分类器**
- 两级快速路径：acceptEdits 快速通道 + safe-tool 白名单
- AI 分类器 `classifyYoloAction()` 做最终裁决
- 连续 3 次拒绝或累计 20 次拒绝 → 强制回退手动审批
- 分类器不可用时 **fail-closed** 策略

**危险模式检测**
- 22+ 个跨平台代码执行入口（python / node / bash / ssh 等）
- `stripDangerousPermissionsForAutoMode()` 自动剥离危险规则

**沙箱**
- 封装 `@anthropic-ai/sandbox-runtime`（bubblewrap / Seatbelt）
- 网络：allowedDomains / deniedDomains / Unix socket / HTTP+SOCKS 代理
- 文件系统：allowWrite / denyWrite / allowRead / denyRead 四象限
- 始终 denyWrite 所有 settings.json 路径（防沙箱逃逸）
- `scrubBareGitRepoFiles()` 清理攻击者植入的 git 文件

**安全存储**
- macOS：Keychain 优先 + 明文降级，`security -i` stdin 管道传输（防进程嗅探）
- Linux/Windows：纯明文 `.credentials.json`，文件权限 `chmod 0o600`
- 启动并行预取 OAuth + API key（节省约 65ms）

**信任对话框**
- 持久化于全局 config 的 `projects[path].hasTrustDialogAccepted`
- 层级继承：父目录信任 → 子目录继承
- 信任前：不执行 hooks、不触发 apiKeyHelper（**防 RCE via settings.json**）
- 信任前：不注入安全环境变量、不初始化遥测

### 七、构建与配置系统

**构建流程**（5 阶段）
1. copy src → 2. transform（feature / MACRO 替换）→ 3. create entry → 4. scan imports + stub → 5. esbuild bundle
- `feature('X')` → `false`：编译时死代码消除（DCE）
- `MACRO.VERSION` / `MACRO.FEEDBACK_CHANNEL` 等替换为字符串字面量
- 最多 10 轮自动补全缺失 export / stub

**启动入口**
- CLI 入口 → 主入口，大量 fast-path（`--version` / `daemon` / `bridge` 等），仅非 fast-path 时动态 import
- 顶层副作用：`profileCheckpoint`、`startMdmRawRead`、`startKeychainPrefetch`，利用 import 并行性加速启动
- `preAction` hook 中同步执行迁移

**配置系统**（多源合并）
- `GlobalConfig`（约 50 字段）：内存缓存 + `fs.watchFile` 轮询检测外部写入
- Settings 系统：userSettings / projectSettings / policySettings / MDM / remote / plugin，Zod schema 验证
- `saveGlobalConfig()`：lockfile 保护 + auth-loss 检测（防止截断写覆盖 OAuth）

**Feature Flags**（编译时死代码消除）
- `feature('X')` 构建时硬编码为 `false`，DCE 移除整个代码块
- 已知 flags（30+）：COORDINATOR_MODE、KAIROS、SSH_REMOTE、DIRECT_CONNECT、VOICE_MODE、ULTRAPLAN、TRANSCRIPT_CLASSIFIER、WORKFLOW_SCRIPTS 等
- 使用模式：`if (feature('X')) { ... }` 或 `feature('X') && require(...)`

**迁移系统**
- 版本化迁移，当前版本号 11
- 11 个迁移文件，幂等设计（读取 → 条件替换 → 写回）
- 涵盖：模型别名迁移、配置迁移、权限重置等

### 八、关键代码模式约束

| 模式 | 约束 |
|------|------|
| Schema 定义 | `lazySchema(() => z.strictObject({...}))` 延迟构建 |
| Feature Flag | `feature('FLAG_NAME')` 包裹条件导入 |
| 循环依赖 | `require()` 延迟导入 + `eslint-disable` 注释说明原因 |
| 副作用标记 | 顶层副作用必须有 `eslint-disable` + 原因说明 |
| 遥测埋点 | `profileCheckpoint('name')` + `logEvent()` |
| 错误处理 | `toError()` 规范化 + `logError()` 记录 |
| 日志 | 禁止 `console.log`，用 `logForDebugging` / `logForDiagnosticsNoPII` |
| 文件操作 | 优先异步 API，禁止 `fs.readFileSync` |
| 结果持久化 | `maxResultSizeChars` 超阈值自动写磁盘 |
| Windows 路径 | NTFS ADS / 8.3 短名 / UNC 路径全面拦截 |
| Windows 安全 | 启动时设置 `NoDefaultCurrentDirectoryInExePath=1` 防 PATH 劫持 |

### 九、禁止事项清单

1. 不使用 `localStorage` / `sessionStorage`（Node.js 环境无此 API）
2. 不使用 `console.log`（用 `logForDebugging` 或 `logError`）
3. 不使用 `require()` 除非解决循环依赖（必须有 `eslint-disable` 注释）
4. 不在顶层代码执行阻塞操作（必须异步或延迟到 `preAction` hook）
5. 不返回新对象给 `useAppState` selector（永远 `===` 不等导致无限重渲染）
6. 不绕过 safetyCheck 类型的 permission decision（即使 bypass 模式也不可）
7. 不直接操作 settings.json 路径（沙箱始终 denyWrite）
8. 不使用 lodash CJS 版本（必须用 `lodash-es`）
9. 不硬编码 feature flags（必须通过 `feature()` 函数判断）
10. 不跳过 `profileCheckpoint` 埋点（关键路径必须有遥测）
11. 不使用 `Array.toSorted`（需兼容 Node 18，用 copy-then-sort）
12. 不在 `assembleToolPool` 中交错排序内置和 MCP 工具（破坏 prompt cache）

---