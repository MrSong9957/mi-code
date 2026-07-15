# 流式草稿 Cell Diff 渲染设计

> **状态**：设计已确认，待写实施计划
> **日期**：2026-07-15
> **前置**：inline grid footer 渲染（655854b），emit yBias 支持（033a17c）

## 1. 问题

流式输出闪烁。根因：每帧 delta 用 `cursorUp + \r\x1b[2K`（擦整行再重写整行）更新草稿。
即使只加了一个字，也要擦掉整行重写——终端在"擦→写"间隙闪烁。

## 2. 解决思路

**用 cell diff 替换行级覆写。**

当前流式草稿用 rewriteStreamingLines（行级覆写）：
```
cursorUp(N) → 逐行 \r\x1b[2K（擦整行）→ 重写整行
```

改为 cell diff：
```
DoubleBuffer back ← blitAnsi(新草稿行)
diff(front, back) → 只输出变化的 cell
emit → 绝对坐标写入变化的格子
```

加了一个字只写那一个字的格子，其他不动。零闪烁。

## 3. 决策汇总

| 决策点 | 选择 | 理由 |
|---|---|---|
| grid 范围 | 独立草稿 grid（StreamingGridRenderer） | 草稿和 footer 是两个独立区域，行数变化逻辑不同 |
| 固化衔接 | 草稿转 appendLine | 固化行用 appendLine 写进 stdout 进 scrollback，草稿 grid 清空 |
| 行数变化 | 重建 buffer 保留旧行 | 旧 front 内容拷贝到新 front，新增行全 0，diff 只输出新增+变化的 cell |

## 4. 架构

### 4.1 组件图

```
InlineApp effect
  │
  ├─ 流式时：
  │   ├─ streamingGrid.commitStream(streamingLines, topRow, cols)
  │   │     ├─ 行数变化 → 重建 DoubleBuffer（旧 front 保留）
  │   │     ├─ back.clear() → blitAnsi(草稿行)
  │   │     ├─ diff(front, back) → cell 级 Patch[]
  │   │     └─ emit（yBias = topRow - 1）
  │   └─ footerGrid.commitFooter（diff 为空，零写入）
  │
  ├─ 固化时：
  │   ├─ streamingGrid.clear()（草稿区清空 + emit 空格）
  │   ├─ appendLine(固化行)（写进 stdout 进 scrollback）
  │   └─ footerGrid.commitFooter（正常）
  │
  └─ 非流式（纯输入/spinner）：
      └─ footerGrid.commitFooter（正常）
```

### 4.2 新建组件

#### `StreamingGridRenderer`（`src/tui/inline/streaming-grid-renderer.ts`）

持有草稿区域的 DoubleBuffer，提供 commitStream / clear 接口。
复用 `src/render/` 的渲染核心（Screen/DoubleBuffer/diff/optimize/emit/blitAnsi）。

```ts
class StreamingGridRenderer {
  private db: DoubleBuffer | null = null;
  private lastHeight = 0;
  private lastCols = 0;
  private lastTopRow = 0;  // MiMo 审查：内部存储，clear() 不依赖外部传值

  constructor(private stdout: NodeJS.WriteStream) {}

  /** 写入草稿（流式增量核心接口） */
  commitStream(lines: string[], topRow: number, cols: number): void {
    const newHeight = lines.length;
    this.lastTopRow = topRow;
    const sizeChanged = (this.lastHeight !== newHeight || this.lastCols !== cols);

    // 行数或列数变化 → 重建 DoubleBuffer，旧 front 内容保留
    // 关键：buffer 高度取 max(lastHeight, newHeight)——行数缩减时不能缩小 buffer，
    // 否则 diff 看不见被裁掉的旧行 → 屏幕残留（MiMo 审查 Bug 修正）
    const bufferHeight = Math.max(this.lastHeight, newHeight);
    if (!this.db || sizeChanged) {
      const oldFront = this.db?.front ?? null;
      this.db = new DoubleBuffer(bufferHeight, cols);
      if (oldFront) {
        // 拷贝旧行到新 front（min(oldRows, bufferHeight) 行）
        const copyRows = Math.min(oldFront.rows, bufferHeight);
        for (let y = 0; y < copyRows; y++) {
          for (let x = 0; x < Math.min(oldFront.cols, cols); x++) {
            const oldIdx = (y * oldFront.cols + x) * 2;
            const newIdx = (y * cols + x) * 2;
            this.db.front.chars[newIdx] = oldFront.chars[oldIdx]!;
            this.db.front.chars[newIdx + 1] = oldFront.chars[oldIdx + 1]!;
          }
        }
      }
    }

    // back.clear() → blitAnsi 写入每行草稿内容
    this.db.back.clear();
    for (let y = 0; y < lines.length; y++) {
      blitAnsi(this.db.back, 0, y, lines[y]!);
    }

    // diff → optimize → emit（yBias = topRow - 1）
    const patches = optimize(diff(this.db.front, this.db.back));
    emit(patches, {
      charPool: this.db.charPool,
      stylePool: this.db.stylePool,
      stdout: this.stdout,
      yBias: topRow - 1,
      // 流式时不定位光标（footer diff 为空，光标位置无关）
    });

    this.db.swap();
    this.lastHeight = newHeight;  // 记实际草稿行数（不是 bufferHeight）
    this.lastCols = cols;
  }

  /** 固化时清空草稿区 + emit 空格（清除屏幕上的草稿） */
  clear(): void {  // MiMo 审查：不传 topRow，用内部 lastTopRow
    if (!this.db || this.lastHeight === 0) return;
    // front 保持（有上一帧内容），back 全空 → diff 输出全部清除 patch
    this.db.back.clear();
    const patches = optimize(diff(this.db.front, this.db.back));
    emit(patches, {
      charPool: this.db.charPool,
      stylePool: this.db.stylePool,
      stdout: this.stdout,
      yBias: this.lastTopRow - 1,  // 用内部存储的 topRow
    });
    // 丢弃 buffer（下次 commitStream 全量重建）
    this.db = null;
    this.lastHeight = 0;
    this.lastCols = 0;
  }
}
```

**注意**：clear 方法的实现需要修正——不能先 front.clear 再 diff（那样 diff 为空）。
正确顺序：front 保持（有上一帧内容），back.clear()（全空），diff(front, back=空) → 所有 cell 变成空 → emit 输出清除 patch。

### 4.3 行数变化时的 front 保留

草稿从 2 行变 5 行：
1. bufferHeight = max(2, 5) = 5，新建 DoubleBuffer(5, cols)
2. 旧 front（2 行）的前 2 行拷贝到新 front
3. 新 front 的后 3 行全 0（空白）
4. back.clear() → blitAnsi 5 行新草稿
5. diff(front[2行旧内容+3行空], back[5行新内容])：
   - 前 2 行：只输出变化的 cell（大部分不变）
   - 后 3 行：全 0 → 有内容，全部输出（追加）
6. emit → 前 2 行增量更新 + 后 3 行追加

**行数减少（5 行 → 2 行，MiMo 审查 Bug 修正）：**
1. bufferHeight = max(5, 2) = 5，新建 DoubleBuffer(5, cols)——**不缩小 buffer**
2. 旧 front（5 行）全部拷贝到新 front（5 行）
3. back.clear() → blitAnsi 2 行新草稿（第 3-5 行保持空）
4. diff(front[5行], back[2行内容+3行空])：
   - 前 2 行：只输出变化的 cell
   - 后 3 行：front 有旧内容，back 为空 → 输出清除 patch（擦除残留）✅
5. emit → 前 2 行增量 + 后 3 行清除

**列数变化**同理——buffer 列数取 max(lastCols, cols)，blitAnsi 只写新 cols 宽度内容，
多出的列在 back 里为空，diff 输出清除 patch。

### 4.4 不变的部分

- footer 的 gridRenderer 不变（已有 posChanged 检测处理位置变化）
- wrapStreamingText / wrapThinkingText 不变
- pipeline-adapter / messages-store 不变
- emit.ts / optimize.ts / blitAnsi 不变
- 固化后的 appendLine 路径不变
- **diff.ts 不改**（要求 front/back 尺寸相同——通过 buffer 高度取 max 保证）

## 5. 固化时序（MiMo 审查建议）

```
固化时（justFinalized）:
  1. streamingGrid.clear(topRow) + emit → 草稿区 cell 全部写空
  2. appendLine(固化行) → 写固化内容到同一位置
  3. footerGrid.commitFooter → footer 正常
  全部在一次 flush 里完成
```

**顺序关键**：必须先 clear 再 appendLine。clear 把草稿区清空，appendLine 紧接着写固化内容。
同一次 flush（Node.js stdout.write 同步），终端按字节顺序处理——用户感知不到中间的空白。

## 6. footer 位置漂移

草稿行数变化时 footer 的 topRow 变了。gridRenderer.commitFooter 已有 posChanged 检测
（grid-renderer.ts:45-56）：位置变化时 clearRegion 清旧位置 + front.clear() 强制全量重画。
此机制已验证有效（footer grid 渲染时确认），不需要额外修改。

## 7. InlineApp 改动

InlineApp effect 的流式分支改为：
```ts
if (streamingLines !== null) {
  // 流式：草稿用 cell diff，footer diff 为空
  const streamTopRow = totalContentRowsRef.current + 1;
  streamingGrid.commitStream(streamingLines, streamTopRow, cols);
  // footer 不动（gridRenderer diff 为空）
  // footerTopRow 会因草稿行数变化而变 → gridRenderer 的 posChanged 处理
  const footerTopRow = streamTopRow + streamingLines.length;
  gridRenderer.commitFooter(footerLayout, footerTopRow, cols);
} else if (justFinalized) {
  // 固化：先清草稿再 appendLine
  streamingGrid.clear(streamTopRow);
  // appendLine 在 commit 内部
  ...
}
```

不再需要：
- `renderer.state.footerHeight = ...`（旧 writeFooter 同步）
- `renderer.writeFooter(footerLayout)`（旧版 cursorUp 覆写）
- `clearForResize`（流式首帧不再需要——streamingGrid 首帧 db=null 自动全量 diff）

commit() 内部不再需要：
- `rewriteStreamingLines`（被 streamingGrid.commitStream 替代）
- 流式时的 `commitFooter`（footer 由 gridRenderer 管）

## 8. 测试策略

### 8.1 单元测试

**StreamingGridRenderer**：
- commitStream 首次：全量重画（front 全 0）
- commitStream 增量（内容微调）：只输出变化的 cell
- commitStream 行数增加（1→3）：旧行 diff 增量 + 新行追加
- commitStream 行数减少（3→1）：多余行清除
- clear：emit 全空格清除草稿区

### 8.2 集成测试

**流式→固化流程**（mock stdout）：
- 流式 3 帧 delta → 每帧只输出变化的 cell（不含 \r\x1b[2K）
- 固化 → clear + appendLine → 草稿清空 + 固化内容写入
- 断言：流式帧输出不含 `\r\x1b[2K`（整行擦除），只含 `\x1b[row;colH`（cell 定位）

### 8.3 现有测试不破坏

- streaming-delta-rewrite-regression：验证接口适配（可能需改 spy 目标）
- grid-renderer.test.ts：不受影响（footer grid 独立）
- 所有非流式测试不受影响

## 9. 实施阶段（概要）

| 阶段 | 内容 | 风险 |
|---|---|---|
| P1 | StreamingGridRenderer 骨架 + commitStream + 单元测试 | 中（新类，复用渲染核心） |
| P2 | clear 方法 + 测试 | 低 |
| P3 | InlineApp 接入：流式分支切到 streamingGrid | 高（改动主渲染路径） |
| P4 | commit() 清理：移除 rewriteStreamingLines 调用 | 中 |
| P5 | 真实终端验证 | — |

## 10. 不做的事

- 不改 footer 的 gridRenderer（已有 posChanged 处理）
- 不改 wrapStreamingText / wrapThinkingText
- 不改 pipeline-adapter / messages-store
- 不改 emit.ts / diff.ts / optimize.ts（复用）
- 不引入 batching/buffering（方向 A，非本设计目标）
