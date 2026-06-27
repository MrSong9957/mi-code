# 输入历史记录功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 micode 添加输入历史记录功能，支持通过上/下方向键翻阅历史输入，最大 50 条，全局存储按项目过滤。

**Architecture:** 新建 `HistoryManager` 类处理历史记录的增删改查，存储到 `~/.micode/history.jsonl`；在 `src/index.ts` 的 stdin 处理中添加 ESC 序列检测，调用 HistoryManager 实现上下翻阅。

**Tech Stack:** TypeScript, Node.js fs/promises, Vitest

## Global Constraints

- 最大历史条数：50 条
- 存储位置：`~/.micode/history.jsonl`
- 去重规则：连续相同输入不记录
- 项目隔离：按 `process.cwd()` 过滤
- 会话优先：当前会话记录排在前面

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/history.ts` (新建) | HistoryManager 类，处理历史记录的存储、读取、去重 |
| `src/__tests__/history.test.ts` (新建) | HistoryManager 单元测试 |
| `src/index.ts` (修改) | 添加 ESC 序列检测，集成 HistoryManager |

---

### Task 1: 创建 HistoryManager 基础结构

**Files:**
- Create: `src/history.ts`
- Test: `src/__tests__/history.test.ts`

**Interfaces:**
- Produces: `HistoryManager` class with `addEntry()`, `getHistory()`, `up()`, `down()`, `reset()` methods

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/history.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { HistoryManager } from '../history.js'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

describe('HistoryManager', () => {
  const testHistoryPath = join(homedir(), '.micode', 'history.jsonl.test')
  let manager: HistoryManager

  beforeEach(() => {
    if (existsSync(testHistoryPath)) {
      rmSync(testHistoryPath)
    }
    manager = new HistoryManager(testHistoryPath)
  })

  afterEach(() => {
    if (existsSync(testHistoryPath)) {
      rmSync(testHistoryPath)
    }
  })

  it('should create HistoryManager instance', () => {
    expect(manager).toBeDefined()
    expect(manager).toBeInstanceOf(HistoryManager)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/history.test.ts`
Expected: FAIL with "HistoryManager is not defined" or module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/history.ts
import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

export interface HistoryEntry {
  input: string
  project: string
  sessionId: string
  timestamp: number
}

const MAX_HISTORY_ITEMS = 50

export class HistoryManager {
  private historyPath: string
  private sessionId: string
  private cache: HistoryEntry[] = []
  private historyIndex: number = -1
  private draft: string = ''
  private lastInput: string = ''

  constructor(historyPath?: string) {
    this.historyPath = historyPath || join(homedir(), '.micode', 'history.jsonl')
    this.sessionId = randomUUID()
  }

  async addEntry(input: string, project: string): Promise<void> {
    if (input === this.lastInput) {
      return
    }
    this.lastInput = input

    const entry: HistoryEntry = {
      input,
      project,
      sessionId: this.sessionId,
      timestamp: Date.now()
    }

    const dir = dirname(this.historyPath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    await appendFile(this.historyPath, JSON.stringify(entry) + '\n', 'utf-8')
    this.cache.unshift(entry)

    if (this.cache.length > MAX_HISTORY_ITEMS) {
      this.cache = this.cache.slice(0, MAX_HISTORY_ITEMS)
    }
  }

  async getHistory(project: string): Promise<HistoryEntry[]> {
    if (this.cache.length > 0) {
      return this.cache.filter(e => e.project === project)
    }

    if (!existsSync(this.historyPath)) {
      return []
    }

    const content = await readFile(this.historyPath, 'utf-8')
    const lines = content.split('\n').filter(line => line.trim())

    const entries: HistoryEntry[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as HistoryEntry
        if (entry.project === project) {
          entries.push(entry)
        }
      } catch {
        // 跳过损坏的行
      }
    }

    entries.sort((a, b) => {
      if (a.sessionId === this.sessionId && b.sessionId !== this.sessionId) return -1
      if (a.sessionId !== this.sessionId && b.sessionId === this.sessionId) return 1
      return b.timestamp - a.timestamp
    })

    this.cache = entries.slice(0, MAX_HISTORY_ITEMS)
    return this.cache
  }

  async up(currentInput: string, project: string): Promise<string | null> {
    if (this.historyIndex === -1) {
      this.draft = currentInput
    }

    const history = await this.getHistory(project)

    if (history.length === 0) {
      return null
    }

    const newIndex = this.historyIndex + 1
    if (newIndex >= history.length) {
      return null
    }

    this.historyIndex = newIndex
    return history[newIndex].input
  }

  async down(project?: string): Promise<string | null> {
    if (this.historyIndex <= 0) {
      this.historyIndex = -1
      return this.draft
    }

    this.historyIndex--

    if (this.cache.length > 0 && this.historyIndex < this.cache.length) {
      return this.cache[this.historyIndex].input
    }

    return null
  }

  reset(): void {
    this.historyIndex = -1
    this.draft = ''
  }

  async cleanup(): Promise<void> {
    if (!existsSync(this.historyPath)) {
      return
    }

    const content = await readFile(this.historyPath, 'utf-8')
    const lines = content.split('\n').filter(line => line.trim())

    if (lines.length > MAX_HISTORY_ITEMS) {
      const keep = lines.slice(-MAX_HISTORY_ITEMS)
      await writeFile(this.historyPath, keep.join('\n') + '\n', 'utf-8')
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/history.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/history.ts src/__tests__/history.test.ts
git commit -m "feat: add HistoryManager basic structure"
```

---

### Task 2: 完善 HistoryManager 测试

**Files:**
- Modify: `src/__tests__/history.test.ts`

**Interfaces:**
- Consumes: `HistoryManager` from Task 1

- [ ] **Step 1: Write failing tests for core functionality**

```typescript
// src/__tests__/history.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { HistoryManager } from '../history.js'
import { existsSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

describe('HistoryManager', () => {
  const testHistoryPath = join(homedir(), '.micode', 'history.jsonl.test')
  let manager: HistoryManager

  beforeEach(() => {
    if (existsSync(testHistoryPath)) {
      rmSync(testHistoryPath)
    }
    manager = new HistoryManager(testHistoryPath)
  })

  afterEach(() => {
    if (existsSync(testHistoryPath)) {
      rmSync(testHistoryPath)
    }
  })

  it('should create HistoryManager instance', () => {
    expect(manager).toBeDefined()
    expect(manager).toBeInstanceOf(HistoryManager)
  })

  it('should add entry to history', async () => {
    await manager.addEntry('test command', '/test/project')

    expect(existsSync(testHistoryPath)).toBe(true)
    const content = readFileSync(testHistoryPath, 'utf-8')
    const entry = JSON.parse(content.trim())
    expect(entry.input).toBe('test command')
    expect(entry.project).toBe('/test/project')
  })

  it('should deduplicate consecutive same inputs', async () => {
    await manager.addEntry('test command', '/test/project')
    await manager.addEntry('test command', '/test/project')
    await manager.addEntry('test command', '/test/project')

    const content = readFileSync(testHistoryPath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(1)
  })

  it('should allow same input after different input', async () => {
    await manager.addEntry('command 1', '/test/project')
    await manager.addEntry('command 2', '/test/project')
    await manager.addEntry('command 1', '/test/project')

    const content = readFileSync(testHistoryPath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(3)
  })

  it('should get history filtered by project', async () => {
    await manager.addEntry('command 1', '/project/a')
    await manager.addEntry('command 2', '/project/b')
    await manager.addEntry('command 3', '/project/a')

    const historyA = await manager.getHistory('/project/a')
    const historyB = await manager.getHistory('/project/b')

    expect(historyA).toHaveLength(2)
    expect(historyB).toHaveLength(1)
    expect(historyA[0].input).toBe('command 3')
  })

  it('should navigate history with up/down', async () => {
    await manager.addEntry('command 1', '/test/project')
    await manager.addEntry('command 2', '/test/project')
    await manager.addEntry('command 3', '/test/project')

    const first = await manager.up('', '/test/project')
    expect(first).toBe('command 3')

    const second = await manager.up('', '/test/project')
    expect(second).toBe('command 2')

    const third = await manager.up('', '/test/project')
    expect(third).toBe('command 1')

    const fourth = await manager.up('', '/test/project')
    expect(fourth).toBeNull()
  })

  it('should save and restore draft', async () => {
    await manager.addEntry('command 1', '/test/project')

    const first = await manager.up('draft input', '/test/project')
    expect(first).toBe('command 1')

    const draft = await manager.down()
    expect(draft).toBe('draft input')
  })

  it('should reset history index', async () => {
    await manager.addEntry('command 1', '/test/project')

    await manager.up('', '/test/project')
    manager.reset()

    const first = await manager.up('', '/test/project')
    expect(first).toBe('command 1')
  })

  it('should cleanup old history entries', async () => {
    for (let i = 0; i < 60; i++) {
      await manager.addEntry(`command ${i}`, '/test/project')
    }

    await manager.cleanup()

    const content = readFileSync(testHistoryPath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(50)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/__tests__/history.test.ts`
Expected: Some tests FAIL

- [ ] **Step 3: Fix implementation if needed**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/__tests__/history.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/history.test.ts
git commit -m "test: add HistoryManager comprehensive tests"
```

---

### Task 3: 在 index.ts 中集成 ESC 序列检测

**Files:**
- Modify: `src/index.ts:291-323` (stdin data 事件处理)

**Interfaces:**
- Consumes: `HistoryManager` from Task 1
- Produces: 方向键处理逻辑

- [ ] **Step 1: Import HistoryManager**

```typescript
// src/index.ts 顶部添加
import { HistoryManager } from './history.js'
```

- [ ] **Step 2: Initialize HistoryManager**

```typescript
// 在文件顶部或合适位置添加
const historyManager = new HistoryManager()
const currentProject = process.cwd()
```

- [ ] **Step 3: Add ESC sequence detection in stdin handler**

```typescript
// 在 stdin data 事件处理中，在回车处理之前添加
// ESC 序列检测 (方向键)
if (byte === 0x1b && i + 2 < data.length && data[i + 1] === 0x5b) {
  // 上箭头: \x1b[A
  if (data[i + 2] === 0x41) {
    if (!isProcessing) {
      const historyInput = await historyManager.up(input, currentProject)
      if (historyInput !== null) {
        input = historyInput
        cursorPos = [...input].length
        scheduleRender()
      }
    }
    i += 3
    continue
  }
  // 下箭头: \x1b[B
  if (data[i + 2] === 0x42) {
    if (!isProcessing) {
      const historyInput = await historyManager.down(currentProject)
      if (historyInput !== null) {
        input = historyInput
        cursorPos = [...input].length
        scheduleRender()
      }
    }
    i += 3
    continue
  }
}
```

- [ ] **Step 4: Add history entry on Enter**

```typescript
// 在回车处理中，input 清空之前添加
if (input.trim() && !isProcessing) {
  const userInput = input.trim()
  await historyManager.addEntry(userInput, currentProject)
  messages.push('> ' + userInput)
  input = ''
  cursorPos = 0
  scheduleRender()
  // ... 其余代码
}
```

- [ ] **Step 5: Reset history on Enter**

```typescript
// 在回车处理的末尾添加
historyManager.reset()
```

- [ ] **Step 6: Test manually**

Run: `npm run dev`
Type some commands, press up/down arrows to verify history works.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate history manager with arrow key navigation"
```

---

### Task 4: 清理和优化

**Files:**
- Modify: `src/history.ts`
- Modify: `src/__tests__/history.test.ts`

**Interfaces:**
- All previous tasks complete

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 2: Run linting**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 3: Run type check**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete input history feature with arrow key navigation"
```

---

## 自检清单

- [x] **Spec 覆盖**：所有需求都有对应任务
  - 上/下箭头翻阅 → Task 3
  - 最大 50 条 → Task 1
  - 全局存储按项目过滤 → Task 1
  - 当前会话优先 → Task 1
  - 连续去重 → Task 1
  - 文件持久化 → Task 1

- [x] **Placeholder 扫描**：无 TBD/TODO

- [x] **类型一致性**：所有任务使用相同的 `HistoryEntry` 接口和 `HistoryManager` 类

---

## 执行选项

**Plan complete and saved to `docs/superpowers/plans/2026-06-27-input-history.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - 我为每个任务分派独立子代理，任务间审查，快速迭代

**2. Inline Execution** - 在当前会话中执行任务，批量执行带检查点

**选择哪种方式？**
