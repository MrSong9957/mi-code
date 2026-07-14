# CLAUDE.md

## 基础原则
- 中文交流。
- 先理解，再编码。
- 简单可靠优先，禁止过度设计。
- 优先复用，禁止重复造轮子。
- 以验证结果作为完成依据。
- 积极使用技能，任务开始前检查匹配 Skill。

---

## 解释模式

解释时按：
- 第一性原理：说明底层本质、解决的问题、系统真实变化。
- 底层机制：输入 → 处理 → 输出，说明数据流、状态变化。
- 控制流程：说明调用关系、执行时机、生命周期。
- 类比：仅辅助理解，不替代技术解释。

---

## Superpowers 工作流

### 任务分级

S级：新功能/架构变化：
`brainstorming`
→ `using-git-worktrees`
→ `writing-plans`
→ `test-driven-development`
→ `executing-plans`
→ `requesting-code-review`
→ `verification-before-completion`
→ `finishing-a-development-branch`

补充：
- `subagent-driven-development`：并行执行时启用。
- `receiving-code-review`：收到反馈后启用，先验证再修改。
- `systematic-debugging`：Bug定位阶段启用。

A级：模块修改，分析 → 测试保护 → 修改 → 验证。

B级：Bug修复，复现 → 根因 → 回归测试 → 修复 → 验证。

C级：简单修改，直接执行。

---

## S级规则

`brainstorming`
- 需求澄清、方案讨论，禁止直接写代码。

`using-git-worktrees`
- 隔离开发，保持基线干净。

`writing-plans`
- 可复用轮子清单
- 防御边界：识别高频崩溃异常操作，配套对应的防护设计准则
- 核心函数突破口

开发顺序：用户效果 → 交互流程 → 核心逻辑 → 数据处理 → 底层实现。

---

## 设计规则

编码前：

`Wheel Reuse Check`
- 检查项目已有代码、工具、API、状态管理、开源方案。
- 仅实现无法复用的最小部分。

`Core Anchor Function`
- 定位输入明确、输出明确、负责串联主流程的核心函数。
- 将其作为 TDD 入口、架构突破点、调试中心。
- 优先打通核心业务链路，再逐层完善内部细节。
- 其他未实现依赖先 Stub 占位，禁止提前深挖边缘逻辑。

---

## 子代理并行执行

使用 `subagent-driven-development` 技能

适用：
- 独立任务。
- 并行分析。
- 隔离实验。

规则：
- 从 agents 目录选择合适子代理。
- 简单任务无需调用。
- 主代理负责最终规格和质量。

---

## 日志

统一：`logs/*.md`

仅记录：
- 底层逻辑
- TDD测试点
- 失败原因
- 验证结果

---

## 系统化调试

使用 `systematic-debugging` 技能

Bug处理必须：复现问题 → 收集日志证据 → 定位根因 → 验证假设 → 最小修复方案 → 回归测试 → 验证。

禁止：
- 猜测式修改。
- 多处同时修改。
- 没验证根因直接修复。

---

## Review

使用 `requesting-code-review` 技能

使用场景：
- 功能实现后。
- 重大修改后。
- 合并前。

目标：
- 验证实现是否符合需求。
- 检查架构、安全、性能、Bug、维护性。

CRITICAL：发现架构、安全、正确性重大问题，阻止合并。

---

使用 `receiving-code-review` 技能

使用场景：
- 收到 Review 意见后。
- 准备实施修改建议前。

规则：
- 先分析反馈合理性。
- 验证技术依据。
- 不盲目接受修改。
- 禁止表演式认同。

---

## 测试体系

### 核心原则

目标：验证真实行为，不验证实现细节。

测试层级：单元测试 → 集成测试 → E2E

原则：
- 越底层越快，越容易定位。
- 越靠近用户越真实，越慢。
- 优先低层测试保护核心逻辑，高层测试保护关键流程。
- 测试独立。
- 不依赖执行顺序。
- 不污染环境。
- 测试失败先定位原因，不直接修改测试。

禁止：
- 为实现细节写测试。
- 为追求覆盖率增加低价值测试。

---

## TDD

使用 `test-driven-development`

必须：`RED → GREEN → REFACTOR`

流程：
1. 写失败测试。
2. 确认失败原因正确。
3. 最小实现。
4. 测试通过。
5. 重构。

规则：
- NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST。
- 未观察失败，不认为测试有效。
- 核心模块必须有行为保护测试。

禁止：
- 无测试修改核心逻辑。
- 测试跟随代码补写。
- 测试刚写完立即通过却未确认原因。
- 只验证返回值，不验证真实行为。

---

## 测试分层

### 单元测试

范围：单函数 / 单模块 / 核心逻辑。

验证：
- 输入输出。
- 状态变化。
- 边界条件。
- 异常处理。

规则：
- 优先真实代码。
- Mock 仅隔离不可控外部依赖。

### 集成测试

范围：模块之间协作。

验证：
- 数据流。
- API调用。
- 状态同步。
- 外部交互。

规则：
- 优先真实组件。
- 避免单模块通过但组合失败。

### E2E

范围：完整用户流程。

验证：真实输入 → 真实系统 → 用户结果

Web：操作 → DOM → 请求 → 数据 → 页面

CLI/TUI：TTY → 输入 → ANSI → 光标/状态

规则：
- 只覆盖核心路径。
- 不替代单元测试。

---

## 测试选择

业务逻辑变化：→ 单元测试

模块交互变化：→ 集成测试

用户流程变化：→ E2E

Bug修复：→ 添加复现问题的最低层测试，并保留回归测试。

---

## 测试规范

AAA：`Arrange → Act → Assert`

必须验证：结果 + 状态 + 副作用。

要求：
- 动态输入。
- 覆盖边界。
- 防止空跑。
- 新增关键测试必须验证可失败。

---

## 测试执行

禁止开发阶段无脑全量测试。

L1 当前测试：
```bash
npx vitest run xxx.test.ts
```

L2 影响模块：
```bash
npx vitest run src/module/
```

L3 提交/合并/跨模块：
```bash
npm test
```

---

## 外部依赖

VCR（可选）：适用于 API / 网络服务。

要求：
- 离线可运行。
- 无真实 Key。
- 固化响应。

---

## 测试反模式

禁止：
- 测 getter/setter 等无业务代码。
- 测私有实现。
- 大量低价值 E2E。
- Mock 代替真实行为验证。

优先测试：
- 核心业务。
- 高风险代码。
- 用户路径。
- 历史 Bug。

测试代码同样要求：
- 可维护。
- 无重复。
- 无明显设计缺陷。

---

## 静态检查

必须：
- TypeScript通过。
- Lint通过。
- 无 unused。
- 无 floating promise。
- 无明显代码异味。

---

## 完成验证

使用 `verification-before-completion` 技能

声明完成前必须：
- 运行实际验证命令。
- 检查真实输出。
- 确认测试结果。

禁止：
- 根据代码推断完成。
- 根据测试文件存在推断完成。
- 根据主观判断声明完成。

---

## 完成

`finishing-a-development-branch`

必须：
- 完成验证。
- 保留终端证据。
- 确认测试结果。

然后：Merge / PR / 清理。

---

## 项目信息

### 技术栈

- Node.js: $\ge$ 18.0.0 (`package.json` 中的 `engines`)
- ESM: `"type": "module"` (`package.json`)
- TypeScript: `target: ES2022`, `strict: false`, `module: ESNext` (`tsconfig.json`)
- 包管理: pnpm + npm 双支持 (`pnpm-lock.yaml` 与 `package-lock.json` 共存)
- 构建（原始）: Bun 编译时内联 (`feature()`, `MACRO`, `bun:bundle`)
- 构建（重建）: esbuild 打包 (`--platform=node --target=node18 --format=esm --bundle`)

---

### 架构

- 切 grid 模式（像 Claude Code）——resize 彻底解决，但要自己管 scrollback

---

### 参考资料

- 目前地球上最权威的终端控制码“新华字典”：https://invisible-island.net/
- curses / ncurses 官方设计文档：https://tldp.org/HOWTO/NCURSES-Programming-HOWTO/
- obsidian仓库：D:\Files\Obsidian，记忆文档、可沉淀的知识都保存到此处，通过 wiki MCP 工具


---
