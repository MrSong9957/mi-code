# 真实 PTY 驱动的 E2E 自动化验收

继续当前 `feat/i18n` 收尾，使用 `executing-plans`。

先用 todo 跟踪：

* Plan Approval 固定审批文案 corrective
* Plan Approval E2E
* `/language` persistence/restart E2E
* targeted verification
* final verification
* finishing / merge / cleanup

## 本阶段原则：E2E

范围：完整用户流程。

验证：

`真实输入 → 真实系统 → 用户结果`

对于 CLI/TUI：

`真实 PTY → 键盘输入 → MiCode 生产入口 → ANSI 输出 → 光标/界面状态/真实副作用`

规则：

* 只覆盖核心路径。
* 不替代现有单元/集成测试。
* 不直接调用 command handler、store、React component 或内部 transition 函数冒充 E2E。
* 不通过内部状态断言代替用户结果。
* 外部 LLM 若会造成非确定性，可在网络/provider 边界使用确定性的测试 provider/stub；MiCode 从 CLI 入口开始到 TUI、tool dispatch、状态转换必须走真实生产链。
* E2E harness 属于测试基础设施，不得进入生产运行路径。
* 优先复用仓库现有 TTY/ConPTY/E2E 基础设施；确认不存在合适能力后，才增加最小的 test-only PTY 依赖或 harness。
* 不为 E2E 顺手重构产品代码。

---

# 1. 先处理 Plan Approval 新发现的 i18n 缺口

使用 `receiving-code-review` 核实，然后使用 `test-driven-development`。

已知疑点：

`plan-tools.ts` 固定构造了以下程序文案：

* `确认执行，清空上下文并使用自动模式`
* `确认执行，使用自动模式`
* `确认执行，手动审核修改`
* `提出修改意见`

这些是 MiCode 固定生成的 UI 内容，不是 Agent 生成内容。

核对 approved i18n spec 和当前实现。

若确认属于首版 locale 范围：

1. 先写最小失败测试并确认 RED。
2. zh-CN 保持中文。
3. en-US 使用英文 option label / description / otherLabel。
4. stable decision/value 和 approve/cancel transition 不随 locale 改变。
5. Agent 生成的 plan Markdown 继续保持 RAW。
6. 最小修改生产代码。
7. GREEN 后只跑直接受影响测试与 typecheck。
8. `git diff --check`。
9. commit corrective。

如果存在一份明确、后于 approved spec 的设计决策规定这些程序固定文本必须 RAW，则停止修改并返回该证据。仅“现有测试如此断言”不足以覆盖 spec。

---

# 2. 建立真实 CLI/TUI E2E harness

先只读调查仓库现有：

* TTY / ConPTY 测试；
* `test:tty`；
* terminal emulator / ANSI parser；
* 子进程启动工具；
* 是否已有可驱动 stdin + resize + keypress 的 PTY harness；
* 是否已有 deterministic test provider。

目标是找到**最短的真实用户链路**。

E2E 必须启动实际构建产物，例如：

`node dist/index.js ...`

不能 import `executeCommand()` 后直接调用。

如果现有 harness 足够，直接复用。

如果确实缺少可编程 PTY：

* 允许增加最小 test-only PTY 测试基础设施；
* 不修改 production dependency/runtime path；
* 不为了通用框架做额外抽象。

---

# 3. `/language` 核心 E2E

只覆盖一条连续核心路径：

`持久化 A → restart A → --language B → restart 恢复 A`

使用隔离的测试 HOME / USERPROFILE 配置目录，**不要修改用户真实 `C:\Users\sry27\.micode\config.json`**。

如果生产代码确实无法重定向 home，则由 E2E 子进程提供隔离 OS home 环境；不要为了测试修改 ConfigStore 的产品语义。

建议：

* A = `en-US`
* B = `zh-CN`
* 初始配置明确写为非 A 值或无 language，避免假阳性。

真实流程：

### E2E-L1 持久化

启动真实 PTY：

`node dist/index.js`

输入：

`/language en-US`

从终端最终可见 ANSI screen 断言：

`Language switched to en-US.`

然后退出进程。

直接读取该 E2E 隔离 home 中真实 `config.json`：

`language === "en-US"`

这两项共同证明：

* 用户看到切换成功；
* 真正发生持久化。

### E2E-L2 restart 读取持久化

再次启动同一隔离 home，**无 `--language`**。

输入：

`/language`

最终终端界面必须包含：

`Current language: en-US. Supported: zh-CN, en-US.`

退出。

### E2E-L3 临时 override

启动：

`node dist/index.js --language zh-CN`

输入：

`/language`

最终终端界面必须包含：

`当前语言：zh-CN。支持：zh-CN, en-US。`

同时真实磁盘配置仍必须：

`language === "en-US"`

退出。

### E2E-L4 override 生命周期

再次无参数启动。

输入：

`/language`

必须重新看到：

`Current language: en-US. Supported: zh-CN, en-US.`

证明临时 override 未污染持久化状态。

不要在 E2E 重做：

* 非法 locale 全排列；
* interpolation；
* ConfigStore atomicWrite；
* resolver 单元分支；
* 其他已有单元测试充分覆盖的边界。

---

# 4. Plan Approval 核心 E2E

目标不是遍历所有选择，只验证：

`真实 TTY 输入 → Agent/tool 流程 → Plan Approval overlay → 用户按键 → 可见结果/状态`

为消除真实 LLM 的随机性，优先在 provider/network 边界使用 deterministic test provider，使其固定产生：

1. `write_plan_file`
2. `exit_plan_mode`

不要绕过 Agent/tool dispatch 直接调用 `exit_plan_mode()`。

至少覆盖两个互补场景。

### E2E-P1 zh-CN approve

真实启动：

`node dist/index.js --language zh-CN`

真实输入 `/plan` 和一条测试 prompt。

确定性 provider 触发真实 plan tool 链。

从 ANSI screen 断言 Plan Approval 专用界面出现，包括固定中文壳层及中文固定审批选项。

通过真实 keypress 选择一个 approve 选项并 Enter。

从最终用户结果确认：

* overlay 消失；
* 应用恢复正常交互；
* 对应模式转换成立；
* 没有额外 Permission dialog；
* 不依赖读取内部 Zustand/store 来判 PASS。

### E2E-P2 en-US cancel

真实启动：

`node dist/index.js --language en-US`

走同一真实链路打开 Plan Approval。

从 ANSI screen 断言：

* 英文固定壳层；
* 英文固定审批 option/description/otherLabel；
* Agent 生成的 Markdown 正文保持原样，不因 locale 被翻译。

发送真实 `Esc`。

从用户可见状态确认：

* dialog 消失；
* 会话没有卡死；
* 没有误批准。

随后通过一个真实用户命令验证 CLI/TUI 已恢复可交互状态。

不需要为三个 approve choice 各写一个完整 E2E；decision mapping 已由低层测试覆盖。

---

# 5. ANSI / TTY 判定规则

不要直接对原始 ANSI byte stream 做脆弱全文 snapshot。

E2E harness 应：

1. 保存原始 PTY 输出用于失败诊断；
2. 用 terminal emulator / ANSI parser 得到最终屏幕状态；
3. 对用户真正可见的关键文本、光标/overlay 状态做最小断言；
4. 必要时等待明确界面锚点，而不是固定 `sleep(3000)`；
5. 设置合理 timeout，超时时输出最后 screen + 原始 ANSI 尾部。

只有光标位置本身是当前契约时才断言精确坐标；否则只验证焦点/可交互状态，避免尺寸变化导致脆弱测试。

固定 terminal rows/cols，使结果可重复。

---

# 6. 验证顺序

完成代码和 E2E 后：

1. 新增 E2E 自身通过。
2. 直接受影响单元/集成测试通过。
3. typecheck。
4. `git diff --check`。
5. 确认 E2E 没有污染真实用户配置或仓库状态。
6. 检查 worktree diff，只包含：

   * Plan Approval corrective；
   * 必需 locale resource；
   * 最小 E2E harness/tests；
   * 必要 test-only dependency/lockfile（仅在确实需要时）。

不要现在重新跑完整 open-code-review 链。

如果 E2E 暴露新的产品失败：

* 保留 PTY 输入、原始 ANSI、最终 screen、exit code 和真实副作用；
* 使用 `systematic-debugging` 找首个分叉点；
* 只修阻断核心 E2E 的生产问题；
* 修复仍按 TDD；
* 不扩大到非核心路径。

---

# 7. 完成条件

本阶段只有在以下证据同时存在时才能结束：

* Plan Approval corrective 已按 spec 收敛；
* `/language` 四段核心真实 PTY E2E PASS；
* Plan Approval zh-CN approve E2E PASS；
* Plan Approval en-US cancel E2E PASS；
* 所有 E2E 都从真实 CLI/TUI 入口启动；
* ANSI/最终 screen 证据可用于失败诊断；
* 测试使用隔离配置，不污染用户真实配置；
* targeted tests / typecheck / diff-check 通过；
* worktree 状态清楚。

完成后 commit E2E/corrective（可以按逻辑拆 commit），返回：

* 新增 E2E 架构；
* 每条 E2E 覆盖的用户路径；
* RED/GREEN 或首次运行证据；
* 实际测试命令与完整通过数量；
* 是否增加 test-only dependency 及原因；
* commits；
* `git status --short`。

随后停止，等待大脑决定 final verification → `finishing-a-development-branch`。

不要进行 merge 或 cleanup。
