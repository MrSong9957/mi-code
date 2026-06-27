# 输入历史记录功能设计

## 概述

为 micode 添加输入历史记录功能，支持通过上/下方向键翻阅历史输入，类似 shell 的 history 功能。

## 需求

- 支持上/下方向键翻阅历史输入
- 最大 50 条历史记录
- 全局存储，按项目过滤
- 当前会话记录优先显示
- 连续相同输入去重
- 文件持久化，跨会话保留

## 架构

### 数据流

```
用户输入 → ESC序列检测 → 上/下箭头 → 历史记录切换
                ↓
        HistoryManager
                ↓
        ~/.micode/history.jsonl
```

### 数据结构

```typescript
interface HistoryEntry {
  input: string        // 用户输入
  project: string      // 项目路径
  sessionId: string    // 会话 ID
  timestamp: number    // 时间戳
}
```

### 文件格式

- 位置：`~/.micode/history.jsonl`
- 格式：JSONL，每行一个 JSON 对象
- 最大条数：50 条（全局，按项目过滤后）

## 实现细节

### 1. ESC 序列检测

在 `src/index.ts` 的 stdin data 事件中添加方向键检测：

```typescript
// 上箭头: \x1b[A
if (byte === 0x1b && data[i+1] === 0x5b && data[i+2] === 0x41) {
  // 处理上箭头
  i += 3;
  continue;
}

// 下箭头: \x1b[B
if (byte === 0x1b && data[i+1] === 0x5b && data[i+2] === 0x42) {
  // 处理下箭头
  i += 3;
  continue;
}
```

### 2. HistoryManager 类

```typescript
class HistoryManager {
  private historyPath: string
  private sessionId: string
  private cache: HistoryEntry[] = []
  private historyIndex: number = -1
  private draft: string = ''

  constructor() {
    this.historyPath = join(homedir(), '.micode', 'history.jsonl')
    this.sessionId = randomUUID()
  }

  // 添加到历史记录
  async addEntry(input: string, project: string): Promise<void>

  // 获取当前项目的历史记录
  async getHistory(project: string): Promise<HistoryEntry[]>

  // 上箭头：返回上一条历史
  async up(currentInput: string, project: string): Promise<string | null>

  // 下箭头：返回下一条历史
  async down(): Promise<string | null>

  // 重置历史索引
  reset(): void

  // 去重：连续相同输入不记录
  private shouldRecord(input: string): boolean
}
```

### 3. 存储逻辑

- 追加写入：`fs.appendFile(historyPath, JSON.stringify(entry) + '\n')`
- 读取：逐行读取，按项目过滤，当前会话优先
- 清理：超过 50 条时，保留最新的 50 条

### 4. 草稿保存

- 按上箭头前保存当前输入为草稿
- 按下箭头到底时恢复草稿
- 按回车或 ESC 时清除草稿

## 边界条件

1. **文件不存在**：首次使用时自动创建
2. **文件损坏**：跳过无法解析的行，不报错
3. **并发写入**：使用文件锁或队列保证原子性
4. **空历史**：上箭头无响应，保持当前输入

## 测试计划

1. 基本功能：输入命令，上箭头能翻阅
2. 去重：连续输入相同命令，历史只保留一条
3. 项目隔离：不同项目的历史互不干扰
4. 持久化：重启后历史记录仍在
5. 边界：空历史、单条历史、满历史

## 文件变更

- `src/history.ts`（新建）— HistoryManager 实现
- `src/index.ts` — 添加 ESC 序列检测和历史记录调用
