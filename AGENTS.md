# CLAUDE.md

## 基础原则

* 中文交流。
* 先理解，再编码。
* 简单可靠优先，禁止过度设计。
* 优先复用，禁止重复造轮子。
* 以验证结果作为完成依据。
* 任务开始前检查匹配 Skill，积极使用技能。

---

## Superpowers 工作流

### 任务分级

**S级：新功能 / 架构变化**

```text
brainstorming
→ using-git-worktrees
→ writing-plans
→ test-driven-development
→ executing-plans
→ Review
→ verification-before-completion
→ finishing-a-development-branch
```

按需使用：

* `subagent-driven-development`：并行执行。
* `systematic-debugging`：Bug 定位。

**A级：模块修改**

```text
分析 → 测试保护 → 修改 → 验证
```

**B级：Bug 修复**

```text
复现 + 日志 → 根因 → 回归测试 → 修复 → 验证
```

**C级：简单修改**

直接执行。

### S级规则

`brainstorming`

* 澄清需求、讨论方案，禁止直接写代码。

`using-git-worktrees`

* 隔离开发，保持基线干净。
* 轻量工作可只建立新分支。

`writing-plans`

必须包含：

* 可复用轮子清单。
* 防御边界：识别高频崩溃、异常操作及对应防护准则。
* 核心函数突破口。

开发顺序：

```text
用户效果 → 交互流程 → 核心逻辑 → 数据处理 → 底层实现
```

### Review 顺序

代码审核默认按以下顺序执行：

1. **先使用 `open-code-review` skill**

  - 该 skill 用于指导 Agent 正确调用 `open-code-review` CLI 完成代码审核。
  - 项目参考：`https://github.com/alibaba/open-code-review/tree/main`
  - 以实际 CLI 输出作为第一轮审核证据，不用人工臆测替代工具执行。
  - Review 前先确认审核范围与任务范围一致。
  - 分支任务默认审核目标分支相对基线分支的全部改动；工作区任务审核未提交改动。
  - 必要时先使用 `ocr review --preview` 确认实际纳入审核的文件，禁止把“0 个文件”直接视为“0 个问题”。

2. **再使用 Superpowers 审核技能**

   * 使用 `requesting-code-review` 做补充、独立的代码审查。
   * 对 `open-code-review` 或其他 reviewer 返回的意见，在实施修改前使用 `receiving-code-review` 验证其是否适用于当前代码库。
   * 不因 reviewer 给出结论就直接修改；先核对代码、测试、需求和既有设计，错误或缺乏上下文的意见应明确驳回。

两层审核属于**同一次完整 Review**。第二层用于补充、交叉验证和判断审核意见，不为了形式机械重复已经得到充分验证的检查。

---

## 设计规则

编码前执行：

### Wheel Reuse Check

检查：

* 项目已有代码。
* 工具。
* API。
* 状态管理。
* 开源方案。

仅实现无法复用的最小部分。

### Core Anchor Function

* 定位输入、输出明确且串联主流程的核心函数。
* 作为 TDD 入口、架构突破点和调试中心。
* 优先打通核心业务链路，再完善内部细节。
- 其他未实现依赖可先 Stub 占位，禁止提前深挖边缘逻辑；进入集成 / E2E 前替换为真实实现。

---

## 日志

统一：

```text
logs/*.md
```

仅记录：

* 底层逻辑。
* TDD 测试点。
* 失败原因。
* 验证结果。

优先自主收集日志，无需人工介入。

---

# 测试体系

## 核心原则

目标：

> 验证真实行为，不验证实现细节。

测试层级：

```text
单元测试 → 集成测试 → E2E
```

原则：

* 越底层越快、越容易定位。
* 越靠近用户越真实、越慢。
* 低层测试优先保护核心逻辑，高层测试保护关键流程。
* 测试独立，不依赖执行顺序，不污染环境。
* 测试失败先定位原因，不直接修改测试。
* 禁止为实现细节或覆盖率增加低价值测试。

最佳实现：
- 涉及用户目录、配置、缓存或文件系统状态的测试，使用独立临时目录并覆盖对应环境变量；测试结束后清理，禁止读写真实用户环境。

---

## 测试分层与选择

### 单元测试

适用：

* 单函数。
* 单模块。
* 核心业务逻辑变化。

验证：

* 输入输出。
* 状态变化。
* 边界条件。
* 异常处理。

规则：

* 优先真实代码。
* Mock 仅隔离不可控外部依赖。

### 集成测试

适用：

* 模块间协作变化。

验证：

* 数据流。
* API 调用。
* 状态同步。
* 外部交互。

规则：

* 优先真实组件。
* 避免单模块通过但组合失败。

### E2E

适用：

* 用户流程变化。

规则：

* 只覆盖核心路径。
* 不替代单元测试。
- 以用户最终可见结果作为主要断言；系统日志仅用于交叉验证和定位，不替代用户结果。

#### Web

模拟真实用户操作，通过无头浏览器（如 Playwright 和配套 Skill）启动完整项目并自动执行输入、点击等动作。

验证链路：

```text
操作 → DOM → 请求 → 数据 → 页面
```

最终通过 DOM，并结合系统日志交叉验证功能。

#### CLI / TUI

模拟真实用户操作，通过虚拟终端启动完整 CLI/TUI，自动执行命令输入、组合键等动作。

验证链路：

```text
TTY → 输入 → ANSI → 光标 / 状态
```

要求：

* 校验终端 ANSI 渲染输出，并结合系统日志交叉验证。
* 不得因为缺少 `tmux`、`script` 转为人工验证。
* Windows 使用 ConPTY。
* 优先通过 `node-pty` 创建真实伪终端。
* 使用 headless 终端缓冲区还原最终可见屏幕。
* 可使用 `@commander-cli/test-utils`、`expect-cli` 和 Xterm.js 布局校验技能。
* ConPTY 运行 Ink 输出 + 屏幕模拟器还原帧缓冲，是最接近真实终端的自动化验证。

最佳实现：
- Windows 默认由 `node-pty` / ConPTY 驱动真实进程，`@xterm/headless` 消费 ANSI 并维护终端缓冲区，最终断言用户可见屏幕、光标和状态。

### Bug 修复

添加能够复现问题的最低层测试，并保留为回归测试。

---

## 测试规范

采用 AAA：

```text
Arrange → Act → Assert
```

必须验证：

```text
结果 + 状态 + 副作用
```

要求：

* 动态输入。
* 覆盖边界。
* 防止空跑。
* 新增关键测试必须验证可失败。

---

## 测试执行

开发阶段禁止无脑全量测试。

### L1：当前测试

```bash
npx vitest run xxx.test.ts
```

### L2：影响模块

```bash
npx vitest run src/module/
```

### L3：提交 / 合并 / 跨模块

```bash
npm test
```

---

## 外部依赖

VCR（可选）：适用于 API / 网络服务。

要求：

* 离线可运行。
* 无真实 Key。
* 固化响应。

---

## 测试反模式

禁止：

* 测 getter / setter 等无业务代码。
* 测私有实现。
* 大量低价值 E2E。
* Mock 代替真实行为验证。

优先测试：

* 核心业务。
* 高风险代码。
* 用户路径。
* 历史 Bug。

测试代码同样要求：

* 可维护。
* 无重复。
* 无明显设计缺陷。

---

## 静态检查

必须：

* TypeScript 通过。
* Lint 通过。
* 无 unused。
* 无 floating promise。
* 无明显代码异味。

---

## 项目信息

技术栈：

架构：

项目：

---

## 其他补充

另外，官方 `open-code-review` Skill 本身也明确要求实际执行 `ocr`、分类审核意见，并在修复前判断用户是否要求修改，因此这里把它定位成“第一轮工具审核证据”是合理的。([GitHub][2])

- 仅在对应 CLI / Skill 缺失时安装，不重复安装。
- 首次配置或 OCR 异常时，使用 `ocr llm test` 验证模型连接。
- 安装 `open-code-review` CLI：`npm install -g @alibaba-group/open-code-review`
- 安装 `open-code-review` SKILL：`npx skills add alibaba/open-code-review --skill open-code-review`

[1]: https://github.com/alibaba/open-code-review/blob/main/README.md?utm_source=chatgpt.com "open-code-review/README.md at main · alibaba/open-code-review · GitHub"
[2]: https://github.com/alibaba/open-code-review/blob/main/skills/open-code-review/SKILL.md?utm_source=chatgpt.com "open-code-review/skills/open-code-review/SKILL.md at main · alibaba/open-code-review · GitHub"
