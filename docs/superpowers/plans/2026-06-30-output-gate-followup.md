# OutputGate 后续改进计划

**Goal:** 完善 OutputGate 系统，集成布局计算、补充测试、性能验证

**Tech Stack:** TypeScript, Vitest

---

## Task 1: 集成 LayoutScheduler 到 OutputGate

**Files:**
- Modify: `src/output/output-gate.ts`
- Modify: `src/__tests__/output/output-gate.test.ts`

**目标：** 将 LayoutScheduler 的布局计算集成到 OutputGate 的 processMessage 方法中

**实现：**
1. 在 OutputGate 中使用 LayoutScheduler 计算布局
2. 在 processMessage 中应用布局（viewportY、裁剪内容）
3. 添加测试验证布局计算

---

## Task 2: 补充 GBK 测试

**Files:**
- Modify: `src/__tests__/output/encoder.test.ts`

**目标：** 补充 GBK 回退和解码失败的测试用例

**测试用例：**
1. GBK buffer 解码回退
2. 解码失败时的回退行为
3. 混合编码内容处理

---

## Task 3: 性能测试

**Files:**
- Create: `src/__tests__/output/perf.test.ts`

**目标：** 测试 OutputGate 的吞吐量和延迟

**测试指标：**
1. 消息队列吞吐量（messages/second）
2. flush 延迟（ms）
3. 样式对象池命中率
