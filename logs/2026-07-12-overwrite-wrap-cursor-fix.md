# 光标漂移根因修复（首字符/每字符输入框上移）

## 底层逻辑
- 物理本质：`simulateTerminalWrap` 逐字符遍历算物理行数，但**不跳过 ANSI 转义序列**。`\x1b` 是零宽（stringWidth=0），但 `[`、`3`、`6`、`m` 各算 1 列 → `\x1b[36m` 被算成 4 列宽度。含颜色的 statusText physRows 虚高 → footerHeight 偏大 → cursorUp 偏移 → 光标漂移。
- node-pty 实测确认：master 的 DL 方案在 ConPTY 下 DL→EL（擦内容不删行）导致 border 堆叠（8个border而非4个）。
- 逐行擦写方案（不用 DL）+ statusText 截断到 cols + simulateTerminalWrap 修复 ANSI 处理 → footerHeight 准确 → 光标不漂移。

## TDD 测试点
- RED：`truncate-status-cursor-regression.test.ts` 5 测试。超宽 statusText（含 ANSI）footerHeight 应=4（截断后不折行），bug 代码下=5。
- GREEN：
  1. `simulateTerminalWrap` 加 ANSI 跳过（CSI `\x1b[...letter` + OSC `\x1b...BEL`）。
  2. `renderFooter` 截断 statusText 到 cols（slice-ansi，保留 ANSI 样式）。只截断 statusText（非用户内容），输入行保留完整（走视口窗口）。
  3. 覆写模式从 DL 改为逐行擦写（`\r\x1b[2K`+content+`\n`）。
- 变异验证：移除 simulateTerminalWrap 的 ANSI 跳过 → "超宽 statusText footerHeight=4" 测试立即失败 → 非假测试。

## 失败原因
- 之前 3+ 次修复循环（cursorUp → CUP → CRLF → writtenLineCount）都在"光标定位公式"层面打转，没发现真正的 bug 在 `simulateTerminalWrap` 的 ANSI 处理。
- 旧测试盲区：`cursor-drift-regression.test.ts` 的 CursorTracker 不模拟终端折行；`physical-line-footer-regression.test.ts` 的 statusText 是 `'status'`（短文本无 ANSI），测不出 ANSI bug。
- node-pty 嵌套 ConPTY 的 cursorUp 不可信（border 堆叠可能是假象），但"hook 消息未被覆盖"是可靠信号。

## 验证结果
- 截断回归测试：6/6 pass（含变异验证）
- overwrite-wrap 回归测试：5/5 pass（含变异验证）
- L2 inline 目录：29 文件 198 测试全 GREEN
- tsc --noEmit：干净
- lint（改动文件）：干净（no-control-regex 已 disable）
- node-pty 验证：hook 消息未被覆盖（之前被覆盖），输入 a/b/c 后输入框位置稳定
- dist 编译成功
- **用户真实终端实测：修复成功**

## 假测试修复（2026-07-12 变异验证发现）

### 假测试：overwrite-wrap-cursor-regression.test.ts
- **根因**：旧版断言"追加后光标行 == 覆写后光标行"（相对漂移=0）。如果 simulateTerminalWrap 算错 physRows，追加和覆写都偏移同样的量，相对漂移仍=0，测试通过。
- **变异证据**：移除 simulateTerminalWrap 的 ANSI 跳过后，旧版 4 个测试全绿（假测试）。
- **修复**：断言光标**绝对位置**（应在输入框行=块顶+1=行5），而非仅比较相对漂移。CJK 测试加 ANSI 颜色码。
- **修复后变异**：移除 ANSI 跳过后 4 个含 ANSI 测试变红（`expected 4 to be 5`）。

### 弱测试：truncate-status 测试3 "稳定性"
- **根因**：断言"三帧 footerHeight 相同"，bug 下三帧都=5也算"相同"。靠 `toBe(4)` 兜底。
- **修复**：每帧都断言 `toBe(4)`，去掉弱稳定性断言。

### 盲区：truncate-status 不测光标位置
- **根因**：变异 8（upFromBottom+1，导致光标漂移）时 5 个测试全绿——只测 footerHeight 值，不测光标。
- **修复**：新增"光标 cursorUp 值正确"测试，直接断言 cursorUp=3（newHeight(4)-cursorPhysLine0(1)）。
- **修复后变异**：upFromBottom+1 后新测试变红。

### 最终变异验证矩阵
| 变异 | 旧版结果 | 修复后结果 |
|------|---------|-----------|
| 移除 ANSI 跳过 | 0 failed（全绿假测试） | **6 failed** ✓ |
| upFromBottom+1 | 0 failed（盲区） | **6 failed** ✓ |
| 移除截断 | 4 failed | **8 failed** ✓ |
