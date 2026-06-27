# 设计文档：流式渲染器增强（Claude Code 级别效果）

**日期**: 2026-06-27
**状态**: 待实现
**复杂度**: Medium

---

## 概述

将现有的 `StreamEventRenderer` 从简单的 `stdout.write` 增强为 Claude Code 级别的终端渲染效果，包含 Markdown 渲染、工具状态面板、代码语法高亮、Thinking 块显示。

## 方案选择

采用**增量 ANSI 渲染器**方案：直接用 ANSI 转义码实现增量渲染，不使用屏幕缓冲区系统（那是全屏 UI 用的）。

---

## 第一部分：Markdown 渲染

### Markdown 元素 → ANSI 映射

```
# 标题        → \x1b[1;36m（粗体青色）
## 二级标题    → \x1b[1;33m（粗体黄色）
### 三级标题   → \x1b[1;32m（粗体绿色）
**粗体**      → \x1b[1m（粗体）
*斜体*        → \x1b[3m（斜体）
`行内代码`    → \x1b[33m（黄色）+ 反色背景
```代码块```  → \x1b[36m（青色）+ 左侧竖线
> 引用        → \x1b[36m│ \x1b[0m（青色竖线）
- 列表        → \x1b[33m• \x1b[0m（黄色圆点）
1. 有序列表   → \x1b[33m1. \x1b[0m
[链接](url)   → \x1b[4;34m（下划线蓝色）
```

### 状态机算法

```
组件：MarkdownStreamRenderer

输入：string（逐 token 到达的文本片段）
输出：string（带 ANSI 转义码的文本）

核心算法：
1. 维护一个"当前状态机"
   - state = 'normal' | 'heading' | 'bold' | 'italic' | 'code_inline' | 'code_block' | 'quote'
2. 每收到一个 token，检查是否触发状态转换
3. 根据当前状态包裹 ANSI 转义码
4. 输出到 stdout

状态转换规则：
  '#' 在行首 → 进入 heading 状态（读取标题级别）
  '**' → 切换 bold 状态
  '*' → 切换 italic 状态
  '`' → 切换 code_inline 状态
  '```' → 切换 code_block 状态
  '>' 在行首 → 进入 quote 状态
  换行 → 重置行级状态
```

### 中文支持

ANSI 转义码不影响宽字符计算。现有的 CJK 宽字符逻辑不需要修改。

---

## 第二部分：工具状态面板

### 面板布局

```
┌─ Tool: read_file ─────────────────────────────────┐
│ 📄 src/agent/types.ts                              │
│ ⏳ executing... (2.3s)                             │
└────────────────────────────────────────────────────┘

┌─ Tool: read_file ─────────────────────────────────┐
│ 📄 src/agent/types.ts                              │
│ ✅ done (2.3s) — 92 lines, 2.8KB                   │
└────────────────────────────────────────────────────┘

┌─ Tool: bash ──────────────────────────────────────┐
│ $ npm test                                         │
│ ❌ failed (1.2s) — exit code 1                     │
│ > Test failed: ...                                 │
└────────────────────────────────────────────────────┘
```

### Spinner 动画

```
帧序列：⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
更新间隔：80ms
实现：定时器 + \r 回车覆盖当前行
```

### 面板颜色

```
边框：\x1b[36m（青色）
工具名：\x1b[1;33m（粗体黄色）
执行中：\x1b[33m（黄色 spinner）
完成：\x1b[32m（绿色 ✅）
失败：\x1b[31m（红色 ❌）
输入参数：\x1b[90m（灰色）
结果摘要：\x1b[37m（白色）
```

### 接口

```typescript
interface ToolStatusPanel {
  start(toolName: string, input: string): void;
  complete(output: string, duration: number): void;
  fail(error: string, duration: number): void;
}
```

---

## 第三部分：Thinking 块显示

### 布局

```
┌─ Thinking ────────────────────────────────────────┐
│ 让我想想这个问题...                                 │
│ 首先需要理解用户的需求...                            │
│ 然后分析代码结构...                                 │
└────────────────────────────────────────────────────┘
```

### 实现

- Thinking 内容以 `\x1b[90m`（灰色）输出
- 外层包裹一个 "Thinking" 标题框
- 默认展开显示（`showThinking=true`）
- 可选：收起时只显示 "Thinking (3.2s)" 一行

---

## 第四部分：代码语法高亮

### 高亮规则

```typescript
const x = 1;          → \x1b[36mconst\x1b[0m x = \x1b[33m1\x1b[0m;
function hello() {    → \x1b[36mfunction\x1b[0m hello() {
  return "world";     →   \x1b[36mreturn\x1b[0m \x1b[32m"world"\x1b[0m;
}
```

### 关键字列表

```
TypeScript/JavaScript: const, let, var, function, return, if, else, for, while, class, import, export, async, await, type, interface, enum, extends, implements, new, this, super, try, catch, finally, throw, switch, case, default, break, continue, void, null, undefined, true, false
Python: def, class, return, if, else, elif, for, while, import, from, async, await, try, except, finally, raise, pass, yield, lambda, with, as, in, not, and, or, is, None, True, False
其他语言：默认不高亮
```

### 字符串和注释

```
字符串：
  "..." → \x1b[32m（绿色）
  '...' → \x1b[32m（绿色）
  `...` → \x1b[32m（绿色）

注释：
  // ... → \x1b[90m（灰色）
  # ... → \x1b[90m（灰色）
  /* ... */ → \x1b[90m（灰色）
```

### 代码块外框

```
│ const x = 1;
│ function hello() {
│   return "world";
│ }
```

---

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/renderer/stream-renderer.ts` | REWRITE | 重写为增强版渲染器 |
| `src/renderer/markdown-renderer.ts` | CREATE | Markdown 状态机渲染器 |
| `src/renderer/code-highlighter.ts` | CREATE | 代码语法高亮器 |
| `src/renderer/tool-status-panel.ts` | CREATE | 工具状态面板组件 |
| `src/__tests__/markdown-renderer.test.ts` | CREATE | Markdown 渲染器测试 |
| `src/__tests__/code-highlighter.test.ts` | CREATE | 代码高亮器测试 |

---

## 实现优先级

| 阶段 | 模块 | 验证方式 |
|------|------|----------|
| P0 | Markdown 渲染器 | 单元测试：各种 Markdown 元素 → ANSI 输出 |
| P1 | 代码语法高亮 | 单元测试：TypeScript/Python 代码 → 高亮输出 |
| P2 | 工具状态面板 | 手动测试：工具调用时显示面板 |
| P3 | Thinking 块 | 手动测试：Thinking 内容灰色显示 |
| P4 | 集成到 StreamEventRenderer | 手动测试：完整对话流式渲染 |

---

## 验证命令

```bash
npm run typecheck
npm test
npm run lint
```
