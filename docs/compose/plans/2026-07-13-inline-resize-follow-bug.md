# Bug B：Inline 模式输入框不跟随终端 resize

> **状态**：⏸️ 已知限制（2026-07-14）——不继续投入应用层补丁
> **发现时间**：2026-07-13 实测粘贴占位符功能时暴露
> **当前实现**：cols 作为 prop 透传（架构就位），但**故意不在 effect 依赖数组里**
>   → resize 不主动重绘（保证 terminal correctness），wordWrap 延迟到下次交互更新

## 当前已知限制（接受，不在本次修复）

**resize 后 footer 的 border 宽度保持旧值**（如缩窄前 180 列，缩窄后仍 180 列），
直到用户下次输入字符或新消息到达时，effect 重跑才用新 cols 重画。

**为什么接受**：
- 尝试"resize 即时同步"会触发 ConPTY 重放 → footer 堆叠（更严重的可见 bug）
- "border 短暂不匹配"是小瑕疵（下次输入即修正），远好于"堆叠"
- 应用层补丁（EL/DL/full-repaint/debounce/renderer 隔离）经验证均无法解决
- 根本矛盾在 ConPTY + inline incremental renderer 的兼容性，需架构层重构

**未来解决路径**（独立任务，重构 terminal render pipeline 时）：
1. 独立 layout/render pipeline：resize 事件与 render commit 彻底解耦
2. alt-screen 模式：双缓冲不受 ConPTY 重放影响（但失去原生 scrollback）

## 症状

终端窗口 resize 后，输入框不实时跟随变化，wordWrap 不立即重算（下次输入/消息时更新）。

## 调查历程与决策依据

### 阶段 1：cols 加入 effect 依赖（尝试跟随 resize）
ConnectedApp 已用 `useTerminalSize()` 订阅 resize，cols 作为 prop 透传给 InlineApp。
把 cols 加入主渲染 effect + overlay effect 的依赖数组 → resize 触发 effect 重跑 → renderFooter 用新 cols。

**结果**：resize 跟随生效，但在 Windows ConPTY 下引入 **footer 堆叠 bug**。

### 阶段 2：堆叠根因深挖（用 node-pty + 文件级诊断 + 真实环境日志）
通过 `.diag-resize.log`（带时间戳/pid，绕过 ConPTY stderr 重放干扰）采集真实环境数据，
排除 effect 重复订阅（listener 1 个）、effect 多余 cleanup/run（每次恰好 1:1）、
Ink renderInteractiveFrame 干预（previousLineCount=0，log.clear 是 no-op）。

**最终根因**：ConPTY 在 resize 时会用**新宽度**重放整个历史输出，把旧的超宽 footer border
（按旧 cols 画）按新 cols **折成多行**。但 footerHeight 记的仍是原始行数 → cursorUp 定位不足 →
footer 覆写到错误的物理行 → border 堆叠 + status 重复。

### 阶段 3：5 种修复方案全部失败

| # | 方案 | 验证结果 |
|---|---|---|
| 1 | cols 依赖 + EL(`\x1b[2K`) 覆写 | ✗ 堆叠（ConPTY 折超宽行，footerHeight 算少） |
| 2 | EL → DL(`\x1b[M`) 物理删除 | ✗ 消残渣但光标定位错（`❯ ild │ mimo` 混合） |
| 3 | 空 renderer（让 Ink 沉默） | ✗ 无效（`\x1b[6;3H]` 仍出现，来自 Ink cursor 机制） |
| 4 | resetForFullRepaint（`\x1b[2J` + 重画所有） | ✗ 更糟（与 ConPTY 重放交错，logo/status/border 内容混合） |
| 5 | debounce setState（120ms 稳定窗口） | ✗ 无效（ConPTY 重放跟随每次应用层写入，非独立前置事件） |

**根本矛盾**：ConPTY 对应用层每次 stdout 写入做异步重放。"跟随 resize"需写 stdout，
但写 stdout 触发 ConPTY 重放 → 堆叠。两者在当前架构下无法兼得。

### 阶段 4：决策回退（2026-07-14）
**cols 故意不在 effect 依赖数组** → 纯 resize 不主动重绘 → 不写 stdout → 不触发 ConPTY 重放 → 不堆叠。
cols 新值在下次 messages/input 变化触发 effect 时自然生效（wordWrap 延迟更新）。
保留 cols prop 接口，未来通过独立 layout/render pipeline 或 alt-screen 模式重新支持动态 resize。

## 当前契约（`src/__tests__/tui/inline-resize-follow.test.ts`）

1. 纯 cols 变化（无新消息）不触发 renderFooter → 不堆叠
2. 有新消息时 renderFooter 用最新 cols 渲染（wordWrap 延迟到下次交互更新）


- `src/tui/ConnectedApp.tsx:78` 用了 `useTerminalSize()` 监听 resize
- 但 inline 模式走 `InlineApp`（`bootstrap.tsx:142` `new InlineRenderer` + `InlineApp.tsx:291`），**完全绕过 `useTerminalSize`**

## 架构就位部分（保留，为未来重新启用做准备）

虽然 resize 不主动重绘，但 cols 的数据通路已打通：
- `useTerminalSize()` 订阅 resize（ConnectedApp 已用）→ cols prop 透传给 InlineApp
- InlineApp 的 `InlineAppProps.cols: number` 接口就位
- effect body 用 cols 渲染（renderFinalizedLine / wrapStreamingText / renderFooter）
- 仅 effect **依赖数组**不含 cols（注释说明原因）

未来重新支持动态 resize 的两条路径（独立任务）：
1. **独立 layout/render pipeline**：把 resize 事件与 render commit 彻底解耦，
   resize 只更新 pending size，由独立的 commit 阶段决定何时重绘（避开 ConPTY 重放窗口）
2. **alt-screen 模式**：alt-screen 有完整双缓冲（createCustomRenderer），不受 ConPTY
   重放影响——但失去原生 scrollback（inline 模式的核心价值）

## 相关文件

- `src/tui/inline/InlineApp.tsx`：cols prop 接口 + effect 依赖（故意不含 cols）
- `src/tui/inline/InlineRenderer.ts`：通过 renderFooter 参数接收 cols（无变化）
- `src/tui/ConnectedApp.tsx:78,306`：useTerminalSize 订阅 + cols prop 透传
- `src/tui/hooks/useTerminalSize.ts`：resize 监听（无变化，原始版本）
- `src/__tests__/tui/inline-resize-follow.test.ts`：当前契约的回归测试

