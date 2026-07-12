# 输入行折行 border 堆叠 + 光标漂移修复

## 底层逻辑
- 根因：`simulateTerminalWrap` 假设终端折行（DECAWM），算输入行(>cols) physRows>1。但 ConPTY 不折行（node-pty 实测确认：81列全在一行，不折行）。
- 连锁：newHeight 偏大 → cursorUp 偏多 → 光标上移（问题1）+ 每帧漂移 → border 堆叠（问题2）。
- **两个问题是同一个根因的两面**：simulateTerminalWrap 的折行假设在 ConPTY 下不成立。之前反复修复一个就引出另一个，因为没找到共同根因。

## TDD 测试点
- RED：`input-wrap-border-regression.test.ts` 4 测试。输入行超 cols 时光标绝对位置稳定（行5）+ border 数恒为2。
- GREEN：
  1. 截断输入行到 cols（`sliceAnsi(prefix + content, 0, cols)`），与 statusText 同策略。
  2. 截断光标前内容到 cols-promptWidth（`sliceAnsi(beforeCursor, 0, cols - PROMPT.length)`），与显示截断一致。
- 变异验证：
  - 移除输入行截断 → 2 个光标漂移测试变红（`expected 6 to be 5`）
  - 移除光标前内容截断 → 2 个光标漂移测试变红

## 失败原因
- 之前 3+ 次修复循环（cursorUp → CUP → CRLF → writtenLineCount）都在"光标定位公式"层面打转，没发现根因在 simulateTerminalWrap 的折行假设。
- 旧测试盲区：`physical-line-footer-regression.test.ts` 的 statusText 是 `'status'`（短文本无 ANSI），输入行折行测试基于"折行"假设——现在截断后不折行，期望值需更新。

## 验证结果
- 新增测试：4/4 pass（含变异验证）
- L2 inline 目录：30 文件 202 测试全 GREEN（旧测试已更新为截断后期望值）
- tsc --noEmit：干净
- lint：13 个 no-control-regex（12个历史遗留 + 1个新增已 disable）
- node-pty 验证：border=4（之前8），hook 消息存在，输入85a 后 footer 正常截断显示
- dist 编译成功，待用户真实终端实测
