# OpenAI / Google Provider 图片输入支持 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/image` 命令在 OpenAI 与 Google 两个 provider 下也能成功发送图片,与 Anthropic 行为对齐;并在 resume 会话空 data 场景下三家统一抛中文错误。

**Architecture:** 抽取 3 个共享纯函数 helper(`ensureImageData` / `buildOpenAIImagePart` / `buildGeminiInlineData`)到 `image-utils.ts`,三家 client 在各自 `convertMessages` 的 image case 内调用 helper。helper 先校验 mediaType、再校验非空 data,空 data 时抛中文错误(给 AUTO-0028 留回填接口)。

**Tech Stack:** TypeScript(strict,ESM),`@google/genai`(Google SDK),`openai`(OpenAI SDK),`@anthropic-ai/sdk`,vitest 测试框架。

**Spec:** `docs/superpowers/specs/2026-07-21-openai-google-image-support-design.md`

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/image-utils.ts` | 修改 | 新增 3 个 helper + 2 个类型 export |
| `src/agent/types.ts` | **不改** | (审核反馈后类型已移到 image-utils.ts) |
| `src/agent/anthropic-stream-client.ts` | 修改 | L258-265 image case 补 `ensureImageData` 防御 |
| `src/agent/openai-stream-client.ts` | 修改 | convertMessages 加 image case + 修正 user 消息组装四分支 |
| `src/agent/google-stream-client.ts` | 修改 | convertMessages 加 image case(push inlineData 到 parts) |
| `src/__tests__/agent/image-utils.test.ts` | 修改 | 扩展「图片转换 helper」describe |
| `src/__tests__/agent/openai-stream-client.test.ts` | 修改 | 新增「图片输入」describe + 改造 mock 捕获 params |
| `src/__tests__/agent/google-stream-client.test.ts` | 修改 | 新增「图片输入」describe + 改造 mock 捕获 params |

---

## Task 1:新增 helper 类型与 `ensureImageData`(TDD)

**Files:**
- Modify: `src/agent/image-utils.ts`(末尾追加)
- Test: `src/__tests__/agent/image-utils.test.ts`

### - [ ] Step 1:写失败测试 — mediaType 校验

在 `src/__tests__/agent/image-utils.test.ts` **末尾**追加:

```ts
// ─────────────── 图片转换 helper ───────────────

import { ensureImageData, buildOpenAIImagePart, buildGeminiInlineData } from '../../agent/image-utils.js';
import type { ImageBlock } from '../../agent/types.js';

function makeImageBlock(overrides: Partial<ImageBlock> = {}): ImageBlock {
  return {
    type: 'image',
    mediaType: 'image/png',
    data: 'AAA',
    ...overrides,
  };
}

describe('图片转换 helper — ensureImageData', () => {
  it('正常 data 返回原值', () => {
    const block = makeImageBlock({ data: 'AAA' });
    expect(ensureImageData(block)).toBe('AAA');
  });

  it('非法 mediaType 抛中文错误', () => {
    const block = makeImageBlock({ mediaType: 'image/svg+xml' as any });
    expect(() => ensureImageData(block)).toThrowError(/不支持的图片类型/);
    expect(() => ensureImageData(block)).toThrowError(/image\/svg\+xml/);
    expect(() => ensureImageData(block)).toThrowError(/image\/png/);
  });

  it('空 data 有 cachePath 抛中文错误(含 cachePath 与 AUTO-0028)', () => {
    const block = makeImageBlock({ data: '', cachePath: '/tmp/x.png' });
    expect(() => ensureImageData(block)).toThrowError(/图片数据缺失/);
    expect(() => ensureImageData(block)).toThrowError(/AUTO-0028/);
    expect(() => ensureImageData(block)).toThrowError(/\/tmp\/x\.png/);
  });

  it('空 data 无 cachePath 抛中文错误(含「未记录」)', () => {
    const block = makeImageBlock({ data: '' });
    expect(() => ensureImageData(block)).toThrowError(/未记录/);
  });

  it('先校验 mediaType 再校验 data(非法 mediaType 即使 data 空也优先报 mediaType 错误)', () => {
    const block = makeImageBlock({ mediaType: 'image/tiff' as any, data: '' });
    expect(() => ensureImageData(block)).toThrowError(/不支持的图片类型/);
    // 不应包含「图片数据缺失」
    expect(() => ensureImageData(block)).not.toThrowError(/图片数据缺失/);
  });
});
```

### - [ ] Step 2:运行测试,确认失败

```bash
npx vitest run src/__tests__/agent/image-utils.test.ts
```
Expected: FAIL,提示 `ensureImageData` / `buildOpenAIImagePart` / `buildGeminiInlineData` 未导出(import 失败)。

### - [ ] Step 3:实现类型与 `ensureImageData`

在 `src/agent/image-utils.ts` **末尾**追加。先读现有 import,确认顶部是否已有 `import type { ImageBlock, ImageMediaType, ... } from './types.js'`(应该有)。

追加内容:

```ts
// ─────────────── 图片转换 helper(三家 client 共用) ───────────────

/** OpenAI vision API 的 image_url part 结构。*/
export interface OpenAIImagePart {
  type: 'image_url';
  image_url: { url: string }; // data URL(data:<media>;base64,<data>)
  // 可选字段 detail?: 'low' | 'high' | 'auto' 控制解析精度与 token 消耗,
  // 默认 'auto'。当前不设置,保留扩展空间。
}

/** Google Gemini API 的 inlineData part 结构。*/
export interface GeminiInlineData {
  inlineData: { mimeType: ImageMediaType; data: string };
}

/** 合法的 mediaType 集合(与 types.ts ImageMediaType 一致)。*/
const SUPPORTED_MEDIA_TYPES: ReadonlySet<ImageMediaType> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * 返回可用的 base64 data。
 * 先校验 mediaType 合法性(防御 cast 绕过类型),再校验 data 非空。
 * 空 data 时抛中文错误——AUTO-0028 会把此路径改为「从 cachePath 回填」。
 */
export function ensureImageData(block: ImageBlock): string {
  if (!SUPPORTED_MEDIA_TYPES.has(block.mediaType)) {
    throw new Error(
      `不支持的图片类型:${block.mediaType}\n` +
        `支持的类型:image/png、image/jpeg、image/gif、image/webp`,
    );
  }
  if (!block.data) {
    throw new Error(
      `图片数据缺失,无法发送。\n` +
        `原因:会话恢复后图片未从缓存回填(等待 AUTO-0028 实现)。\n` +
        `缓存路径:${block.cachePath ?? '(未记录)'}\n` +
        `建议:重新发送 /image 命令附加图片。`,
    );
  }
  return block.data;
}
```

### - [ ] Step 4:运行测试,确认通过

```bash
npx vitest run src/__tests__/agent/image-utils.test.ts
```
Expected: 5 个新测试全过 + 原有测试不回归。

### - [ ] Step 5:提交

```bash
git add src/agent/image-utils.ts src/__tests__/agent/image-utils.test.ts
git commit -m "feat(image): add ensureImageData helper with mediaType + empty data validation

- 新增 OpenAIImagePart / GeminiInlineData 类型(provider 特定格式,放 image-utils 而非 types)
- ensureImageData 先校验 mediaType 再校验 data 非空,空 data 抛中文错误给 AUTO-0028 留回填接口

Task 1/N of AUTO-0026."
```

---

## Task 2:`buildOpenAIImagePart` + `buildGeminiInlineData`(TDD)

**Files:**
- Modify: `src/agent/image-utils.ts`
- Test: `src/__tests__/agent/image-utils.test.ts`

### - [ ] Step 1:写失败测试 — 两个 builder

在 `src/__tests__/agent/image-utils.test.ts` 的「图片转换 helper」describe **之后**追加:

```ts
describe('图片转换 helper — buildOpenAIImagePart', () => {
  it('PNG block → image_url data URL', () => {
    const part = buildOpenAIImagePart(makeImageBlock({ mediaType: 'image/png', data: 'AAA' }));
    expect(part.type).toBe('image_url');
    expect(part.image_url.url).toBe('data:image/png;base64,AAA');
  });

  it('JPEG/GIF/WebP 各自的 mediaType 前缀正确', () => {
    for (const mediaType of ['image/jpeg', 'image/gif', 'image/webp'] as const) {
      const part = buildOpenAIImagePart(makeImageBlock({ mediaType, data: 'AAA' }));
      expect(part.image_url.url).toBe(`data:${mediaType};base64,AAA`);
    }
  });

  it('空 data 透传 ensureImageData 错误', () => {
    expect(() => buildOpenAIImagePart(makeImageBlock({ data: '' }))).toThrowError(/图片数据缺失/);
  });

  it('非法 mediaType 透传 ensureImageData 错误', () => {
    expect(() => buildOpenAIImagePart(makeImageBlock({ mediaType: 'image/svg+xml' as any }))).toThrowError(
      /不支持的图片类型/,
    );
  });
});

describe('图片转换 helper — buildGeminiInlineData', () => {
  it('PNG block → inlineData 纯 base64(无前缀)', () => {
    const part = buildGeminiInlineData(makeImageBlock({ mediaType: 'image/png', data: 'AAA' }));
    expect(part.inlineData.mimeType).toBe('image/png');
    expect(part.inlineData.data).toBe('AAA'); // 不含 data: 前缀
  });

  it('JPEG/GIF/WebP 各自的 mimeType 正确', () => {
    for (const mediaType of ['image/jpeg', 'image/gif', 'image/webp'] as const) {
      const part = buildGeminiInlineData(makeImageBlock({ mediaType, data: 'AAA' }));
      expect(part.inlineData.mimeType).toBe(mediaType);
      expect(part.inlineData.data).toBe('AAA');
    }
  });

  it('空 data 透传 ensureImageData 错误', () => {
    expect(() => buildGeminiInlineData(makeImageBlock({ data: '' }))).toThrowError(/图片数据缺失/);
  });
});
```

### - [ ] Step 2:运行测试,确认失败

```bash
npx vitest run src/__tests__/agent/image-utils.test.ts
```
Expected: FAIL,`buildOpenAIImagePart` / `buildGeminiInlineData` 未实现。

### - [ ] Step 3:实现两个 builder

在 `src/agent/image-utils.ts` 的 `ensureImageData` 之后追加:

```ts
/** 构造 OpenAI vision image_url part(含 data URL 前缀)。*/
export function buildOpenAIImagePart(block: ImageBlock): OpenAIImagePart {
  const data = ensureImageData(block);
  return {
    type: 'image_url',
    image_url: { url: `data:${block.mediaType};base64,${data}` },
  };
}

/** 构造 Gemini inlineData part(纯 base64,无前缀)。*/
export function buildGeminiInlineData(block: ImageBlock): GeminiInlineData {
  const data = ensureImageData(block);
  return {
    inlineData: { mimeType: block.mediaType, data },
  };
}
```

### - [ ] Step 4:运行测试,确认通过

```bash
npx vitest run src/__tests__/agent/image-utils.test.ts
```
Expected: 所有 helper 测试全过。

### - [ ] Step 5:类型检查 + lint

```bash
npx tsc --noEmit
```
Expected: exit 0。

### - [ ] Step 6:提交

```bash
git add src/agent/image-utils.ts src/__tests__/agent/image-utils.test.ts
git commit -m "feat(image): add buildOpenAIImagePart / buildGeminiInlineData helpers

- buildOpenAIImagePart 拼 data:image/...;base64,... data URL(OpenAI vision 要求)
- buildGeminiInlineData 直接用纯 base64(Gemini inlineData 要求)
- 覆盖 PNG/JPEG/GIF/WebP 四种 mediaType

Task 2/N of AUTO-0026."
```

---

## Task 3:Anthropic client 补防御(不改格式)

**Files:**
- Modify: `src/agent/anthropic-stream-client.ts`(L258-265)

### - [ ] Step 1:读现状,确认改动点

Read `src/agent/anthropic-stream-client.ts` 找到 `convertMessages` 中 image case(约 L258-265),当前:

```ts
if (block.type === 'image') return {
  type: 'image' as const,
  source: {
    type: 'base64' as const,
    media_type: block.mediaType,
    data: block.data,
  },
};
```

### - [ ] Step 2:写失败测试 — 空 data 防御

在 `src/__tests__/agent/image-utils.test.ts` **末尾**追加(防御点在 helper 层,这里只验证 Anthropic 走 helper):

```ts
// ─────────────── 三家 client 统一防御(helper 层覆盖) ───────────────

describe('图片转换 helper — 三家 client 共享防御', () => {
  // OpenAI / Google / Anthropic 三家都通过 ensureImageData 防御,
  // 因此在 helper 层验证一次即可,client 层不重复。
  it('无论经过哪个 builder,空 data 都抛中文错误', () => {
    const block = makeImageBlock({ data: '', cachePath: '/x.png' });
    // 直接调用 helper
    expect(() => ensureImageData(block)).toThrowError(/AUTO-0028/);
    // 经 OpenAI builder 透传
    expect(() => buildOpenAIImagePart(block)).toThrowError(/AUTO-0028/);
    // 经 Gemini builder 透传
    expect(() => buildGeminiInlineData(block)).toThrowError(/AUTO-0028/);
  });
});
```

### - [ ] Step 3:运行测试,确认通过(此时 helper 已实现)

```bash
npx vitest run src/__tests__/agent/image-utils.test.ts
```
Expected: PASS(因为 builder 已经透传 ensureImageData 错误)。

### - [ ] Step 4:修改 Anthropic client

先确认顶部 import。在 `src/agent/anthropic-stream-client.ts` 顶部找到现有 import 块,新增一行:

```ts
import { ensureImageData } from './image-utils.js';
```

(如果顶部已有 `import type { ... } from './image-utils.js'`,合并;否则新增一行。)

然后把 image case 改为:

```ts
if (block.type === 'image') return {
  type: 'image' as const,
  source: {
    type: 'base64' as const,
    media_type: block.mediaType,
    data: ensureImageData(block),
  },
};
```

### - [ ] Step 5:类型检查 + 全量 image-utils 测试

```bash
npx tsc --noEmit && npx vitest run src/__tests__/agent/
```
Expected: exit 0 + 所有 agent 测试通过。

### - [ ] Step 6:提交

```bash
git add src/agent/anthropic-stream-client.ts src/__tests__/agent/image-utils.test.ts
git commit -m "feat(image): Anthropic client uses ensureImageData for empty data defense

不改 image 格式逻辑(已正确),只补 ensureImageData 守卫,
让 resume 后空 data 抛中文错误而非发空请求被 API 报错。

Task 3/N of AUTO-0026."
```

---

## Task 4:Google client 接入 image case

**Files:**
- Modify: `src/agent/google-stream-client.ts`(L221 附近)
- Test: `src/__tests__/agent/google-stream-client.test.ts`

### - [ ] Step 1:先读 google-stream-client.test.ts 的 mock 模式

Read `src/__tests__/agent/google-stream-client.test.ts` 摸清 `makeMockClient` 的参数签名,看 `clientOverride.models.generateContentStream` 如何接收 `contents` 参数。**这一步只看,不改。**

### - [ ] Step 2:改造 mock 以捕获 `contents` 参数

现有 mock 的 `generateContentStream` 很可能用了 `_params: unknown` 丢弃了参数。在 `makeMockClient` 函数内新增一个 `capturedContents` 数组,把传入的 `contents` 存下来供断言。

具体:读 `src/__tests__/agent/google-stream-client.test.ts` 找到 `makeMockClient`,如果 `generateContentStream` 的参数名是 `_` 或 `_params`,改为:

```ts
function makeMockClient(chunks: MockChunk[]) {
  const captured: Array<{ contents: unknown }> = [];
  const client = {
    models: {
      generateContentStream: async (params: any): Promise<AsyncIterable<MockChunk>> => {
        captured.push({ contents: params.contents });
        return { /* 现有 async iterable 不变 */ };
      },
    },
  };
  // 把 captured 挂到返回值上,供断言使用
  return Object.assign(client, { captured });
}
```

**注意**:`makeMockClient` 返回值类型变了(多了 `captured` 字段),现有测试用 `client as any` 注入,不会 break。但要确认改动后现有 3 个 describe(纯文本/工具/混合)仍然全过。

### - [ ] Step 3:运行现有测试,确认不回归

```bash
npx vitest run src/__tests__/agent/google-stream-client.test.ts
```
Expected: 原有测试全过(不引入回归)。

### - [ ] Step 4:写失败测试 — 图片输入

在 `src/__tests__/agent/google-stream-client.test.ts` **末尾**追加:

```ts
import type { ImageBlock } from '../../agent/types.js';

describe('GoogleStreamClient — 图片输入', () => {
  it('ImageBlock → inlineData part(纯 base64)', async () => {
    const chunks: MockChunk[] = [
      { /* 最小合法响应,可复用纯文本用例的 chunks */ },
    ];
    const mockWrapper = makeMockClient(chunks);
    const streamClient = new GoogleStreamClient({ apiKey: 'test', model: 'gemini-2.5-flash' }, mockWrapper as any);

    const imageBlock: ImageBlock = { type: 'image', mediaType: 'image/png', data: 'AAA' };
    const messages: Message[] = [
      { role: 'user', content: [imageBlock, { type: 'text', text: 'describe' }] },
    ];

    await collect(streamClient.stream(messages, TOOLS, OPTIONS));

    // 断言传给 SDK 的 contents 里 user parts 含 inlineData
    expect(mockWrapper.captured.length).toBeGreaterThanOrEqual(1);
    const captured = mockWrapper.captured[0]!.contents as Array<{ role: string; parts: any[] }>;
    const userMsg = captured.find(c => c.role === 'user');
    expect(userMsg).toBeDefined();
    const inlineDataPart = userMsg!.parts.find((p: any) => p.inlineData);
    expect(inlineDataPart).toBeDefined();
    expect(inlineDataPart.inlineData.mimeType).toBe('image/png');
    expect(inlineDataPart.inlineData.data).toBe('AAA'); // 纯 base64,无前缀
    // text part 也保留
    expect(userMsg!.parts.some((p: any) => p.text === 'describe')).toBe(true);
  });
});
```

### - [ ] Step 5:运行测试,确认失败

```bash
npx vitest run src/__tests__/agent/google-stream-client.test.ts
```
Expected: FAIL,断言 `inlineDataPart` 不存在(因为当前 L221 `// image block:MVP 跳过` 丢弃了 image)。

### - [ ] Step 6:实现 Google client image case

在 `src/agent/google-stream-client.ts`:
1. 顶部新增 import:

   ```ts
   import { buildGeminiInlineData } from './image-utils.js';
   ```

2. 在 `convertMessages`(L194)的循环内,L221 `// image block:MVP 跳过` 注释处替换为:

   ```ts
   } else if (block.type === 'image') {
     parts.push(buildGeminiInlineData(block));
   }
   ```

### - [ ] Step 7:运行测试,确认通过

```bash
npx vitest run src/__tests__/agent/google-stream-client.test.ts
```
Expected: 新测试通过 + 原测试不回归。

### - [ ] Step 8:类型检查

```bash
npx tsc --noEmit
```
Expected: exit 0。

### - [ ] Step 9:提交

```bash
git add src/agent/google-stream-client.ts src/__tests__/agent/google-stream-client.test.ts
git commit -m "feat(image): Google provider sends ImageBlock as inlineData (pure base64)

替换 // image block:MVP 跳过 为 buildGeminiInlineData 调用,
Google provider 不再静默丢弃图片。

Task 4/N of AUTO-0026."
```

---

## Task 5:OpenAI client 接入 image case + 修复纯图片消息丢弃

**Files:**
- Modify: `src/agent/openai-stream-client.ts`(L244 附近 + L247-256 组装逻辑)
- Test: `src/__tests__/agent/openai-stream-client.test.ts`

### - [ ] Step 1:改造 mock 以捕获 `messages` 参数

与 Task 4 同理。读 `src/__tests__/agent/openai-stream-client.test.ts` 找到 `makeMockClient`,把 `create: async (_params: unknown)` 改为捕获 params:

```ts
function makeMockClient(chunks: MockChunk[]) {
  const captured: Array<{ messages: unknown }> = [];
  const client = {
    chat: {
      completions: {
        create: async (params: any): Promise<AsyncIterable<MockChunk>> => {
          captured.push({ messages: params.messages });
          return { /* 现有 async iterable 不变 */ };
        },
      },
    },
  };
  return Object.assign(client, { captured });
}
```

### - [ ] Step 2:运行现有测试,确认不回归

```bash
npx vitest run src/__tests__/agent/openai-stream-client.test.ts
```
Expected: 原有测试全过。

### - [ ] Step 3:写失败测试 — 三种 content 组合

在 `src/__tests__/agent/openai-stream-client.test.ts` **末尾**追加:

```ts
import type { ImageBlock } from '../../agent/types.js';

describe('OpenAIStreamClient — 图片输入', () => {
  // 用例 A:文本 + 图片(验证 content 升级为数组)
  it('文本+图片 → content 为数组,含 text part 和 image_url part', async () => {
    const chunks: MockChunk[] = [
      { id: 'img-A', model: 'gpt-4o', choices: [{ delta: { role: 'assistant' }, finish_reason: null, index: 0 }] },
      { id: 'img-A', model: 'gpt-4o', choices: [{ delta: { content: 'ok' }, finish_reason: null, index: 0 }] },
      { id: 'img-A', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const mockWrapper = makeMockClient(chunks);
    const streamClient = new OpenAIStreamClient({ apiKey: 'test', model: 'gpt-4o' }, mockWrapper as any);

    const imageBlock: ImageBlock = { type: 'image', mediaType: 'image/png', data: 'AAA' };
    const messages: Message[] = [
      { role: 'user', content: [imageBlock, { type: 'text', text: 'describe' }] },
    ];

    await collect(streamClient.stream(messages, TOOLS, OPTIONS));

    expect(mockWrapper.captured.length).toBeGreaterThanOrEqual(1);
    const capturedMessages = mockWrapper.captured[0]!.messages as Array<{ role: string; content: any }>;
    // 找到 user 消息(跳过 system)
    const userMsg = capturedMessages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg!.content)).toBe(true);
    // 含 image_url part
    const imageUrlPart = userMsg!.content.find((p: any) => p.type === 'image_url');
    expect(imageUrlPart).toBeDefined();
    expect(imageUrlPart.image_url.url).toBe('data:image/png;base64,AAA');
    // 含 text part
    const textPart = userMsg!.content.find((p: any) => p.type === 'text');
    expect(textPart).toBeDefined();
    expect(textPart.text).toBe('describe');
  });

  // 用例 B:纯图片(验证修复后的新分支,防止回归)
  it('纯图片 → content 为纯 image_url 数组(不被 L253 else if 丢弃)', async () => {
    const chunks: MockChunk[] = [
      { id: 'img-B', model: 'gpt-4o', choices: [{ delta: { role: 'assistant' }, finish_reason: null, index: 0 }] },
      { id: 'img-B', model: 'gpt-4o', choices: [{ delta: { content: 'ok' }, finish_reason: null, index: 0 }] },
      { id: 'img-B', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const mockWrapper = makeMockClient(chunks);
    const streamClient = new OpenAIStreamClient({ apiKey: 'test', model: 'gpt-4o' }, mockWrapper as any);

    const imageBlock: ImageBlock = { type: 'image', mediaType: 'image/jpeg', data: 'BBB' };
    const messages: Message[] = [{ role: 'user', content: [imageBlock] }];

    await collect(streamClient.stream(messages, TOOLS, OPTIONS));

    const capturedMessages = mockWrapper.captured[0]!.messages as Array<{ role: string; content: any }>;
    const userMsg = capturedMessages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined(); // 关键:修复前 user 消息会被跳过
    expect(Array.isArray(userMsg!.content)).toBe(true);
    expect(userMsg!.content.length).toBe(1);
    expect(userMsg!.content[0].type).toBe('image_url');
    expect(userMsg!.content[0].image_url.url).toBe('data:image/jpeg;base64,BBB');
  });

  // 用例 C:纯文本(验证不回归,content 仍为字符串)
  it('纯文本 → content 仍为字符串(不被错误升级为数组)', async () => {
    const chunks: MockChunk[] = [
      { id: 'img-C', model: 'gpt-4o', choices: [{ delta: { role: 'assistant' }, finish_reason: null, index: 0 }] },
      { id: 'img-C', model: 'gpt-4o', choices: [{ delta: { content: 'ok' }, finish_reason: null, index: 0 }] },
      { id: 'img-C', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const mockWrapper = makeMockClient(chunks);
    const streamClient = new OpenAIStreamClient({ apiKey: 'test', model: 'gpt-4o' }, mockWrapper as any);

    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];

    await collect(streamClient.stream(messages, TOOLS, OPTIONS));

    const capturedMessages = mockWrapper.captured[0]!.messages as Array<{ role: string; content: any }>;
    const userMsg = capturedMessages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(typeof userMsg!.content).toBe('string');
    expect(userMsg!.content).toBe('hello');
  });
});
```

### - [ ] Step 4:运行测试,确认失败

```bash
npx vitest run src/__tests__/agent/openai-stream-client.test.ts
```
Expected:
- 用例 A 失败:content 是字符串 `'hello'`-like,不含 image_url part。
- 用例 B 失败:user 消息完全不存在(被 L253 `else if (textParts.length > 0)` 跳过)。
- 用例 C 应该通过(现有路径)。

### - [ ] Step 5:修改 OpenAI client

在 `src/agent/openai-stream-client.ts`:

1. 顶部新增 import:

   ```ts
   import { buildOpenAIImagePart } from './image-utils.js';
   import type { OpenAIImagePart } from './image-utils.js';
   ```

2. 找到 `convertMessages` 内的循环。当前循环里有 `textParts` 和 `toolCalls` 局部变量,**新增** `imageParts`:

   在循环外(与 textParts/toolCalls 同级)新增:

   ```ts
   const imageParts: OpenAIImagePart[] = [];
   ```

3. 循环内 L244 `// image block:MVP 跳过` 替换为:

   ```ts
   } else if (block.type === 'image') {
     imageParts.push(buildOpenAIImagePart(block));
   }
   ```

4. L247-256 的组装逻辑修正为四分支:

   ```ts
   // 组装当前消息
   if (m.role === 'assistant') {
     const msg: Record<string, unknown> = { role: 'assistant' };
     if (textParts.length > 0) msg.content = textParts.join('');
     if (toolCalls.length > 0) msg.tool_calls = toolCalls;
     result.push(msg);
   } else if (textParts.length > 0 && imageParts.length > 0) {
     // 文本 + 图片:content 升级为数组
     result.push({
       role: m.role,
       content: [{ type: 'text', text: textParts.join('') }, ...imageParts],
     });
   } else if (imageParts.length > 0) {
     // 只有图片(无文本):必须新增此分支,否则纯图片消息会被跳过
     result.push({ role: m.role, content: imageParts });
   } else if (textParts.length > 0) {
     // 只有文本:保持原样(字符串 content)
     result.push({ role: m.role, content: textParts.join('') });
   }
   // textParts 与 imageParts 都为空:跳过(与现有行为一致)
   ```

### - [ ] Step 6:运行测试,确认全过

```bash
npx vitest run src/__tests__/agent/openai-stream-client.test.ts
```
Expected: 3 个新测试全过 + 原测试不回归。

### - [ ] Step 7:类型检查

```bash
npx tsc --noEmit
```
Expected: exit 0。

### - [ ] Step 8:提交

```bash
git add src/agent/openai-stream-client.ts src/__tests__/agent/openai-stream-client.test.ts
git commit -m "feat(image): OpenAI provider sends ImageBlock as image_url + fix pure-image drop bug

- 替换 // image block:MVP 跳过 为 buildOpenAIImagePart 调用
- 修正 user 消息组装为四分支(text/image/混合/纯文本)
- 修复原 L253 else if (textParts.length > 0) 导致纯图片消息被完全丢弃的 bug

Task 5/N of AUTO-0026."
```

---

## Task 6:全量验证与 DoD 检查

**Files:** 无文件改动,纯验证。

### - [ ] Step 1:跑全量 agent 测试

```bash
npx vitest run src/agent/ src/__tests__/agent/
```
Expected: 所有测试通过。

### - [ ] Step 2:全量 tsc

```bash
npx tsc --noEmit
```
Expected: exit 0。

### - [ ] Step 3:lint 检查

```bash
npx eslint src/agent/image-utils.ts src/agent/anthropic-stream-client.ts src/agent/openai-stream-client.ts src/agent/google-stream-client.ts src/__tests__/agent/image-utils.test.ts src/__tests__/agent/openai-stream-client.test.ts src/__tests__/agent/google-stream-client.test.ts
```
Expected: 无 error,无 unused,无 floating promise。

### - [ ] Step 4:DoD 清单核对

逐项核对 spec 的 DoD:

1. ✅ OpenAI / Google client 收到带图片的 messages 时正确转换(通过 mock SDK 集成测试)→ Task 4/5 用例验证。
2. ✅ 三家 client 收到空 data ImageBlock 时统一 throw 中文错误(防御测试)→ Task 1 + Task 3 验证。
3. ✅ `ensureImageData` 对非法 mediaType 抛中文错误 → Task 1 用例验证。
4. ✅ 纯图片消息不再被 OpenAI client 静默丢弃 → Task 5 用例 B 验证。
5. ✅ helper 单元测试全过 → Task 1/2。
6. ✅ `npx vitest run src/agent/` 全过 → Step 1。
7. ✅ `tsc --noEmit` exit 0 → Step 2。
8. ✅ lint 通过 → Step 3。
9. ✅ 两处 `// image block:MVP 跳过` 注释已替换;Anthropic 已补防御 → grep 验证:

   ```bash
   grep -rn "image block:MVP 跳过" src/
   ```
   Expected: 0 条命中。

### - [ ] Step 5:更新 to-do-list.md

在 `to-do-list.md` 把 AUTO-0026 移到「已完成」分区,并在日志追加一行:

```
| 2026-07-21 | AUTO-0026 | @agent | 完成 OpenAI/Google provider 图片输入支持:新增 ensureImageData/buildOpenAIImagePart/buildGeminiInlineData 三个 helper(放 image-utils.ts),三家 client 统一接入空 data 防御;修复 OpenAI client 原纯图片消息被丢弃 bug;新增 helper 单测 12 条 + OpenAI/Google mock SDK 集成测试 4 条 |
```

### - [ ] Step 6:提交

```bash
git add to-do-list.md
git commit -m "docs(todo): mark AUTO-0026 done — OpenAI/Google image support shipped"
```

---

## Self-Review

### 1. Spec 覆盖核查

| Spec 章节 | 对应 Task |
|----------|-----------|
| 共享 Helper → ensureImageData | Task 1 |
| 共享 Helper → buildOpenAIImagePart | Task 2 |
| 共享 Helper → buildGeminiInlineData | Task 2 |
| 类型新增(放 image-utils.ts) | Task 1(类型与 ensureImageData 同步加) |
| 数据流 → 正常路径 | Task 4/5 集成测试 |
| 数据流 → 防御路径 | Task 1 + Task 3 |
| 底层实现 → OpenAI client(结构改动 + 四分支) | Task 5 |
| 底层实现 → Google client(纯增量) | Task 4 |
| 底层实现 → Anthropic client(补防御) | Task 3 |
| 测试 → helper 单元测试 | Task 1/2 |
| 测试 → OpenAI/Google client 集成测试 | Task 4/5 |
| 测试 → 空 data 防御回归 | Task 3 |
| DoD 9 条 | Task 6 |

✅ 全部覆盖。

### 2. 占位扫描

- 无 TBD/TODO。
- 每个 Step 都有具体代码或命令。
- MockChunk 在 Task 4/5 的测试里用「最小合法响应」标记,执行者需从现有纯文本用例复制最小 chunks(已在 Step 里说明「可复用纯文本用例的 chunks」),这是合理的参考而非占位。

### 3. 类型一致性

- `ImageBlock`、`ImageMediaType`:来自 `types.ts`,所有 Task 一致使用。
- `OpenAIImagePart`、`GeminiInlineData`:Task 1 定义,Task 2/4/5 引用,字段名一致(`image_url.url` / `inlineData.mimeType` / `inlineData.data`)。
- `ensureImageData`、`buildOpenAIImagePart`、`buildGeminiInlineData`:函数名在所有 Task 中一致。
- `makeMockClient` 的 `captured` 字段:Task 4/5 引用,字段名一致。

✅ 类型与命名一致。

### 4. 顺序合理性

- Task 1/2 先建 helper(无外部依赖,可独立测)。
- Task 3 接 Anthropic(最小改动,验证 helper 可用)。
- Task 4 接 Google(纯增量,简单)。
- Task 5 接 OpenAI(最复杂,结构改动 + bug 修复,放最后)。
- Task 6 全量验证。

✅ 从简单到复杂,每步可独立验证。
