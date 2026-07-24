# ConPTY 真实终端验收工具

用 Windows ConPTY(node-pty)创建真实伪终端,跑渲染驱动脚本,捕获 ANSI 输出流,
还原成"最终可见屏幕",对 Issue 1/2/3 的渲染契约做断言。

比 ink-testing-library(headless)更高的证据:验证真实终端的 ANSI 处理
(光标定位/清屏/CJK 宽度)与 Ink 输出的兼容性。

> **注意**:Screen 模拟器是 **minimal ANSI screen buffer for MiCode TUI verification**,
> 只实现项目实际用到的 CSI 子集(光标定位/清屏/清行/SGR/CJK 宽字符/滚动)。
> **不是 xterm 兼容的完整终端模拟器**,不处理字符集切换/DEC 私有模式全集等。
> 够用即止,避免未来误用为通用 emulator。

## 用法

```bash
npm install --no-save node-pty      # 按需装(不入 package.json)
npm run test:tty                    # 跑全部 4 场景(等价于 node scripts/tty-verify/run-verify.cjs)
npm run test:tty 2>/dev/null        # 抑制 AttachConsole 噪音
```

## 适用场景

涉及 TUI layout / border / overlay / cursor / scroll / width calculation 的渲染改动,
优先用此验收路径(它走真实终端,能抓住 headless 测试发现不了的 ANSI 兼容问题)。

## 组成

| 文件 | 职责 |
|------|------|
| `screen.cjs` | 最小 ANSI 屏幕缓冲区模拟器:CSI 序列(光标定位/清屏/清行/SGR)+ CJK 宽字符 + 滚动,还原最终可见屏幕 |
| `render-scenarios.tsx` | 渲染驱动:构造 Issue 1/2/3 的消息数据,用真实 Ink render 输出到 stdout |
| `run-verify.cjs` | ConPTY 运行器:node-pty spawn 驱动脚本 → 捕获 ANSI → 喂 Screen → 断言 |

## 用法

```bash
# 需先装 node-pty(npm install --no-save node-pty)
node scripts/tty-verify/run-verify.cjs              # 跑全部 4 场景
node scripts/tty-verify/run-verify.cjs 2>/dev/null  # 抑制 AttachConsole 噪音
```

## 场景与契约

| 场景 | 验证 |
|------|------|
| `ask-answered` | Issue 1:● Answered N + 每子项统一 `  ⎿ ` |
| `assistant-cont` | Issue 2:续行 2 空格缩进(非顶格) |
| `agent-spacing` | Issue 3:连续 agent-completion 之间有空行 |
| `truncate` | Issue 3:超长标签截断(含 …,不超 cols,单行) |

## 已知限制

- stderr 的 `AttachConsole failed` 是 node-pty 在无控制台环境 fork 辅助进程的已知失败,
  不影响数据捕获(详见 run-verify.cjs 顶部注释)。
- Screen 模拟器聚焦项目实际用的 CSI 子集(光标定位/清屏/清行/SGR/CJK 宽度),
  不实现完整 xterm(字符集/DEC 私有模式等),够用即止。
