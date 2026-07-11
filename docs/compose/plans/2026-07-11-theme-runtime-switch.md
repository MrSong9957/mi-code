# 运行时主题切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户输入 `/theme dark` 或 `/theme light` 后，TUI 界面立即切换主题颜色。

**Architecture:** 用 zustand store 持有当前主题名，React 组件订阅 store 自动重渲染。`/theme` 命令更新 store。

**Tech Stack:** zustand (状态管理), React Context (主题分发), 现有命令系统 (`parseCommand` + `executeCommand`)

---

## 现状分析

当前主题在 `bootstrap()` 时通过 `ThemeProvider` 注入，是**静态的**——启动后无法改变。

```
bootstrap() → ThemeProvider(value=dark) → ConnectedApp → StatusBar/Spinner/...
```

问题：`ThemeProvider` 接收一个固定值，没有订阅任何 store，切换后组件不会重渲染。

## 改造方案

用 zustand store 替代静态值：

```
createThemeStore('dark') → ThemeProvider 订阅 store → store 变化时自动重渲染
                                    ↑
/theme light 命令 → store.setTheme('light') → Provider 重渲染 → 子组件拿到新主题
```

核心变化：
1. 新建 `theme-store.ts`：zustand store 持有 `themeName`
2. 改造 `theme-context.ts`：新增 `ThemeStoreProvider` 包装组件，订阅 store
3. 改造 `bootstrap.tsx`：用 `ThemeStoreProvider` 替代静态 `ThemeProvider`
4. 新增 `/theme` 命令：更新 store

---

## Task 1: 创建 theme-store.ts

**Files:**
- Create: `src/tui/state/theme-store.ts`

**Interfaces:**
- Consumes: `ThemeName` from `utils/theme.js`
- Produces: `createThemeStore()`, `ThemeStore`

- [ ] 创建 `src/tui/state/theme-store.ts`：

```ts
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ThemeName } from '../../utils/theme.js';

interface ThemeState {
  themeName: ThemeName;
  setTheme: (name: ThemeName) => void;
}

export type ThemeStore = StoreApi<ThemeState>;

export function createThemeStore(initial: ThemeName = 'dark'): ThemeStore {
  return createStore<ThemeState>((set) => ({
    themeName: initial,
    setTheme: (name) => set({ themeName: name }),
  }));
}
```

- [ ] Typecheck 通过

---

## Task 2: 改造 theme-context.ts

**Files:**
- Modify: `src/tui/state/theme-context.ts`

**Interfaces:**
- Consumes: `ThemeStore` from Task 1
- Produces: `ThemeStoreProvider` (React 组件，订阅 store 并提供主题)

- [ ] 在 `theme-context.ts` 新增 `ThemeStoreProvider`：

```ts
import React, { useState, useEffect } from 'react';
import { getTheme as getDefaultTheme, type Theme, type ThemeName } from '../../utils/theme.js';
import type { ThemeStore } from './theme-store.js';

// ... 保留现有 ThemeContext、ThemeProvider、useTheme、getTheme ...

export interface ThemeStoreProviderProps {
  store: ThemeStore;
  children: React.ReactNode;
}

/**
 * 订阅 theme-store 的 Provider 组件。
 * store.themeName 变化时自动重渲染子组件。
 */
export function ThemeStoreProvider({ store, children }: ThemeStoreProviderProps): React.ReactElement {
  const [themeName, setThemeName] = useState<ThemeName>(store.getState().themeName);

  useEffect(() => {
    return store.subscribe((state) => {
      setThemeName(state.themeName);
    });
  }, [store]);

  const theme = getDefaultTheme(themeName);
  return React.createElement(ThemeProvider, { value: theme }, children);
}
```

- [ ] Typecheck 通过

---

## Task 3: 改造 bootstrap.tsx

**Files:**
- Modify: `src/tui/bootstrap.tsx`
- Modify: `src/tui/bootstrap.tsx` → `BootstrapHandle` 接口

**Interfaces:**
- Consumes: `createThemeStore` from Task 1, `ThemeStoreProvider` from Task 2
- Produces: `themeStore` 暴露给外部（index.ts 用于命令执行）

- [ ] 在 bootstrap 中创建 themeStore 并传入 ThemeStoreProvider：

```ts
// 在 imports 区域添加
import { createThemeStore } from './state/theme-store.js';
import { ThemeStoreProvider } from './state/theme-context.js';

// 在 bootstrap 函数内部，替换静态 ThemeProvider
const themeStore = createThemeStore(opts.themeName);

// 替换原来的 ThemeProvider 为 ThemeStoreProvider
React.createElement(ThemeStoreProvider, { store: themeStore },
  React.createElement(ConnectedApp, { ... })
)

// 在 BootstrapHandle 接口添加
themeStore: ThemeStore;

// 在 return 对象添加
themeStore,
```

- [ ] Typecheck 通过

---

## Task 4: 新增 /theme 命令

**Files:**
- Modify: `src/commands/executor.ts`
- Modify: `src/index.ts`（传入 themeStore）
- Create: `src/__tests__/theme-command.test.ts`

**Interfaces:**
- Consumes: `ThemeStore` from Task 1
- Produces: `/theme` 命令执行结果

- [ ] 在 `COMMAND_NAMES` 数组添加 `'theme'`

- [ ] 在 `executeCommand` 的 switch 添加：

```ts
case 'theme':
  return handleTheme(cmd, ctx);
```

- [ ] 添加 `handleTheme` 函数：

```ts
function handleTheme(cmd: Command, ctx: CommandContext): CommandResult {
  const themeName = cmd.args[0];
  if (themeName !== 'dark' && themeName !== 'light') {
    return { message: 'Usage: /theme <dark|light>' };
  }
  ctx.themeStore?.getState().setTheme(themeName);
  return { message: `Theme switched to ${themeName}` };
}
```

- [ ] 在 `CommandContext` 接口添加 `themeStore?: ThemeStore`

- [ ] 在 `index.ts` 中把 `themeStore` 传入 executeCommand 的 ctx

- [ ] Typecheck + 测试通过

---

## Task 5: 回归测试

**Files:**
- Create: `src/__tests__/theme-switch-runtime.test.ts`

**Interfaces:**
- Consumes: `createThemeStore` from Task 1, `handleTheme` 逻辑

- [ ] 测试 `/theme` 命令切换主题：

```ts
import { describe, it, expect } from 'vitest';
import { createThemeStore } from '../tui/state/theme-store.js';
import { executeCommand, type Command } from '../commands/executor.js';

describe('运行时主题切换', () => {
  it('/theme light 切换 store 为 light', () => {
    const store = createThemeStore('dark');
    const cmd: Command = { name: 'theme', args: ['light'] };
    const result = executeCommand(cmd, { themeStore: store });
    expect(store.getState().themeName).toBe('light');
    expect(result.message).toContain('light');
  });

  it('/theme dark 切换回 dark', () => {
    const store = createThemeStore('light');
    const cmd: Command = { name: 'theme', args: ['dark'] };
    executeCommand(cmd, { themeStore: store });
    expect(store.getState().themeName).toBe('dark');
  });

  it('/theme invalid 报错', () => {
    const store = createThemeStore('dark');
    const cmd: Command = { name: 'theme', args: ['invalid'] };
    const result = executeCommand(cmd, { themeStore: store });
    expect(result.message).toContain('Usage');
    expect(store.getState().themeName).toBe('dark'); // 不变
  });
});
```

- [ ] 运行测试通过

---

## 验证清单

- [ ] `npx tsc --noEmit` 无错误
- [ ] `npx vitest run src/tui/inline/theme-switch-regression.test.ts` 全部通过
- [ ] `npx vitest run src/__tests__/theme-switch-runtime.test.ts` 全部通过
- [ ] `npx vitest run src/__tests__/tui/ src/tui/inline/` 全部通过（415+ 测试）
