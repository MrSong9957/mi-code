# OpenAI / Google Provider 图片输入支持设计

## 目标

让 `/image` 命令附加的图片在 **OpenAI** 和 **Google** 两个 provider 下也能成功发送给模型，与已实现的 Anthropic provider 行为对齐。同时在 resume 场景下遇到「图片 data 为空」时，三家 provider 统一抛出清晰的中文错误，而不是把空请求发给 API。

## 背景

当前 `openai-stream-client.ts:244` 与 `google-stream-client.ts:221` 在 `convertMessages` 里写了 `// image block:MVP 跳过`，**静默丢弃** ImageBlock：用户切到 OpenAI 或 Google provider 后用 `/image` 命令，图片直接消失，模型既看不到图也不会报错。只有 Anthropic provider 实现了真正的 vision 映射（`anthropic-stream-client.ts:258-265`）。

此外 `stripImagesForPersistence`（`image-utils.ts:132-141`）在持久化时把图片 `data` 清空成 `''`，只留 `cachePath`。这意味着 resume 一个老会话后，messages 里会带着空 `data` 的 ImageBlock 流入 client；Anthropic client 当前没有防御，会把空 base64 发给 API，OpenAI/Google 补齐后也会复制同样的潜在 bug。AUTO-0028 负责真正的 cachePath 回填，本任务只做防御性 throw。

## 范围

本任务覆盖：

- OpenAI 与 Google 两家 stream client 的 `convertMessages` 新增 image case。
- 抽取三个共享纯函数 helper 到 `image-utils.ts`，三家 client 共用。
- 三家 client 在空 data 场景下统一 throw 中文错误（含 Anthropic，补齐其既有漏洞）。
- helper 单元测试 + OpenAI/Google client 的 mock SDK 集成测试。

## 非目标

- **不修改 Anthropic client 的 image 格式逻辑**：仅补一行 `ensureImageData` 防御，不改它已正确的 `source.base64` 映射。
- **不实现 AUTO-0028 的 resume 回填**：本任务只让损坏链路「快速失败、清晰报错」，真正的回填交给 AUTO-0028。
- **不实现 AUTO-0027 的拖拽 / 粘贴捕获**。
- **不做 vision-capable model 自动检测**：默认 `gpt-4o` / `gemini-2.5-flash` 都已支持 vision。
- **不改 `StreamingLLMClient` 接口签名**：`convertMessages` 仍是各家 private。
- **不补 Anthropic stream client 的测试文件**：本次测试范围限定 OpenAI/Google + helper。

## 方案

client 内联 image case + 抽取共享 helper。理由：

- **简单可靠**：helper 是纯函数，无 IO/网络，极易测、易理解。
- **优先复用**：`ensureImageData` 是 AUTO-0028 的天然前置依赖，抽出来正好。
- **Core Anchor Function**：`buildOpenAIImagePart` / `buildGeminiInlineData` 是输入输出明确的锚点函数，适合作为 TDD 入口。
- **测试分层清晰**：helper 走单元测试，client 走 mock SDK 集成测试。

放弃的方案：

- B（每家 client 内联完整逻辑、helper 不抽）：三家重复空 data 检查，无法给 AUTO-0028 复用。
- C（修改 `StreamingLLMClient` 接口加 `convertImage`）：接口本来只管 `stream()`，扩展成管消息格式属于过度设计。

## 共享 Helper

三个纯函数全部加到 `src/agent/image-utils.ts`，无外部依赖。

### `ensureImageData(block: ImageBlock): string`

- **职责**：返回可用的 base64 data，或在空 data 时 throw 中文错误。
- **输入**：`ImageBlock`（可能 `data === ''`）。
- **输出**：非空 base64 字符串。
- **错误路径**：`block.data` 为空时 throw：

  ```
  图片数据缺失，无法发送。
  原因：会话恢复后图片未从缓存回填（等待 AUTO-0028 实现）。
  缓存路径：${block.cachePath ?? '(未记录)'}
  建议：重新发送 /image 命令附加图片。
  ```

- **复用性**：AUTO-0028 会把 throw 路径改成「从 cachePath 读取并回填 data」。
- **三家共用**：Anthropic / OpenAI / Google 三家 image case 第一行都调用此函数。

### `buildOpenAIImagePart(block: ImageBlock): OpenAIImagePart`

- **职责**：构造 OpenAI vision 的多部分 content 元素。
- **输出**：新增类型 `OpenAIImagePart`（加到 `types.ts`）：

  ```ts
  export interface OpenAIImagePart {
    type: 'image_url';
    image_url: { url: string }; // data URL
  }
  ```

- **实现**：

  ```ts
  {
    type: 'image_url',
    image_url: { url: `data:${block.mediaType};base64,${ensureImageData(block)}` }
  }
  ```

- **关键**：OpenAI vision 的 `image_url.url` 必须是 data URL（或 http URL），而我们存的 `data` 是纯 base64，因此 **必须** 拼 `data:<media>;base64,<data>` 前缀。

### `buildGeminiInlineData(block: ImageBlock): GeminiInlineData`

- **职责**：构造 Gemini 的 inlineData part。
- **输出**：新增类型 `GeminiInlineData`（加到 `types.ts`）：

  ```ts
  export interface GeminiInlineData {
    inlineData: { mimeType: ImageMediaType; data: string };
  }
  ```

- **实现**：`{ inlineData: { mimeType: block.mediaType, data: ensureImageData(block) } }`
- **关键**：Gemini `inlineData.data` 就是 **纯 base64**，**不拼前缀**。

## 类型新增（`src/agent/types.ts`）

- `OpenAIImagePart` 接口（字段如上）。
- `GeminiInlineData` 接口（字段如上）。

两者仅用于 stream client 内部的转换结果表达，不进入 `ContentBlock` 联合（`ContentBlock` 仍只含内部表示，不掺入 provider 特定格式）。

## 数据流

### 正常路径（用户发图）

```
用户输入 /image foo.png 描述
  → image-command.ts: processImageCommand()
    → encodeImageBlock() → ImageBlock { data: '<base64>' }
  → index.ts: 挂到 userMessageForAgent
  → streamingQuery()
    → 按 provider 选 StreamClient
      [OpenAI]    convertMessages → buildOpenAIImagePart → image_url data URL
      [Google]    convertMessages → buildGeminiInlineData → inlineData base64
      [Anthropic] convertMessages → ensureImageData → source.base64（现有格式逻辑 + 新增守卫）
    → 发起 HTTP 请求
  → 模型返回 vision 响应
```

### 防御路径（resume 后空 data）

```
resume 旧会话 → 加载持久化 messages（stripImagesForPersistence 已把 data 置 ''）
  → streamingQuery()
    → client.convertMessages() → image case
      → ensureImageData(block) 发现 data === ''
      → throw 中文错误（含 cachePath）
    → streamingQuery 捕获并上抛
  → index.ts 显示错误提示给用户
  → 用户重新 /image 发图（临时绕过）
```

### 持久化路径（不变）

`stripImagesForPersistence` 逻辑不动。本任务的 throw 让 strip → resume → 发送 这条损坏链路快速失败，AUTO-0028 负责把它变成真正的回填。

## 底层实现

### OpenAI client（`src/agent/openai-stream-client.ts`）

**改动性质**：结构改动（user message content 从字符串升级为数组）。

**改动点**：

1. `convertMessages`（L216）的循环内新增 image case（L244 附近）：`imageParts.push(buildOpenAIImagePart(block))`。
2. 循环外新增局部变量 `imageParts: OpenAIImagePart[]`，与 `textParts` / `toolCalls` 并列。
3. user 消息组装（L253-256）按三种情况分支：
   - 只有文本：`content: textParts.join('')`（保持原样）。
   - 只有图片：`content: imageParts`。
   - 文本+图片：`content: [{ type:'text', text: textParts.join('') }, ...imageParts]`。
4. assistant 消息不变（assistant 不会发图）。

### Google client（`src/agent/google-stream-client.ts`）

**改动性质**：纯增量（`parts[]` 本就是数组）。

**改动点**：`convertMessages`（L194）循环内新增 image case（L221 附近）：

```ts
} else if (block.type === 'image') {
  parts.push(buildGeminiInlineData(block));
}
```

外层结构完全不变。

### Anthropic client（`src/agent/anthropic-stream-client.ts`）

**改动性质**：补防御，不改格式。

**改动点**：L258-265 的 image case 在构造 `source.data` 前调用 `ensureImageData(block)`，返回值直接作为 `source.data`。既做防御又做取值，格式逻辑不动。

### `image-utils.ts`

- 新增三个 helper。
- 顶部 import 从 `./types` 引入 `OpenAIImagePart` / `GeminiInlineData`。

## 测试

### Helper 单元测试（扩展 `src/__tests__/agent/image-utils.test.ts`）

新增 describe「图片转换 helper」，按 AAA 模式：

| 用例 | Arrange | Act | Assert |
|------|---------|-----|--------|
| `ensureImageData` 正常 | PNG block, `data:'AAA'` | 调用 | 返回 `'AAA'` |
| `ensureImageData` 空 data 有 cachePath | `data:''`, `cachePath:'/x.png'` | 调用 | throw，消息含 cachePath 与「AUTO-0028」 |
| `ensureImageData` 空 data 无 cachePath | `data:''`, 无 cachePath | 调用 | throw，消息含「未记录」 |
| `buildOpenAIImagePart` 四种 mediaType | PNG/JPEG/GIF/WebP block | 调用 | `image_url.url === 'data:<media>;base64,AAA'` |
| `buildGeminiInlineData` 四种 mediaType | 同上 | 调用 | `mimeType` 正确，`data` 为纯 base64（无前缀） |
| `buildGeminiInlineData` 空 data | `data:''` | 调用 | throw（由 `ensureImageData` 抛） |

### OpenAI client 集成测试（扩展 `src/__tests__/agent/openai-stream-client.test.ts`）

新增 describe「图片输入」，沿用现有 `clientOverride` mock 模式：

- **Arrange**：mock SDK 返回固定文本响应；`MESSAGES = [{ role:'user', content:[ {type:'image', mediaType:'image/png', data:'AAA'}, {type:'text', text:'describe'} ] }]`。
- **Act**：调用 `client.stream(MESSAGES, TOOLS, OPTIONS)`，收集事件。
- **Assert**：
  1. 不 throw。
  2. 传给 mock `chat.completions.create` 的 messages 里，user 消息 content 为数组，含 `image_url` part，URL 为 `data:image/png;base64,AAA`。
  3. 文本部分保留（`{type:'text', text:'describe'}`）。
  4. 仅图片无文本时 content 是纯数组（无 text part）。

### Google client 集成测试（扩展 `src/__tests__/agent/google-stream-client.test.ts`）

新增 describe「图片输入」：

- **Arrange**：同上 mock 模式，Google 用 `clientOverride.models.generateContentStream`。
- **Act**：同上。
- **Assert**：传给 mock 的 `contents` 里 user 的 `parts` 含 `{ inlineData:{ mimeType:'image/png', data:'AAA' } }`，text part 保留。

### 空 data 防御回归测试

验证三家 client 在收到空 data ImageBlock 时都 throw 中文错误（防御一致性）。统一放在 `image-utils.test.ts` 的「图片转换 helper」describe 内（因为防御点在 `ensureImageData`，三家共用同一个 helper，不需要跨文件）。构造空 data block 后调用 `ensureImageData` 断言 throw 即可；OpenAI/Google client 的集成测试不需要重复此用例（helper 层已覆盖）。

### 不新增的测试

- ❌ 不为 `convertMessages` 私有方法单独 export 测试（通过 `stream()` 公开路径覆盖）。
- ❌ 不测 Anthropic client（本任务范围外）。
- ❌ 不测 vision model 检测（未实现该功能）。
- ❌ 不为追求覆盖率增加低价值测试。

## 完成定义（DoD）

1. OpenAI / Google client 收到带图片的 messages 时正确转换（通过 mock SDK 集成测试）。
2. 三家 client 收到空 data ImageBlock 时统一 throw 中文错误（防御测试）。
3. helper 单元测试全过。
4. `npx vitest run src/agent/` 全过。
5. `tsc --noEmit` exit 0。
6. lint 通过，无 unused / floating promise。
7. 两处 `// image block:MVP 跳过` 注释（OpenAI L244、Google L221）已替换为真实实现；Anthropic client 已补 `ensureImageData` 防御。

## 关联任务

- **父任务**：AUTO-0001（图片输入支持）。
- **姊妹任务**：AUTO-0027（拖拽 / 粘贴捕获）、AUTO-0028（resume 回填，会消费 `ensureImageData`）。
- **本任务 ID**：AUTO-0026。
