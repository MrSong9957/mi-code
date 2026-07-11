# Dispatch Map 实现日志

## 底层逻辑
- **物理本质**：餐厅点餐系统
  - `TOOLS` = 菜单（告诉客人有什么菜，每道菜需要什么配料）
  - `TOOL_HANDLERS` = 厨师团队（每位厨师只会做特定的菜）
  - `ToolRegistry` = 服务员（接收订单，分配给正确的厨师）
- **解耦核心**：新增菜式 = 在菜单上加一行 + 招聘一位新厨师，服务员流程完全不变

## TDD 测试点
1. **TOOLS 数组验证**
   - 包含所有核心工具定义
   - 每个工具都有有效的 JSON Schema
   - 工具名称唯一

2. **TOOL_HANDLERS 字典验证**
   - 每个工具都有对应的处理器
   - 没有多余的处理器（与 TOOLS 一致）

3. **validateDispatchMap 一致性检查**
   - 返回空数组表示一致
   - 检测缺失的处理器和缺失的定义

4. **createRegistryFromDispatchMap 功能验证**
   - 创建包含所有工具的注册表
   - 能够执行 read_file、write_file 等工具
   - 对未知工具返回错误

5. **解耦验证**
   - 新增工具只需修改 TOOLS 和 TOOL_HANDLERS
   - 核心循环（agentLoop）完全不用动
   - 工具之间相互隔离

6. **边界值验证**
   - null/undefined 输入处理
   - 缺失必填参数处理
   - 错误类型输入处理
   - 空字符串参数处理

7. **输出截断验证**
   - 超长输出截断（> 50KB）
   - glob/grep 结果截断

8. **并发验证**
   - 并发读取安全性
   - 并发写入安全性

## 失败原因与修复
1. **ESM 导入错误**
   - 原因：使用 `require` 导入 ESM 模块
   - 修复：改为 `await import()` 动态导入

2. **search-tools 导出不匹配**
   - 原因：search-tools.ts 没有导出独立的 `glob` 和 `grep` 函数
   - 修复：使用 `createGlobTool()` 和 `createGrepTool()` 工厂函数

3. **write_file 假测试**
   - 原因：只检查返回消息，不验证文件内容
   - 修复：添加 `readFileSync` 验证文件是否真的被写入

4. **空字符串路径处理**
   - 原因：`read_file` 处理器没有检查空字符串
   - 修复：添加 `input.path.trim() === ''` 检查

## 验证结果
- ✅ 所有 26 个测试通过（包括功能测试、边界值、截断、并发、回归测试）
- ✅ 所有 16 个现有回归测试通过
- ✅ L2 级别测试通过（990 个测试）

## 文件清单
1. `src/agent/dispatch-map.ts` - Dispatch Map 核心实现（含防御性检查和输出截断）
2. `src/__tests__/dispatch-map.test.ts` - 完整测试套件（21 个测试）
3. `logs/dispatch-map-implementation.md` - 本日志文件

## 使用示例

### 新增工具步骤
1. 在 `TOOLS` 数组添加定义：
```typescript
{
  name: 'my_new_tool',
  description: 'Description for LLM',
  parameters: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'Parameter description' },
    },
    required: ['param1'],
  },
}
```

2. 在 `TOOL_HANDLERS` 字典添加处理器：
```typescript
my_new_tool: async (input) => {
  const data = input.param1 as string;
  return `Processed: ${data}`;
},
```

3. 核心循环（agentLoop）完全不用修改！

### 验证一致性
```typescript
import { validateDispatchMap } from './dispatch-map.js';

const { missingHandlers, missingDefinitions } = validateDispatchMap();
if (missingHandlers.length > 0 || missingDefinitions.length > 0) {
  console.error('Dispatch Map 不一致！');
}
```
## 2026-07-12：下拉菜单三件套修复（方向/选择/残留）

### 底层逻辑
- inline 模式下"浮层"= footer + 下拉菜单作为**一个原子块**由 InlineRenderer 用 ANSI 整块覆写。
- Claude Code 用 alt-screen + `<Box position="absolute">`，但本项目生产硬编码 inline，故翻译为 renderer 层原子绘制。
- 三个 bug 共同根因：①键盘 hook 读 React Context（no-op stub）；②下拉行用裸 stdout 写在高度账本外；③ConnectedApp 有死订阅。

### TDD 测试点
- 新增 `use-input-handler-completion.test.tsx`（8 测试）：/触发、↓↑循环、Enter写回、Esc关闭、Backspace关闭、过滤。
- 重写 `inline-dropdown-duplication.test.ts`（6 测试）：向下布局行序、选中反白、8→0零残留、5→8扩展、多次覆写无重复、commitFooter生命周期。
- 重写 `dropdown-inline-render.test.ts`（4 测试）：直接调真实 renderFooter（杜绝假测试）。

### 失败原因
- 首版 cursorUp 公式误用 `footerHeight - 1 - inputLineIndex`（假设光标在底部），实际光标在输入框行。正确公式 `1 + inputLineIndex`（向上跳过 border + 多行前序）。
- `/c` 单次 stdin.write 测试失败：ink-testing-library 每次写入是一次 useInput 调用（非逐字符），改两次 write 模拟真实输入。
- commitFooter 测试首版误断"追加模式无 cursorUp"：光标定位步骤仍写 cursorUp，改为检测追加特征（border+\n）。

### 验证结果
- 反作弊验证通过：故意把 cycle→cyclePrev / 删除 \x1b[8M，测试均正确失败。
- L1：use-input-handler-completion 8/8、inline-dropdown-duplication 6/6、dropdown-inline-render 4/4。
- L2：src/__tests__/tui/ + src/tui/inline/ 全绿（468 测试 / 64 文件）。
- 构建：tsc 零错误，dist/ 含新签名 renderFooter(...suggestions, selectedIndex)。
- 注：PTY E2E 受限于环境无 node-pty，改由 mockStdout 集成测试覆盖渲染器全生命周期。

### 核心改动文件
- src/tui/input/use-input-handler.ts：删除 useDropdown 依赖，改读 completionStore。
- src/tui/inline/InlineRenderer.ts：renderFooter 原子绘制 footer+下拉（向下布局），cursorUp 公式修正。
- src/tui/inline/InlineApp.tsx：删除裸 stdout 下拉块 + prevDropdownRowsRef，改调 renderer。
- src/tui/ConnectedApp.tsx：completionStore 订阅 inline 模式短路（消除死订阅重渲染）。

## 2026-07-12：修复下拉菜单高度收缩时的光标漂移（斜杠重绘 bug）

### 底层逻辑
- 覆写循环写 `max(旧高度, 新高度)` 行带 `\n`，收缩时多余空行把光标推到旧块底之外。
- 删除分支多余的 `cursorUp(1)` 让光标跑到错误位置（行11而非行4）。
- 定位公式 `upFromBottom = footerHeight-1-cursorLineIndex` 假设光标在新块底（行3），
  实际在行11，`cursorUp(3)` 只到行8，光标漂移 7 行。
- 下一帧 `cursorUp(offsetToTop)` 从错误位置开始，footer 在新位置重画，旧位置残留。

### TDD 测试点
- 新增 `dropdown-shrink-cursor-regression.test.ts`（3 测试），复用 CursorTracker。
- 用例1：8候选→0候选，断言光标回输入框行（行1）。
- 用例2：连续 8→0→8 三次循环，累计漂移为 0。
- 用例3：0→8 扩张场景（双向保护）。

### 失败原因
- 首版反作弊（\x1b[0M）测试通过：CursorTracker 不解析 \x1b[M（它只移动光标行号），
  删除行数变化对 tracker.row 无影响。改用 cursorUp(5) 破坏光标定位，测试正确失败。
- 这暴露：光标位置测试与内容残留测试互补——前者测 tracker.row，
  后者（inline-dropdown-duplication）测 mockStdout 字符串残留。两者缺一不可。

### 验证结果
- RED：用例1、2 失败（expected 8 to be 1），用例3 通过（扩张分支恰好不触发 bug）。
- GREEN：修复 2 行后 3/3 通过。
- 反作弊：cursorUp(5) 破坏后 2 测试失败；确认后恢复。
- L2：src/tui/inline/ + src/__tests__/tui/ 全绿（471 测试 / 65 文件）。
- 构建：tsc 零错误。

### 核心改动
- src/tui/inline/InlineRenderer.ts:94-106：
  - 循环上界 max→newHeight（只写新内容，不写多余空行）
  - 删除分支去掉 cursorUp(1)（光标已在新块正下方，直接删）
- src/tui/inline/dropdown-shrink-cursor-regression.test.ts（新建）：3 个回归测试。

## 2026-07-12：下拉菜单窗口居中滚动（对齐 Claude Code 源码）

### 底层逻辑
- 旧 renderer 用 `slice(0, 8)` 焊死首屏，selectedIndex > 7 时选中项不在窗口里。
- `isSelected = i === selectedIndex` 坐标系错位：i 是窗口内相对下标（0~7），
  selectedIndex 是绝对下标（可达 17）。两者永不匹配 → 高亮消失。
- 用户症状：按 ↓ 超过第 8 条后看不到高亮，循环回 0 才重现（"命令没显示完整"）。

### TDD 测试点
- 新增 3 测试到 dropdown-inline-render.test.ts：
  - selectedIndex=9 → 第9条反白可见、第0条滚出窗口
  - selectedIndex=17（末项）→ 末项反白可见
  - 少量候选（3条）不滚动 → 全部可见
- 沿用 mockStdout + expect(output).toContain 模式（复用既有测试风格）。

### 失败原因（反作弊验证）
- 故意改 `startIndex = 0`（还原 bug），2 个滚动测试失败、5 个其他通过。精准捕获。

### 验证结果
- RED：selectedIndex=9/17 测试失败（slice(0,8) 不含第9/17条）。
- GREEN：居中公式后 7/7 通过。
- 反作弊：焊死首屏后 2 测试失败；恢复后全绿。
- L2：src/tui/inline/ + src/__tests__/tui/ 全绿（474 测试 / 65 文件）。
- 构建：tsc 零错误。

### 核心改动
- src/tui/inline/InlineRenderer.ts:59-72：
  - 居中滚动公式 startIndex = max(0, min(selectedIndex - floor(maxVisible/2), length - maxVisible))
    （对齐 Claude Code PromptInputFooterSuggestions.tsx:238）
  - 按值匹配选中 name === suggestions[selectedIndex]（对齐 Claude Code 按ID风格，
    越界健壮——selectedIndex 异常时不会误高亮第一项）
- src/__tests__/tui/dropdown-inline-render.test.ts：+3 窗口滚动测试。

## 2026-07-12：下拉菜单功能加固（5 个回归测试补盲区）

### 底层逻辑
- 功能已实现且正确，本次是"锁定正确行为"型加固——补 5 个真实盲区，
  防止未来重构退化。所有测试 GREEN（代码已对），不是修 bug。

### TDD 测试点（5 个）
1. 反向滚动：↑ 从 index=0 cyclePrev 到末项，末项可见反白、首项滚出窗口。
2. 越界防御：selectedIndex=999 不崩溃、不反白（按值匹配 name===undefined 全 false），
   窗口被公式钳制滚到末尾显示末 8 条。
3. 边界：候选恰好 8 条（length===maxVisible），startIndex 恒 0 不滚动，末项反白。
4. 空数组：renderFooter([], 0) 无候选行、无反白、不崩溃。
5. 剧烈跳变：18→3→18 候选数跳变，footerHeight 在 22↔7 间变化，光标始终回输入框行。

### 失败原因（反作弊验证）
- 故意破坏 startIndex=0（焊死首屏），4 个滚动测试失败（反向/selectedIndex=9/17/越界）。
- 测试 #2 首版断言错误：误以为越界时窗口回首屏，实际公式钳制到末尾。
  修正断言为 toContain(末项) 后通过。这是"先写测试发现假设错误"的正反馈。

### 验证结果
- 加固测试：5/5 GREEN（代码已正确实现，测试锁定行为）。
- 反作弊：破坏居中公式后 4 测试失败，确认测试有效。
- L2：src/tui/inline/ + src/__tests__/tui/ 全绿（479 测试 / 65 文件）。
- 构建：tsc 零错误。

### 覆盖维度总览（加固后）
- store 层：filter/cycle/cyclePrev/hide（dropdown-inline-fix 6 测试）
- 键盘桥：/ ↓ ↑ Enter Esc Backspace（use-input-handler-completion 8 测试）
- renderer 数据流：filter→输出、窗口滚动正/反/边界/越界/空（dropdown-inline-render 11 测试）
- 光标稳定性：8→0→8、4→12 扩张、18→3→18 跳变（dropdown-shrink-cursor 4 测试）
- 原子渲染：零残留、commit 生命周期（inline-dropdown-duplication 6 测试）
