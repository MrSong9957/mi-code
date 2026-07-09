# Inline 原生屏渲染器设计规格

> 状态：已批准  
> 日期：2026-07-08  
> 关联任务：终端渲染架构从备用屏模式重构为原生屏行级局部重绘模式

---

## [S1] 问题与目标

当前项目使用备用屏（Alternate Screen Buffer）模式渲染 TUI，用户退出程序后终端历史被清空。目标是重构为原生屏 Inline 模式，使所有交互历史保留在终端 scrollback 中，同时保留备用屏模式用于特殊交互场景。

**成功标准：**
- 默认模式下，退出程序后终端保留完整对话历史
- 流式输出无明显闪烁
- 备用屏模式仍可用于配置/富交互组件
- 性能不低于现有双缓冲渲染器

---

## [S2] 核心模型：REPL 追加模式

所有内容线性追加到终端主缓冲区，无虚拟滚动，无固定 footer。

**布局结构：**
```
[Logo]                    ← 启动时 stdout.write 一次
[msg 1]                   ← 追加
[msg 2]                   ← 追加
[AI 回复 token stream]    ← 当前行擦除重写
[❯ input] [status bar]    ← 跟在最后消息之后
────────────────────────── ← 用户提交后，成为历史
[AI 回复 2]
[❯ input] [status bar]
```

**关键特性：**
- 内容少时，整段显示在屏幕中间
- 内容多时，自然向上滚动
- 输入框/状态栏是文档流的一部分，不是固定 footer
- 用户提交后，上一轮的输入框+状态栏变成历史

---

## [S3] 双模式架构

| | Inline 模式（默认） | Alt-Screen 模式 |
|---|---|---|
| 屏幕 | 主缓冲区 | 备用屏 |
| 历史 | 终端原生 scrollback | 虚拟滚动 |
| 渲染 | stdout.write + 行级 ANSI | 双缓冲 cell-level diff |
| 输入框 | 文档流的一部分 | 固定在底部 |
| 触发 | 默认 / `MICODE_INLINE=1` | 特定组件按需切换 |

模式切换通过 React Context 控制。

---

## [S4] 模块变更清单

### 新增模块

| 文件 | 职责 |
|------|------|
| `src/tui/inline/InlineRenderer.ts` | 原生屏渲染核心：appendLine、rewriteCurrentLine、renderFooter |
| `src/tui/inline/ansi-utils.ts` | ANSI 序列工具：光标移动、行擦除、样式序列 |
| `src/tui/inline/InlineFooter.tsx` | Inline 模式下的输入框+状态栏 React 组件 |

### 修改模块

| 文件 | 变更内容 |
|------|----------|
| `src/tui/bootstrap.tsx` | 根据模式选择渲染路径；移除默认 `alternateScreen: true` |
| `src/tui/App.tsx` | 根据模式切换布局组件 |
| `src/tui/ConnectedApp.tsx` | 移除 inline 模式下的虚拟滚动逻辑 |
| `src/tui/hooks/useAltScreen.ts` | 仅在 alt-screen 模式下激活 |
| `src/tui/state/render-mode.ts` | 新增渲染模式状态（inline / alt-screen） |

### 保留不变

| 文件 | 原因 |
|------|------|
| `src/render/` | 完整保留，仅 alt-screen 模式使用 |
| `src/tui/components/StatusBar.tsx` | 复用于两种模式 |
| `src/tui/components/Footer.tsx` | 仅 alt-screen 模式使用 |
| `src/tui/components/ScrollBox.tsx` | 仅 alt-screen 模式使用 |
| `src/tui/input/` | 键盘处理不变 |

---

## [S5] InlineRenderer 核心设计

```typescript
// src/tui/inline/InlineRenderer.ts
class InlineRenderer {
  private footerLines: string[] = []  // 当前 footer 的 ANSI 文本行

  // 写入永久内容（消息、代码块等）→ 直接追加到 stdout
  appendLine(ansiText: string): void {
    process.stdout.write(ansiText + '\n')
  }

  // 流式输出：擦除当前行 + 重写
  rewriteCurrentLine(ansiText: string): void {
    process.stdout.write('\r\x1b[K' + ansiText)
  }

  // 渲染 footer（输入框 + 状态栏）
  // 关键：先擦除旧 footer，再写入新 footer
  renderFooter(input: string, cursorPos: number, status: StatusBarData): void {
    // 1. 光标上移到 footer 起始行
    // 2. 擦除 footer 区域
    // 3. 写入新 footer
    // 4. 光标定位到输入框正确位置
  }

  // 提交后：footer 变成历史，不再需要擦除重写
  commitFooter(): void {
    this.footerLines = []
  }
}
```

---

## [S6] 流式输出流程

```
token 到达
  │
  ├─ 换行符 → appendLine(currentLine), currentLine = ''
  ├─ 普通字符 → currentLine += token
  └─ 行满/刷新 → rewriteCurrentLine(currentLine)
  
流式结束
  │
  └─ appendLine(currentLine), currentLine = ''
```

Footer 在每次流式刷新时重绘（擦除旧 footer → 写入新 footer）。

---

## [S7] 启动流程

```
process.stdout (main screen)
  │
  ├─ write(Logo)                    ← 一次性
  ├─ write('[模式切换 UI 组件]')      ← 可选
  │
  ├─ [循环] 
  │   ├─ renderFooter(input, status)
  │   ├─ 等待用户输入
  │   ├─ commitFooter()             ← 上一轮 footer 成为历史
  │   ├─ 执行命令 / 调用 Agent
  │   ├─ 流式写入 AI 回复
  │   └─ appendLine(response)
  │
  └─ 退出时：无清理（内容已在主缓冲区）
```

---

## [S8] 与备用屏模式的切换

特定功能（配置界面、富交互）可通过组件声明进入备用屏：

```tsx
function ConfigUI({ children }) {
  const { mode } = useRenderMode()
  
  if (mode === 'inline') {
    // 直接在文档流中渲染
    return <Box>{children}</Box>
  }
  
  // 备用屏模式：切换到全屏
  return <AltScreen>{children}</AltScreen>
}
```

---

## [S9] ANSI 工具函数

```typescript
// src/tui/inline/ansi-utils.ts

// 光标上移 n 行
export const cursorUp = (n: number) => `\x1b[${n}A`

// 光标下移 n 行
export const cursorDown = (n: number) => `\x1b[${n}B`

// 擦除当前行（从光标到行尾）
export const eraseLine = '\x1b[K'

// 擦除 n 行（从当前行向上）
export const eraseLines = (n: number) => 
  Array(n).fill(cursorUp(1) + eraseLine).join('')

// 光标定位到行首
export const carriageReturn = '\r'

// 隐藏/显示光标
export const hideCursor = '\x1b[?25l'
export const showCursor = '\x1b[?25h'

// SGR 样式（复用现有 output-ops.ts 的解析逻辑）
export const sgr = (code: string) => `\x1b[${code}m`
```

---

## [S10] 渲染模式状态管理

```typescript
// src/tui/state/render-mode.ts
export type RenderMode = 'inline' | 'alt-screen'

// 默认 inline，可通过组件切换到 alt-screen
export const defaultRenderMode: RenderMode = 
  process.env.MICODE_INLINE === '0' ? 'alt-screen' : 'inline'
```

通过 React Context 在组件树中传递，不需要运行时环境变量切换。
