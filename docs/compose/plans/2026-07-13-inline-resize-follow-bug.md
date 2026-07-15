# Bug B：Inline 模式输入框不跟随终端 resize

> **状态**：⏸️ 已知限制（架构根因确认，不再用应用层补丁修复）
> **发现时间**：2026-07-13 实测粘贴占位符功能时暴露
> **当前实现**：cols 作为 prop 透传（架构就位），但**故意不在 effect 依赖数组里**
>   → resize 不主动重绘，wordWrap 延迟到下次交互更新

## 架构根因（2026-07-14 架构审计确认）

inline 模式的整个渲染建立在一个不变量上：

> **`footerHeight`（应用层账本）= 终端真实物理行数**

DECAWM OFF（`\x1b[?7l`）保证了**写入时**这个不变量成立——应用决定折行，终端不插手。

但终端（conhost "Wrap text output on resize" / ConPTY reflow）在 **resize 时**
单方面破坏这个不变量：把已经写出去的超宽 border 行偷偷折成多行，物理行数膨胀
超过 `footerHeight`。**应用层完全看不见这个变化。**

一旦不变量被破坏，所有基于 `footerHeight` 的 cursor 算术都失效：
- `cursorUp(cursorToTop)` 到不了真正的 footer 顶（中间多了 reflow 折出的行）
- `overwriteLine × N` 覆盖范围不够（N 基于账本，不是真实行数）

**根本矛盾**：inline 模式用"stdout 只追加流 + 应用侧行数账本"取代了权威屏幕缓冲区。
这个账本的不变量会被终端自身的 reflow-on-resize 单方面破坏，且破坏发生在应用层
看不见的层。只要 inline 还坚持直写 stdout + 行级账本，就需要持续打补丁。

### 对比：alt-screen 双缓冲为什么免疫

alt-screen 模式的屏幕真相在 `DoubleBuffer`（Int32Array 网格）里，不在终端累积输出里。
resize 时按新尺寸重建 buffer，整帧重发——terminal reflow 只影响显示层，不影响 buffer。

| | inline 模式（当前） | alt-screen 模式 |
|---|---|---|
| 屏幕真相源 | 终端物理行 + 应用账本（假设一致） | DoubleBuffer（权威） |
| resize 时 | 终端偷偷 reflow，账本失效 | 按新尺寸重建 buffer，整帧重发 |
| scrollback | ✅ 保留（核心价值） | ❌ 无（备用屏） |

## 7 次失败修复方案（全部基于错误前提）

所有方案都假设"应用层能通过 stdout 序列修复 reflow 后的状态"——但应用层连 reflow
发生了都不知道。

| # | 方案 | 为什么失败 |
|---|---|---|
| 1 | cols 进依赖 + EL(`\x1b[2K`) 覆写 | reflow 折行，overwriteLine 够不着 |
| 2 | EL → DL(`\x1b[M`) 物理删除 | 光标定位错（reflow 后位置偏移） |
| 3 | 空 renderer（让 Ink 沉默） | 无效（Ink 的 cursor 机制仍在） |
| 4 | `\x1b[2J` + 重画所有 | 更糟（与 reflow 交错，内容混合） |
| 5 | debounce setState | 无效（reflow 跟随每次写入） |
| 6 | CUP 绝对定位 + ED | CUP 锚定 reflow 前坐标，reflow 后位置错 |
| 7 | cursorUp(footerHeight*2) + ED | 清过头，logo/消息被清掉 |

**结论：不再尝试应用层补丁。** 要真正解决，必须做架构级变更（见下文）。

## 当前已知限制（接受）

**resize 后 footer 的 border 宽度保持旧值**，直到下次输入/消息时 effect 重跑用新 cols。

**为什么接受**：
- 7 次应用层补丁全部失败（根因是架构层，非补丁可解）
- "border 短暂不匹配"是小瑕疵（下次输入即修正），远好于"堆叠"或"清掉 logo"

## 未来解决路径（架构级，独立任务）

1. **alt-screen 模式**：双缓冲免疫 reflow，resize 完美跟随。代价：失去原生 scrollback。
   需重新评估 inline vs alt-screen 的产品定位。
2. **Windows 原生 VT 模式**：绕过 conhost/ConPTY。需评估 Win10+ 兼容性。
3. **检测终端类型并降级**：非 reflow 终端正常跟随，reflow 终端维持现状。
2. alt-screen 模式：双缓冲不受 ConPTY 重放影响（但失去原生 scrollback）

## 症状

终端窗口 resize 后，输入框 border 不实时跟随新宽度（保持旧宽度），
直到下次输入/消息时 effect 重跑用新 cols 重画。

## 当前契约（`src/__tests__/tui/inline-resize-follow.test.ts`）

1. 纯 cols 变化（无新消息）不触发 writeFooter → 不堆叠
2. 有新消息时 writeFooter 用最新 cols 渲染（wordWrap 延迟到下次交互更新）

## 相关文件

- `src/tui/inline/InlineApp.tsx`：cols prop 接口 + effect 依赖（故意不含 cols）
- `src/tui/inline/InlineRenderer.ts`：直写 stdout，无权威屏幕缓冲区（架构根因所在）
- `src/tui/inline/render-state.ts`：footerHeight 等行数账本（被 reflow 单方面破坏）
- `src/tui/inline/diff.ts`：基于 prevCount 的覆写算术（reflow 后 prevCount 失准）
- `src/tui/ConnectedApp.tsx:78,306`：useTerminalSize 订阅 + cols prop 透传
- `src/render/renderer.ts`：alt-screen 双缓冲（对比参照，免疫 reflow）
- `src/__tests__/tui/inline-resize-follow.test.ts`：当前契约的回归测试

