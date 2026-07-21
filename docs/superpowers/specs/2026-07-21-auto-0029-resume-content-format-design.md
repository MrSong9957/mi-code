# AUTO-0029 Resume 消息内容格式化 设计 + 实施计划

> 本任务规模小,brainstorming 结论 + spec + plan 合并到一份文档,精简流程。

## 任务

**格式化** resume 时加载的 user 消息 content,**达成** 在 TUI 消息区回显成人类可读文本(替换当前 `(结构化内容)` 占位符)。

## 背景

AUTO-0028 实测发现:`src/index.ts:889-891` 的 resume 回显逻辑把数组 content 直接渲染成 `(结构化内容)`。用户 resume 历史会话后,看不到自己当初发了什么图、什么文本,体验割裂。AUTO-0028 只负责 data 回填(模型侧),本任务负责显示回填(用户侧),让 AUTO-0028 的成果对用户可见。

```ts
// 现状 src/index.ts:889-891
if (m.role === 'user') {
  const text = typeof m.content === 'string' ? m.content : '(结构化内容)';
  pipeline.emit({ kind: 'user_input', text });
}
```

## 范围

**做**:
- 新建 `src/utils/format-content.ts`,导出纯函数 `formatUserContentForResume`
- 新建 `src/utils/format-content.test.ts`,5 条单测覆盖所有分支
- 修改 `src/index.ts:889-891`,调用新函数替换三元表达式
- 更新 `to-do-list.md`:新增 AUTO-0029 条目 + 完成后标记 `[x]` + 日志

**不做(YAGNI / 范围外)**:
- ❌ 路径截断(实测后如果难看再加 `...`)
- ❌ 重建 image 编号(不与首次发图的 `[Image #N]` 对齐,信息量够即可)
- ❌ 多行渲染(保持单行,与现有 user_input 一致)
- ❌ assistant 消息的格式化(现有 `:893-905` 逻辑保留,虽然简陋但不破)
- ❌ 改 `image-utils.ts`、三家 client、`image-command.ts`、类型定义

## 方案

### image 占位符:C 方案

| block.type | 显示 |
|---|---|
| `text` | `block.text` 原文 |
| `image` + 有 cachePath | `[图片 <cachePath>]` |
| `image` + 无 cachePath | `[图片]`(防御,理论不发生) |
| `tool_use` | `[工具调用]` |
| `tool_result` | `[工具结果]` |
| default(理论不可达) | 空串 |

**拼接规则**:非空片段用空格连接。

**长路径 trade-off**:cachePath 可能 50+ 字符(如 `/home/user/.micode/image-cache/sess-abc123/1.png`),完整显示可能让 resume 回显行较宽。**当前接受**,实测后如果视觉难看再加 `...` 截断,不预先优化。

### 文件位置

`src/utils/format-content.ts`——抽成独立文件便于 TDD,而不是内联在 `index.ts`。

### 改造后代码骨架

```ts
// src/utils/format-content.ts
import type { ContentBlock } from '../agent/types.js';

/**
 * 格式化 user 消息的 content 用于 resume 回显。
 *
 * 字符串透传;数组按 block.type 分支转人类可读片段,空格连接。
 * 本函数只管「显示」,不管发送给模型的真实数据——后者由 streamingQuery 处理。
 */
export function formatUserContentForResume(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map(block => {
      switch (block.type) {
        case 'text': return block.text;
        case 'image': return block.cachePath ? `[图片 ${block.cachePath}]` : '[图片]';
        case 'tool_use': return '[工具调用]';
        case 'tool_result': return '[工具结果]';
        default: return '';
      }
    })
    .filter(s => s.length > 0)
    .join(' ');
}
```

```ts
// src/index.ts:889-891 改造后
if (m.role === 'user') {
  const text = formatUserContentForResume(m.content);
  pipeline.emit({ kind: 'user_input', text });
}
```

## 测试策略

### 5 条单测

| # | 场景 | 输入 | 期望 |
|---|---|---|---|
| 1 | 字符串透传 | `'hello'` | `'hello'` |
| 2 | 纯 text block | `[{type:'text', text:'hi'}]` | `'hi'` |
| 3 | text + image(有 cachePath) | `[{type:'text',text:'这是什么'},{type:'image',mediaType:'image/png',data:'',cachePath:'/x/1.png'}]` | `'这是什么 [图片 /x/1.png]'` |
| 4 | image 无 cachePath(防御) | `[{type:'image',mediaType:'image/png',data:''}]` | `'[图片]'` |
| 5 | 空数组 | `[]` | `''` |
| 6 | tool_use + tool_result 混合 | `[{type:'tool_use',id:'x',name:'f',input:{}},{type:'tool_result',tool_use_id:'x',content:'r'}]` | `'[工具调用] [工具结果]'` |

(实际 6 条,plan 写 5 条是粗估,加一条 tool 混合覆盖)

### TDD 红灯顺序

1. 写测试(全部 RED:函数不存在)
2. 创建 `format-content.ts` 最小实现 → GREEN
3. 改 `index.ts:889-891` 接入
4. 手动实测 resume 回显效果

### 防空跑

- 测试 3 必须断言**精确字符串**(含 `[图片 /x/1.png]` 子串),防止实现硬编码 `[图片]`
- 测试 5 空数组 → 空串,防止实现返回 `undefined` 或抛错
- 测试 4 无 cachePath 分支独立覆盖,防止实现假设 cachePath 永远存在

## 任务分解(单 task,精简 subagent-driven)

### Step 1:写测试(RED)

新建 `src/utils/format-content.test.ts`,写 6 条单测。

验证:`npx vitest run src/utils/format-content.test.ts` → 全失败(函数不存在)

### Step 2:实现(GREEN)

新建 `src/utils/format-content.ts`,按方案骨架实现。

验证:同上 → 6 条全过

### Step 3:接入 index.ts

修改 `src/index.ts:889-891`:
- import 新函数
- 替换三元表达式

验证:
- `npx vitest run src/__tests__/` 无回归(主要看 index.ts 相关测试,虽然可能没有直接测这段)
- `npx tsc --noEmit` exit 0

### Step 4:Commit

```
feat(resume): AUTO-0029 format user content for resume display

src/utils/format-content.ts 新增纯函数,把数组 content 转 human-readable:
- text 原文
- image → [图片 <cachePath>] 或 [图片](无 cachePath 防御)
- tool_use / tool_result → [工具调用] / [工具结果]

替换 src/index.ts:889-891 的 '(结构化内容)' 占位符。
解决 AUTO-0028 实测暴露的 resume 回显缺口。
```

### Step 5:更新 to-do-list

- 「待办」分区新增条目(初始化时即标记为 doing,因为本 task 一步到位)
- 完成后立即移到「已完成」分区 + 标记 `[x]`
- 日志追加一行

### Step 6:Commit

```
docs(todo): mark AUTO-0029 done — resume content formatting
```

### Step 7:手动实测

用户跑 `node dist/index.js --continue`,验证历史带图消息回显成 `这是什么 [图片 /home/.../.micode/image-cache/<sid>/1.png]` 而非 `(结构化内容)`。

## 验收

- [ ] `src/utils/format-content.ts` 实现 + 6 条单测全过
- [ ] `src/index.ts:889-891` 接入新函数
- [ ] `npx tsc --noEmit` exit 0
- [ ] 全量 `npm test` 不回归(StatusBar 2 条既有失败按设计豁免)
- [ ] `to-do-list.md` 新增 AUTO-0029 条目 + 标记完成 + 日志
- [ ] 手动实测 resume 回显正常
