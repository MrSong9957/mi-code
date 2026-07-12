# CLAUDE.md

## 基础原则
- 中文交流。
- 先理解，再编码。
- 简单可靠优先，禁止过度设计。
- 优先复用，禁止重复造轮子。
- 无验证证据，不声明完成。
- 修复问题先找根因，禁止猜测式修改。
- 积极使用技能，任务开始前检查匹配 Skill。
- 如果同一个 Bug 修复超过 3 次，反问是不是架构设计问题。
- 架构是基石，必须严谨，出方案后主动要求其他模型（如ChatGPT/Claude/Gemini）多轮审核

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
→ `executing-plans`
→ `test-driven-development`
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

## 系统化调试

使用 `systematic-debugging` 技能

Bug处理必须：复现问题 → 收集证据 → 定位根因 → 验证假设 → 最小修复 → 回归测试。

禁止：
- 猜测式修改。
- 多处同时修改。
- 没验证根因直接修复。

---

## TDD

使用 `test-driven-development` 技能

业务逻辑、Bug、行为变化必须：`RED → GREEN → REFACTOR`，即：失败测试 → 确认测试因功能缺失正确失败 → 最小实现 → 测试通过 → 重构。

核心规则：
- NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST。
- 未观察测试失败，不认为测试有效。
- 测试验证需求行为，不验证实现细节。

禁止：
- 无测试修改核心逻辑。
- 测试跟随代码补写。
- 测试刚写完立即通过却未确认原因。
- 只验证返回值，不验证真实行为。

---

## 测试规范

AAA：`Arrange → Act → Assert`

必须验证：结果 + 状态 + 副作用。

关键测试：
- 测试真实行为，避免测试实现细节。
- 优先使用真实代码，Mock 仅在必要时使用。
- 动态输入，避免固定样例。
- 防止空跑。

新增关键测试：必须验证测试有效性，必要时故意制造失败确认测试能捕获问题。

---

## 测试范围

禁止开发阶段无脑全量测试。

L1：当前测试文件。

```bash
npx vitest run xxx.test.ts
````

L2：影响模块。

```bash
npx vitest run src/module/
```

L3：提交/合并/跨模块/用户要求。

```bash
npm test
```

---

## 调试

流程：复现 → 日志 → 根因 → 修复方案 → 回归测试 → 验证。

---

## Review

使用 `requesting-code-review` 技能

使用场景：
- 完成任务。
- 完成重大功能。
- 合并前。

目标：
- 验证实现是否符合需求。
- 检查架构、安全、性能、Bug、维护性。

CRITICAL：
一票否决。

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

## 完成验证

`verification-before-completion`

声明完成前必须：
- 运行实际验证命令。
- 检查真实输出。
- 确认测试结果。

禁止：
- 根据代码推断完成。
- 根据测试文件存在推断完成。

---

## 完成

`finishing-a-development-branch`

必须验证命令：
- 终端证据
- 测试结果

然后：Merge / PR / 清理。

---

## 日志

统一：`logs/*.md`

仅记录：
- 底层逻辑
- TDD测试点
- 失败原因
- 验证结果

---

## 静态检查

必须：
- TypeScript通过。
- Lint通过。
- 无 unused。
- 无 floating promise。
- 无明显代码异味。

---

## E2E

Web：真实操作 → DOM → 日志。

CLI/TUI：真实TTY → 输入 → ANSI → 光标/状态。

---

## VCR（可选）

外部服务：离线可测。无 API Key 可运行。

---

## 项目信息

技术栈：
架构：
项目：

---
