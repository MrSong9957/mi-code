# 斜杠命令自动补全下拉菜单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 输入 `/` 后自动弹出竖排下拉菜单，随输入实时过滤，上下箭头选择，Enter 确认。

**Architecture:** 改造现有 completion-store + SuggestionBar + use-input-handler，从"按 TAB 才显示"改为"输入 `/` 自动显示"。

**Tech Stack:** zustand (completion-store), React (SuggestionBar), Ink (useInput)

---

## Task 1: 改造 completion-store — 新增 filter 方法

**Files:**
- Modify: `src/tui/state/completion-store.ts`

**改动：** 新增 `filter(prefix)` 方法，接收 `/` 后面的前缀文本，从 COMMAND_NAMES 过滤候选。

```ts
// 新增方法
filter: (prefix: string) => void;

// 实现
filter: (prefix) => {
  const filtered = COMMAND_NAMES.filter(n => n.startsWith(prefix));
  if (filtered.length > 0) {
    set({ candidates: filtered, index: 0, visible: true });
  } else {
    set({ candidates: [], visible: false, index: 0 });
  }
}
```

- [ ] 实现 + typecheck

---

## Task 2: 改造 use-input-handler — 输入 `/` 自动触发 + 上下箭头选择

**Files:**
- Modify: `src/tui/input/use-input-handler.ts`

**改动要点：**

1. **输入 `/` 时**：在 printable character 分支里，插入字符后检测 `text === '/'`，触发 `completionStore.filter('')`
2. **输入后续字符时**：如果 `text.startsWith('/')` 且 completion 可见，调用 `completionStore.filter(text.slice(1))`
3. **上下箭头**：如果 completion 可见，上下箭头调用 `completion.cycle()` / `completion.cyclePrev()`，不移动光标
4. **Enter**：如果 completion 可见且有选中项，将选中项写入 input 并关闭 completion，不提交
5. **Esc**：关闭 completion
6. **退格到空**：如果退格后 text 变成空或不含 `/`，关闭 completion

**新增：** completion-store 需要 `cyclePrev()` 方法（向上循环）。

- [ ] 实现 + typecheck

---

## Task 3: 改造 SuggestionBar — 竖排下拉样式

**Files:**
- Modify: `src/tui/components/SuggestionBar.tsx`

**改动：** 从横排改为竖排，每个命令一行，选中项高亮。

```
 /theme
▸/help          ← 选中项（inverse + bold）
 /config
 /model
```

- 每行：空格 + 命令名
- 选中项：`▸` 前缀 + inverse + bold
- 非选中项：空格前缀 + dimColor
- 最多显示 8 行，超出部分滚动

- [ ] 实现 + typecheck

---

## Task 4: 适配 Footer 布局

**Files:**
- Modify: `src/tui/components/Footer.tsx`

**改动：** Footer 需要为下拉菜单预留空间。当前 SuggestionBar 是 1 行，改造后最多 8 行。

- 计算 suggestionRows = min(candidates.length, 8)
- footerRows 基础值从 4 改为 4 + suggestionRows
- SuggestionBar 放在 spinner 和上边框之间

- [ ] 实现 + typecheck

---

## Task 5: 适配 handleTab（index.ts）

**Files:**
- Modify: `src/index.ts`

**改动：** TAB 在 completion 可见时的行为：循环选择（已有），写回 input（已有）。非 `/` 开头时的 mode 切换逻辑保留。

- [ ] 适配 + typecheck

---

## Task 6: 回归测试

**Files:**
- Create: `src/__tests__/tui/slash-autocomplete.test.ts`

**测试场景：**
1. 输入 `/` 后 completion.visible = true，candidates 包含所有命令
2. 输入 `/th` 后 candidates 过滤为只含 `theme`
3. 上下箭头循环选择
4. Enter 将选中项写入 input
5. Esc 关闭 completion
6. 退格到空关闭 completion
7. 非 `/` 开头时 completion 不显示

- [ ] 测试通过

---

## 验证清单

- [ ] `npx tsc --noEmit` 无错误
- [ ] `npx vitest run src/__tests__/tui/slash-autocomplete.test.ts` 全部通过
- [ ] `npx vitest run src/__tests__/tui/ src/tui/inline/` 全部通过
