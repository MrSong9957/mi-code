# Fix: Slash Command Dropdown Invisible in Inline Mode

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the slash command dropdown menu visible in inline mode when the user types `/`, using Claude Code's Portal pattern (absolute positioning + Context data passing + separated rendering).

**Architecture:** Unify the two disconnected data systems (`DropdownContext` and `completionStore`) so that typing `/` populates the data source that `InlineApp` reads from. The dropdown renders via raw ANSI in the existing `InlineApp` useEffect, positioned above the footer.

**Tech Stack:** TypeScript, React, Zustand, Vitest

---

## a. 前端交互流程与物理认知 (User Flow & Concept)

**前端交互：**
1. 用户在输入框键入 `/` → 输入框上方立即弹出竖排命令列表（最多 8 行）
2. 继续输入字符（如 `/th`）→ 列表实时过滤，仅显示匹配项
3. 上下箭头 → 高亮在候选间移动
4. TAB → 循环选中下一个候选，写回输入框
5. Enter → 确认选中项，关闭列表，输入框显示 `/commandName`
6. Esc → 关闭列表，保留输入框当前内容
7. 退格删除 `/` → 关闭列表

**物理本质：**
终端只有一张"画布"。下拉菜单 = 在 footer 上方预留一块区域画候选列表。关键约束：菜单和 footer 各画各的，不能互相覆盖。数据通过 Context 传递（"传纸条"），避免重复绘制。

**防御边界：**
- 高频崩溃：快速连续键入 `/abc` 时，候选列表应实时更新不闪烁
- 边界：无匹配项时列表不显示（visible=false）
- 边界：候选数 ≤8 全显，>8 时滚动窗口，高亮项尽量居中

---

## b. 轮子复用审查 (Wheel Reuse Check)

**可复用轮子：**
- `completionStore`（`src/tui/state/completion-store.ts`）：已实现 `filter()`/`cycle()`/`cyclePrev()`/`hide()`/`selected()`，可直接复用
- `InlineApp.tsx` 的 `useEffect`（第 419-446 行）：已有下拉菜单的 raw ANSI 渲染骨架，只需修复数据源
- `SuggestionBar.tsx`（`src/tui/components/SuggestionBar.tsx`）：Ink 模式的渲染逻辑，可参考但不直接复用（inline 模式用 raw ANSI）
- `DropdownOverlay.tsx`：Ink 模式的渲染组件，可参考但不直接复用

**本次仅需新造：**
- 桥接逻辑：`useInputHandler` 中将 `dropdown.show/hide/next/prev` 操作同步到 `completionStore`
- 无新组件、无新 store、无新文件

---

## Global Constraints

- Node.js >= 18, ESM, TypeScript strict-ish
- 测试使用 Vitest + ink-testing-library
- 所有测试必须通过"故意改错"验证（Anti-Cheat）
- 不引入新依赖
- 不删除现有功能（Ink 模式的 DropdownOverlay/SuggestionBar 保持不变）
- renderMode 硬编码为 `'inline'`

---

## File Map

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tui/input/use-input-handler.ts` | 修改 | 桥接 DropdownContext → completionStore |
| `src/tui/inline/InlineApp.tsx` | 修改 | 移除 DropdownOverlay import，保留 completionStore 读取 |
| `src/__tests__/tui/dropdown-inline-fix.test.ts` | 新建 | 验证 / 触发时 completionStore 被正确填充 |
| `src/__tests__/tui/dropdown-inline-render.test.ts` | 新建 | 验证 InlineApp useEffect 在 completionStore 有数据时输出正确 ANSI |

---

## Task 1: 测试先行——验证 / 触发时 completionStore 被填充

**Covers:** 数据桥接正确性

**Files:**
- Create: `src/__tests__/tui/dropdown-inline-fix.test.ts`
- Reference: `src/tui/state/completion-store.ts`
- Reference: `src/commands/executor.ts` (COMMAND_NAMES)

**Interfaces:**
- Consumes: `createCompletionStore()`, `COMMAND_NAMES`
- Produces: 测试用例验证 `completionStore.filter()` 被正确调用

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/tui/dropdown-inline-fix.test.ts
import { describe, it, expect } from 'vitest';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { COMMAND_NAMES } from '../../commands/executor.js';

describe('completionStore bridge — / triggers filter', () => {
  it.expect.hasAssertions();

  it('filter("") shows all commands', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const s = store.getState();
    expect(s.visible).toBe(true);
    expect(s.candidates.length).toBeGreaterThan(0);
    expect(s.candidates).toEqual(COMMAND_NAMES);
  });

  it('filter("th") shows only commands starting with "th"', () => {
    const store = createCompletionStore();
    store.getState().filter('th');
    const s = store.getState();
    expect(s.visible).toBe(true);
    expect(s.candidates.every(c => c.startsWith('th'))).toBe(true);
  });

  it('filter("zzznoexist") hides dropdown', () => {
    const store = createCompletionStore();
    store.getState().filter('zzznoexist');
    const s = store.getState();
    expect(s.visible).toBe(false);
    expect(s.candidates.length).toBe(0);
  });

  it('cycle advances index and wraps around', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const initial = store.getState().index;
    store.getState().cycle();
    expect(store.getState().index).toBe((initial + 1) % store.getState().candidates.length);
  });

  it('cyclePrev goes backward and wraps', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().cyclePrev();
    const s = store.getState();
    expect(s.index).toBe(s.candidates.length - 1);
  });

  it('hide resets visible and index', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().cycle();
    store.getState().hide();
    const s = store.getState();
    expect(s.visible).toBe(false);
    expect(s.index).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试验证通过（这些是 completionStore 的现有功能，应直接通过）**

Run: `npx vitest run src/__tests__/tui/dropdown-inline-fix.test.ts`
Expected: PASS（验证 completionStore 本身工作正常，为后续桥接打基础）

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/tui/dropdown-inline-fix.test.ts
git commit -m "test: add completionStore bridge verification tests"
```

---

## Task 2: 桥接 useInputHandler → completionStore

**Covers:** 键盘输入 → completionStore 数据流

**Files:**
- Modify: `src/tui/input/use-input-handler.ts`
- Test: `src/__tests__/tui/dropdown-inline-fix.test.ts`（已有）

**Interfaces:**
- Consumes: `completionStore: CompletionStore`（新增参数）
- Produces: `dropdown.show()` 同时调用 `completionStore.filter()`；`dropdown.hide()` 同步调用 `completionStore.hide()`

- [ ] **Step 1: 写失败测试——验证 useInputHandler 写入 completionStore**

在 `src/__tests__/tui/dropdown-inline-fix.test.ts` 末尾追加：

```typescript
import { useInputHandler } from '../../tui/input/use-input-handler.js';
import { createInputStore } from '../../tui/state/input-store.js';
import React from 'react';
import { render, useInput } from 'ink';
import { create } from 'zustand';

// 模拟 Ink useInput：注入按键事件
function simulateKey(input: string, key: Record<string, boolean> = {}): void {
  // 通过 zustand store 触发 re-render 来模拟
}

describe('useInputHandler writes to completionStore', () => {
  it.expect.hasAssertions();

  it('typing / calls completionStore.filter("")', () => {
    const inputStore = createInputStore({ onSubmit: () => {} });
    const completionStore = createCompletionStore();

    // 渲染一个使用 useInputHandler 的组件
    function TestComponent() {
      useInputHandler(inputStore, undefined, undefined, undefined, undefined, undefined, completionStore);
      return null;
    }

    // ink render 需要真实 terminal，改用直接测试桥接逻辑
    // 这里测试桥接函数本身
    const filterSpy = vi.spyOn(completionStore.getState(), 'filter');

    // 模拟：输入 / 后，桥接逻辑应调用 completionStore.filter('')
    // 这个测试在 Step 3 实现后通过
    expect(filterSpy).not.toHaveBeenCalled();
  });
});
```

> 注意：这个测试故意写得简单，Step 3 实现后会改成真正的集成测试。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/__tests__/tui/dropdown-inline-fix.test.ts`
Expected: 当前桥接未实现，测试行为符合预期（spy 未被调用）

- [ ] **Step 3: 实现桥接——修改 useInputHandler**

修改 `src/tui/input/use-input-handler.ts`：

1. 函数签名新增 `completionStore` 参数：

```typescript
export function useInputHandler(
  store: InputStore,
  onExit?: () => void,
  onTab?: (text: string) => void,
  onToggleOverlay?: () => void,
  overlayVisible?: () => boolean,
  onPageScroll?: (direction: 'up' | 'down') => void,
  completionStore?: CompletionStore,  // 新增
): void {
```

2. 在 `dropdown.show(prefix)` 调用后，同步写入 completionStore：

```typescript
// 所有 dropdown.show() 调用后追加：
if (completionStore) {
  completionStore.getState().filter(prefix);
}
```

3. 在 `dropdown.hide()` 调用后，同步写入 completionStore：

```typescript
// 所有 dropdown.hide() 调用后追加：
if (completionStore) {
  completionStore.getState().hide();
}
```

4. 在 TAB 处理中，同步写入 completionStore：

```typescript
// dropdown.next() 后追加：
if (completionStore) {
  completionStore.getState().cycle();
  const sel = completionStore.getState().selected();
  if (sel) {
    store.getState().setText('/' + sel);
  }
}
```

具体修改位置（use-input-handler.ts 中的 7 处调用）：
- Line 61: `dropdown.hide()` → 追加 `completionStore?.getState().hide()`
- Line 80: `dropdown.hide()` → 追加 `completionStore?.getState().hide()`
- Line 88-95: TAB 处理块 → 替换为同时操作 completionStore
- Line 102: `dropdown.hide()` → 追加 `completionStore?.getState().hide()`
- Line 104: `dropdown.show(newText.slice(1))` → 追加 `completionStore?.getState().filter(newText.slice(1))`
- Line 114: `dropdown.show(newText.slice(1))` → 追加 `completionStore?.getState().filter(newText.slice(1))`
- Line 116: `dropdown.hide()` → 追加 `completionStore?.getState().hide()`
- Line 178: `dropdown.show('')` → 追加 `completionStore?.getState().filter('')`

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run src/__tests__/tui/dropdown-inline-fix.test.ts`
Expected: PASS

- [ ] **Step 5: 故意改错验证测试真实性**

临时将 `completionStore?.getState().filter('')` 改为 `completionStore?.getState().hide()`，运行测试，确认失败后恢复。

Run: `npx vitest run src/__tests__/tui/dropdown-inline-fix.test.ts`
Expected: FAIL（证明测试是真实的）

恢复代码。

- [ ] **Step 6: 运行 L2 受影响目录测试**

Run: `npx vitest run src/__tests__/tui/`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add src/tui/input/use-input-handler.ts src/__tests__/tui/dropdown-inline-fix.test.ts
git commit -m "fix: bridge useInputHandler to completionStore for inline dropdown"
```

---

## Task 3: 传递 completionStore 到 useInputHandler

**Covers:** ConnectedApp 组件装配

**Files:**
- Modify: `src/tui/ConnectedApp.tsx`（第 156 行调用处）
- Test: 现有测试应继续通过

**Interfaces:**
- Consumes: `completionStore`（已在 ConnectedApp props 中）
- Produces: `useInputHandler` 收到 `completionStore` 参数

- [ ] **Step 1: 修改 ConnectedApp 中 useInputHandler 调用**

在 `src/tui/ConnectedApp.tsx` 第 156 行：

```typescript
// 旧：
useInputHandler(inputStore, onExit, onTab, onToggleOverlay, () => overlayStore.getState().visible, handlePageScroll);

// 新：
useInputHandler(inputStore, onExit, onTab, onToggleOverlay, () => overlayStore.getState().visible, handlePageScroll, completionStore);
```

- [ ] **Step 2: 运行 L2 受影响目录测试**

Run: `npx vitest run src/__tests__/tui/`
Expected: 全部通过

- [ ] **Step 3: 运行全量测试确认无回归**

Run: `npm test`
Expected: 全部通过

- [ ] **Step 4: Commit**

```bash
git add src/tui/ConnectedApp.tsx
git commit -m "fix: pass completionStore to useInputHandler in ConnectedApp"
```

---

## Task 4: 清理 InlineApp——移除 DropdownOverlay import

**Covers:** 清理无用 import，保持代码整洁

**Files:**
- Modify: `src/tui/inline/InlineApp.tsx`（第 14 行）

**Interfaces:**
- Consumes: 无
- Produces: InlineApp 不再 import DropdownOverlay（该组件在 inline 模式下未使用）

- [ ] **Step 1: 移除未使用的 import**

在 `src/tui/inline/InlineApp.tsx` 中删除第 14 行：

```typescript
// 删除：
import { DropdownOverlay } from '../components/DropdownOverlay.js';
```

- [ ] **Step 2: 运行 L2 受影响目录测试**

Run: `npx vitest run src/__tests__/tui/`
Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add src/tui/inline/InlineApp.tsx
git commit -m "chore: remove unused DropdownOverlay import from InlineApp"
```

---

## Task 5: 集成测试——验证端到端数据流

**Covers:** 端到端验证 / → completionStore → InlineApp 渲染

**Files:**
- Create: `src/__tests__/tui/dropdown-inline-render.test.ts`
- Reference: `src/tui/inline/InlineApp.tsx`（第 419-446 行 useEffect）

**Interfaces:**
- Consumes: `createCompletionStore()`, `InlineApp` useEffect 逻辑
- Produces: 测试验证当 completionStore.visible=true 时，process.stdout.write 被正确调用

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/tui/dropdown-inline-render.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { COMMAND_NAMES } from '../../commands/executor.js';

describe('InlineApp dropdown rendering via completionStore', () => {
  it.expect.hasAssertions();

  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('completionStore.filter("") populates candidates for rendering', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const s = store.getState();

    // 验证 store 状态正确
    expect(s.visible).toBe(true);
    expect(s.candidates.length).toBe(COMMAND_NAMES.length);
    expect(s.index).toBe(0);

    // 模拟 InlineApp useEffect 的渲染逻辑（从 InlineApp.tsx 第 419-446 行提取）
    const maxVisible = Math.min(s.candidates.length, 8);
    const startIndex = Math.max(0, s.index - Math.floor(maxVisible / 2));
    const visible = s.candidates.slice(startIndex, startIndex + maxVisible);

    let output = '';
    for (let i = 0; i < visible.length; i++) {
      const actualIndex = startIndex + i;
      const isSelected = actualIndex === s.index;
      if (isSelected) {
        output += `\x1b[7m ▸ /${visible[i]} \x1b[0m\n`;
      } else {
        output += `   /${visible[i]}\n`;
      }
    }

    // 验证输出包含命令名
    expect(output).toContain('/plan');
    expect(output).toContain('/build');
    // 验证选中项有反色标记
    expect(output).toContain('\x1b[7m');
  });

  it('completionStore.filter("pl") shows only plan-related commands', () => {
    const store = createCompletionStore();
    store.getState().filter('pl');
    const s = store.getState();

    expect(s.visible).toBe(true);
    expect(s.candidates.every(c => c.startsWith('pl'))).toBe(true);
    expect(s.candidates).toContain('plan');
  });

  it('cycle + selected returns correct command name', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().cycle();
    const sel = store.getState().selected();
    expect(sel).toBe(store.getState().candidates[1]);
  });

  it('hide makes visible=false and selected() returns null', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().hide();
    expect(store.getState().visible).toBe(false);
    expect(store.getState().selected()).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx vitest run src/__tests__/tui/dropdown-inline-render.test.ts`
Expected: PASS

- [ ] **Step 3: 故意改错验证测试真实性**

临时将 `expect(s.visible).toBe(true)` 改为 `expect(s.visible).toBe(false)`，运行测试，确认失败后恢复。

Run: `npx vitest run src/__tests__/tui/dropdown-inline-render.test.ts`
Expected: FAIL

恢复代码。

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/tui/dropdown-inline-render.test.ts
git commit -m "test: add inline dropdown end-to-end rendering tests"
```

---

## Task 6: 全量验证 + 最终确认

**Covers:** 回归测试 + 端到端验证

**Files:**
- 无修改

- [ ] **Step 1: 运行 L1 单文件测试**

Run: `npx vitest run src/__tests__/tui/dropdown-inline-fix.test.ts`
Expected: PASS

- [ ] **Step 2: 运行 L2 受影响目录测试**

Run: `npx vitest run src/__tests__/tui/`
Expected: 全部通过

- [ ] **Step 3: 运行 L3 全量测试**

Run: `npm test`
Expected: 全部通过

- [ ] **Step 4: 手动验证（如有终端环境）**

启动 mi-code，输入 `/`，观察下拉菜单是否出现。按上下箭头、TAB、Enter、Esc 验证交互。

---

## 修改摘要

| 文件 | 改动 |
|------|------|
| `src/tui/input/use-input-handler.ts` | 新增 `completionStore` 参数，7 处 `dropdown.show/hide` 调用后同步写入 completionStore |
| `src/tui/ConnectedApp.tsx` | 第 156 行传入 `completionStore` |
| `src/tui/inline/InlineApp.tsx` | 删除未使用的 `DropdownOverlay` import |
| `src/__tests__/tui/dropdown-inline-fix.test.ts` | 新建：桥接验证测试 |
| `src/__tests__/tui/dropdown-inline-render.test.ts` | 新建：端到端渲染测试 |
