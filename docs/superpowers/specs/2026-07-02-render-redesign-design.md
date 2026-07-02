# 渲染引擎重设计：顺序追加 + 绝对定位底部区

> 日期：2026-07-02
> 状态：设计待审查
> 背景：现有 Renderer 的"画布 diff"算法为备用屏设计，但实际跑在主屏，导致满屏后坐标脱钩、内容重复、边框残片。多轮补丁修复均治标不治本或引入新问题。本设计彻底废弃画布 diff，改用双区解耦模型。

## 1. 问题根因

### 现有架构（废弃）
Renderer 在主屏模拟"备用屏画布"：每帧把所有消息+页脚重建成一张二维 Screen，与上一帧逐格 diff（Segment 1/2/3），用相对光标移动（CUB/CUU/CUD）只更新变化的格子。

### 为什么失败
- **主屏有原生 scrollback + 自动换行**，破坏画布坐标系假设。
- 满屏后，`prevCursorY`（画布绝对坐标）远大于终端行数，相对光标移动被终端钳位，VirtualScreen 记账与物理光标永久脱钩 → 乱码、内容重复、边框串入。
- 补丁（footer fullReset、软重画、写空格、cup 绝对定位）都在画布 diff 框架内打转，无法根治。

## 2. 设计目标

| 目标 | 说明 |
|------|------|
| **根治满屏乱码** | 消息区与底部区坐标模型彻底分离，互不干扰 |
| **保留 TUI 布局感** | 状态栏 + 输入框钉在屏幕底部 |
| **保留原生 scrollback** | 用户可用鼠标滚轮翻历史 |
| **流式 markdown** | 当前 assistant 块支持逐字增长、局部回改 |
| **低重构风险** | 复用 MessageFormatter/MessageBuffer/markdown 等纯逻辑，只重写 commit 核心 |

## 3. 核心模型：双区解耦

把屏幕分成两个**完全独立**的渲染区，各自有自己的坐标模型：

```
┌─────────────────────────────┐
│  消息区（顺序追加，可滚动）   │  ← 只往下写，绝不回头改
│  ...                         │     旧行滚进原生 scrollback
│  ● 当前流式块（可局部退格重写）│  ← 仅这一块允许 CUU+eraseLine 回溯
├─────────────────────────────┤  ← 上边框（底部区顶部）
│  ❯ 输入框                    │  ← 底部固定区：CUP 绝对定位刷新
├─────────────────────────────┤  ← 下边框
│  Act │ model │ dir │ branch │  ← 状态栏：CUP 绝对定位刷新
└─────────────────────────────┘
```

### 两条铁律
1. **消息区一旦某行"封口"（流式结束/seal），永久不可变。** 新内容只能追加到当前光标位置。
2. **底部固定区永远用 CUP（`\x1b[r;cH`）绝对定位**，不依赖光标当前位置。

## 4. 三个渲染子系统

| 子系统 | 职责 | 坐标模型 | 触发 |
|--------|------|---------|------|
| **消息追加器** | 新消息/thinking/tool_result/hook 块往下写 | 顺序 LF（光标始终在"最后一行之后"）| emit 封口块、assistant isFinal |
| **流式重写器** | 当前 assistant 块的逐字增长 | 局部退格（CUU N + eraseLine）重写当前块占的几行 | emit assistant_text delta（isFinal=false）|
| **底部区刷新器** | 状态栏 + 输入框 + 边框 | CUP 绝对定位（钉在屏幕最后 footerHeight 行）| 每帧末尾 + 状态变化时 |

三者**不共享画布**。消息追加器只管"往下写"，流式重写器只管"当前块那几行"，底部区刷新器只管"最后 4-6 行"。没有任何一个需要知道"整个屏幕长什么样"。

## 5. 子系统算法

### 5.1 消息追加器
每个块经 MessageFormatter 格式化成若干行 → 逐行 `writeMsgLine(line)` → 行间 LF。写完后封口，永久不可变。

维护状态 `lastFlushedLine: number`（消息区"已写到第几行"，0-based）。每写一行 `lastFlushedLine++`，**只增不减**（封口的行不退）。当消息行数超过可视区（`lastFlushedLine > rows - footerHeight`），LF 触发终端原生滚动——旧行进 scrollback，底部区始终钉在最后 footerHeight 行。

> 注：`lastFlushedLine` 同时也是"消息区光标所在行"——两者是同一个量，下文流式重写器中提到的 `msgCursorRow` 即 `lastFlushedLine`。

### 5.2 流式重写器（退格重写当前块）
1. 记录当前 assistant 块开始写入时的行位置 `streamingBlockStartRow`（第一次 delta 时记下，= 当时的 `lastFlushedLine`）。
2. 每次 delta：`CUU (lastFlushedLine - streamingBlockStartRow)` + 逐行 `eraseLine` 回到 blockStartRow，重新格式化整个当前文本，逐行写出，更新 `lastFlushedLine = streamingBlockStartRow + newLineCount`。
3. isFinal 时封口，`streamingBlockStartRow = null`。

回溯范围 = 单个 assistant 块的行数（通常几行，CUU 十几次），绝不跨屏、绝不到 scrollback 区。

**降级**：若块增长到撑满屏幕（`lastFlushedLine - streamingBlockStartRow >= rows - footerHeight`），封口已写部分，`streamingBlockStartRow = lastFlushedLine`，后续纯追加。视觉等价顺序输出。

### 5.3 底部区刷新器（CUP 绝对定位）
```
每帧末尾：
  cursorHome()  // \x1b[H 不擦屏
  CUP 到第 (rows - footerHeight) 行 0 列  // 上边框（1-based: rows - footerHeight + 1）
  eraseLine + 写上边框 ─────
  CUP 到第 (rows - footerHeight + 1) 行  // 输入框
  eraseLine + 写 ❯ + input
  CUP 到第 (rows - 1) 行  // 下边框（多行输入时循环）
  eraseLine + 写下边框
  CUP 到第 rows 行  // 状态栏
  eraseLine + 写 Act │ model │ dir │ branch │ ░░░ 0%
  CUP 回输入框光标位置
```
每行独立 CUP + eraseLine。不依赖"光标当前在哪"，永远精确出现在最后 footerHeight 行。

## 6. 每帧执行顺序（新 commit）

```ts
private commit(): void {
  // 段 1：消息追加器（只增不减）
  while (this.lastFlushedLine < this.messages.allLines().length) {
    this.writeMsgLine(this.messages.allLines()[this.lastFlushedLine]);
    this.lastFlushedLine++;
  }
  // 段 2：流式重写器（仅当活跃）
  if (this.streamingBlockStartRow !== null) {
    this.rewriteStreamingBlock();
  }
  // 段 3：底部区刷新器（总是执行）
  this.refreshFooter();
  // 光标定位：流式中→当前块末尾（消息区），空闲→输入框光标位置
  const [cursorRow, cursorCol] = this.streamingBlockStartRow !== null
    ? [this.lastFlushedLine, 0]              // 流式：消息区块末尾
    : this.computeInputCursorViewportPos();  // 空闲：底部区输入框（CUP 坐标）
  this.writer(cup(cursorRow, cursorCol));
}
```

对比旧数据流：旧的 `MessageBuffer.allLines() → 整屏 Screen → diff(prev, next) → 碎片化指令`。新的是 `MessageBuffer 增量行 → 直接输出`，跳过了"整屏重建 + diff"这个 bug 之源。

## 7. 与现有代码的映射

### 保留不动（约 70%）
- `MessageFormatter`（ui/message-formatter.ts）— 块→格式化行
- `block-format.ts` — formatToolCallDisplay / summarizeOutput / buildToolResultBlock 等纯函数
- `MessageBuffer`（renderer/message-buffer.ts）— 行存储 + setStreamingRows（角色从"渲染数据源"变为"流式状态记录 + 增量行来源"）
- `VirtualScreen`（renderer/virtual-screen.ts）— lineFeed/eraseLine/writeCell/raw，用于底部区刷新器缓冲
- `cell.ts` / `highlight.ts` / `markdown.ts` — 字符宽度、代码高亮、markdown 渲染
- `ansi.ts` — cup / cursorUp / eraseLine / SGR
- `BlockPipeline`（ui/block-pipeline.ts）— emit 路由 + 块间空行契约 + expandable store
- `UILayout`（ui/ui-layout.ts）— Renderer 的薄包装

### 重写（核心，约 30%）
**唯一重写 `Renderer` 类的 `commit()` + `renderFull()`，并新增流式重写逻辑。**

#### 删除（废弃画布 diff）
- `prevScreen` / `prevHeight` / `prevCursorY` / `prevCursorX` 画布快照机制
- Segment 1（现有行 diff）、Segment 1.5（缩小清理）、Segment 2（增长 LF）、Segment 3（光标恢复）
- `needsFullReset` 触发条件
- `renderFull` 的整屏重建逻辑

#### 新增方法
| 方法 | 职责 |
|------|------|
| `writeMsgLine(line)` | 消息追加器：当前光标处 eraseLine + 写一行，光标 LF 下移 |
| `rewriteStreamingBlock()` | 流式重写器：CUU 回 streamingBlockStartRow，逐行 eraseLine 重写当前块 |
| `refreshFooter()` | 底部区刷新器：CUP 绝对定位重画边框+输入框+状态栏 |

#### 状态简化
| 旧状态（删除） | 新状态（新增） |
|---------------|--------------|
| `prevScreen: Screen` | `lastFlushedLine: number`（追加器"已写到哪里"）|
| `prevHeight / prevCursorY / prevCursorX` | `streamingBlockStartRow: number \| null`（流式块起始行）|
| `frameInterval` 节流（保留） | — |

## 8. 边界与异常处理

### 8.1 resize（终端尺寸变化）
`resize` 时清屏重画（少数允许全屏重置的场景）。消息行从 **MessageBuffer 内存记录**重画（不从 scrollback 读）：
```
resize(rows, cols):
  this.rows = rows; this.cols = cols;
  this.messages.setWrapCols(cols);    // 按新宽度重新折行（MessageBuffer 内部重算）
  this.lastFlushedLine = 0;           // 重置追加器，下一帧从 MessageBuffer 第 0 行重画
  this.streamingBlockStartRow = null;
  writer(\x1b[2J\x1b[H);             // 全清屏（resize 不频繁，闪一次可接受）
  scheduleRender();                   // commit 段1 从 lastFlushedLine=0 重新追加所有消息行（进 scrollback 保留历史）
```

### 8.2 clearMessages（清空对话）
```
clearMessages():
  this.messages.clear();
  this.lastFlushedLine = 0;
  this.streamingBlockStartRow = null;
  writer(\x1b[2J\x1b[H);   // 全清屏
  scheduleRender();         // 只画底部区
```

### 8.3 极端长回复（流式块撑满屏幕）
单个 assistant 块文本极长（如 200 行代码），`streamingBlockStartRow` 已滚进 scrollback：
```
rewriteStreamingBlock():
  const blockLines = msgCursorRow - streamingBlockStartRow;
  if (blockLines >= rows - footerHeight) {
    // 降级：封口已写部分，后续纯追加
    this.streamingBlockStartRow = msgCursorRow;
    // 不退格，直接追加增量行
  } else {
    // 正常：CUU blockLines + eraseLine × blockLines + 重写
  }
```
极长回复后半段变成不可回改的追加流，视觉等价普通顺序输出，用户无感知。

### 8.4 用户打字时的光标
setInput 只改 input 状态 → commit 段 3 重画输入框 + CUP 到输入光标位置。段 1/2 跳过（无新消息、无流式）。

### 8.5 流式中断
流式重写器只管"当前文本是什么"，不关心完整性。中断时块保持半句状态，下次 emit（新一轮）sealStreaming 封口它，进入消息追加器永久记录。无特殊处理。

### 8.6 首帧（enter）
```
enter():
  writer(hideCursor());
  refreshFooter();              // 无消息，只画底部区
  writer(cup(输入框位置));
  writer(showCursor());
```

## 9. 验证策略

### 单元测试（用 FakeTerminal，已验证能模拟 ANSI）
- 消息追加器：连续 push 多块，断言 scrollback 累积正确、可视区显示最新
- 流式重写器：assistant delta 逐字增长，断言当前块行被重写（无残留）、封口后不可变
- 底部区刷新器：消息区满屏后，断言状态栏/输入框始终在最后 footerHeight 行
- **关键回归测试**：满屏后多轮工具调用，断言无内容重复、无坐标脱钩（旧 bug 的复现场景）

### 真实终端验证
- 普通问答（未满屏）：banner + 单轮回复
- 满屏工具调用：多轮 thinking + tool_call + tool_result 交替
- 流式长回复：单块超过一屏
- resize：拖拽窗口
- 打字：满屏后输入

## 10. 不在本设计范围

- 备用屏模式（alt screen）：本设计是主屏方案。若未来需要 alt screen，可作为独立任务。
- 鼠标支持、同步更新（sync output）：不在范围。
- 渲染性能优化（如脏行跟踪）：当前每帧重画底部区，开销可接受；后续可优化。
