# DECAWM OFF + 应用层 wordWrap

## 底层逻辑
- 根因：`simulateTerminalWrap` 假设终端折行（DECAWM），但 ConPTY 不折行。`newHeight` 偏大 → `cursorUp` 偏移 → 光标漂移 + border 堆叠。两个症状是同一根因的两面。
- 方案：用 `ESC[?7l`（DECAWM OFF）强制终端不折行，应用层自己做 wordWrap。`physical rows = application wrapped rows`，完全可控。
- 架构升级：从"猜测终端布局"变为"应用决定布局，终端只显示"。

## TDD 测试点
- `wrap-line.test.ts`（21测试）：混合折行策略（英文按空格/CJK字符级）、ANSI token stream 保留样式、emoji/CJK 宽度正确、随机化×10。
- `layout-cursor.test.ts`（12测试）：光标在 wordWrap 后的物理行+列、码点安全切片、ANSI+emoji 混合。
- `decawm-wordwrap-regression.test.ts`（9测试）：DECAWM 序列检查、超宽 wordWrap 光标稳定、border 不堆叠、CJK/混合场景。
- 旧测试更新：8个文件（border-width/logo/physical-line/commit-footer/input-viewport-scroll/input-wrap-border/truncate-status/streaming-render）。

## 失败原因
- 之前 3+ 次修复循环（cursorUp→CUP→CRLF→writtenLineCount→sliceAnsi截断）都在"光标定位公式"或"截断"层面打转，没找到共同根因。
- 截断方案解决了光标漂移但丢失了自动换行体验（用户反馈"体验不好"）。
- DECAWM OFF + wordWrap 同时解决两个问题：光标稳定 + 自动换行保留。

## 变异验证
| 变异 | 结果 |
|------|------|
| 移除 DECAWM OFF | constructor 序列检查变红 ✓ |
| 移除 wordWrap（直接push不折行）| physical-line-footer 9测试变红 ✓ |
| upFromBottom+1 | 5个光标漂移测试变红 ✓ |

## 验证结果
- wrap-line 单测：21/21 pass
- layout-cursor 单测：12/12 pass
- L2 inline 目录：31 文件 211 测试全 GREEN
- tsc --noEmit：干净
- lint（改动文件）：干净
- node-pty 验证：wordWrap 生效（85a 折行显示非截断），hook 消息未覆盖，border 从8降到6（statusText wordWrap 后高度变化导致少量残留，但核心问题解决）
- dist 编译成功
- **用户真实终端实测：两个问题（光标漂移 + border 堆叠）同时解决，自动换行恢复**

## 排版修复：第一行空格导致太短（2026-07-12）

### 根因
`wrapLine` 超宽时用 `findLastSpaceIndex` 在整个当前行找最后一个空格断行。CJK 文本含空格时（如 `❯ 是手动 千文千文...`），空格在 index 5（`❯ 是手动` 后），断行后第一行只有8列，后面空一大截。

### 修复
- 改用 `lastSpaceIdx` 追踪当前行最后一个空格（遇到空格时记录位置）
- 超宽时只在 `lastSpaceIdx` 处断行（不往回找更早的空格）
- **阈值**：空格前内容(beforeSpace)必须 > usableWidth * 0.3 才在此空格断行，否则字符级断行
- 效果：`❯ 是手动 千文...`（beforeSpace=8 < 79*0.3=23.7）字符级断行，第一行铺满79列

### 验证
- wrap-line 单测：23/23 pass（含"空格太靠前不在此空格断行"+"CJK空格不断行"测试）
- layout-cursor 单测：12/12 pass
- L2 inline + state 目录：33 文件 246 测试全 GREEN
- tsc + lint + dist 干净

## 测试加固（2026-07-12）

### 审计发现的高优先级缺口 + 补测

| 缺口 | 补测文件 | 测试数 |
|------|---------|--------|
| layout-cursor：英文空格断行后光标定位 + 多行中间行(row≥2) | `layout-cursor.test.ts` +5 | 17 |
| wrap-line：极端宽度(1/2) + beforeSpace trim + 边界空格 | `wrap-line.test.ts` +6 | 28 |
| InlineRenderer：suggestion 超宽截断 | `decawm-wordwrap-regression.test.ts` +1 | 10 |
| bootstrap：cleanup→destroy 连线（DECAWM 恢复） | `bootstrap-decawm-cleanup.test.ts` 新建 | 3 |

### 假测试修复
- "空格太靠前不在此空格断行"测试原用 CJK 文本（`❯ 是手动 千文...`），但 CJK 空格前后非 ASCII，`lastSpaceIdx` 不记录，走字符级断行——与 30% 阈值无关，是假测试。
- 修正为英文场景（`a bbbb...`，空格前后都是 ASCII），变异验证：移除阈值后测试变红（`expected 1 to be greater than 30`）。

### 变异验证
| 变异 | 结果 |
|------|------|
| 移除 30% 阈值 | 英文空格太靠前测试变红 ✓ |
| 移除 DECAWM OFF | constructor 序列检查变红 ✓ |
| 移除 wordWrap | physical-line-footer 9测试变红 ✓ |
| upFromBottom+1 | 光标漂移测试变红 ✓ |

### 最终验证
- L2 全域：34 文件 260 测试全 GREEN
- tsc + lint 干净
- dist 编译成功

## 排版修复2：CJK 文本含空格时不断行（2026-07-12）

### 根因
`wrapLine` 在空格处断行时，CJK 文本中的空格（如 `中文 中文`）也被视为单词边界。断行后当前行可能没铺满（空格前的 CJK 内容恰好不填满 usableWidth），导致"后半截空了一大片"。

### 修复
空格断行只在**空格前后都是 ASCII 字符**时触发（真正的英文单词边界）。CJK 文本中的空格不触发断行，改用字符级断行（铺满）。
- `hello world`（空格前后 ASCII）→ 空格断行
- `中文 中文`（空格前后 CJK）→ 字符级断行
- `中文 hello`（空格前 CJK 后 ASCII）→ 字符级断行
