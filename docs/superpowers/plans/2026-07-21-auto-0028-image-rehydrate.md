# AUTO-0028 会话恢复图片回填(rehydrate)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 resume 后历史消息中的 `ImageBlock` 能从 `cachePath` 自动读回 base64 发送给三家 provider,而非停留在「数据缺失」的 throw 兜底。

**Architecture:** 懒加载。单一改造锚点 `ensureImageData`,新增私有 helper `rehydrateFromCache`。不改 resume 加载逻辑、不改持久化 strip、不改三家 client 调用、不引入缓存(YAGNI)。

**Tech Stack:** Node.js 18 ESM + TypeScript strict + vitest。仅用 `node:fs` 的 `existsSync` + `readFileSync`。

**Spec:** `docs/superpowers/specs/2026-07-21-auto-0028-image-rehydrate-design.md`

---

## 文件结构

| 文件 | 责任 | 操作 |
|---|---|---|
| `src/agent/image-utils.ts` | 改造 `ensureImageData`(`:166-187`),新增私有 `rehydrateFromCache`;新增 `existsSync` + `readFileSync` import | 修改 |
| `src/__tests__/agent/image-utils.test.ts` | 改写 2 条原契约测试,新增回填成功路径 + 4 种 mediaType + 0 字节边界 + 文件不存在 | 修改 |

**不动的文件**:`anthropic-stream-client.ts` / `openai-stream-client.ts` / `google-stream-client.ts`(调用方零改动)、`session/store.ts`、`index.ts`、`commands/image-command.ts`、`agent/types.ts`。

---

## 标点约定(实现时遵守)

现有 `image-utils.ts` 错误消息使用**全角中文标点**(冒号 `:`,逗号 `,`,圆括号 `()`)。本计划所有错误消息保持一致,不要混用半角。

---

## Task 1: 改写原契约测试为「文件不存在」+ 「cachePath 缺失」预期

**Files:**
- Modify: `src/__tests__/agent/image-utils.test.ts:250-260`(测试组「图片转换 helper — ensureImageData」内两条 throw 测试)
- Modify: `src/__tests__/agent/image-utils.test.ts:319-327`(测试组「三家 client 共享防御」)

### 背景

原测试断言 throw 消息含 `/AUTO-0028/` 字串(`:253`、`:322`、`:324`、`:326`)。改造后实现走文件读取路径,`cachePath: '/tmp/x.png'` 这种磁盘上不存在的路径会触发「文件不存在」错误。需要把正则从 `/AUTO-0028/` 改为 `/缓存文件丢失/`(新错误消息文案见 Task 4 错误处理 C)。

注意:`/图片数据缺失/` 旧正则在「cachePath 缺失」分支(`:259`)依然成立(新错误 B 消息前缀仍是「图片数据缺失」),不需改。

- [ ] **Step 1: 改写测试 250-255**

把 `src/__tests__/agent/image-utils.test.ts:250-255`:

```ts
it('空 data 有 cachePath 抛中文错误(含 cachePath 与 AUTO-0028)', () => {
  const block = makeImageBlock({ data: '', cachePath: '/tmp/x.png' });
  expect(() => ensureImageData(block)).toThrowError(/图片数据缺失/);
  expect(() => ensureImageData(block)).toThrowError(/AUTO-0028/);
  expect(() => ensureImageData(block)).toThrowError(/\/tmp\/x\.png/);
});
```

改为:

```ts
it('空 data + cachePath 指向不存在的文件:抛「缓存文件丢失」错误(含路径)', () => {
  const block = makeImageBlock({ data: '', cachePath: '/tmp/x.png' });
  expect(() => ensureImageData(block)).toThrowError(/缓存文件丢失/);
  expect(() => ensureImageData(block)).toThrowError(/\/tmp\/x\.png/);
});
```

- [ ] **Step 2: 改写测试 319-327**

把 `src/__tests__/agent/image-utils.test.ts:319-327`:

```ts
it('无论经过哪个 builder,空 data 都抛中文错误', () => {
  const block = makeImageBlock({ data: '', cachePath: '/x.png' });
  // 直接调用 helper
  expect(() => ensureImageData(block)).toThrowError(/AUTO-0028/);
  // 经 OpenAI builder 透传
  expect(() => buildOpenAIImagePart(block)).toThrowError(/AUTO-0028/);
  // 经 Gemini builder 透传
  expect(() => buildGeminiInlineData(block)).toThrowError(/AUTO-0028/);
});
```

改为:

```ts
it('无论经过哪个 builder,空 data + 不存在 cachePath 都抛「缓存文件丢失」错误', () => {
  const block = makeImageBlock({ data: '', cachePath: '/x.png' });
  // 直接调用 helper
  expect(() => ensureImageData(block)).toThrowError(/缓存文件丢失/);
  // 经 OpenAI builder 透传
  expect(() => buildOpenAIImagePart(block)).toThrowError(/缓存文件丢失/);
  // 经 Gemini builder 透传
  expect(() => buildGeminiInlineData(block)).toThrowError(/缓存文件丢失/);
});
```

- [ ] **Step 3: 运行测试,确认 4 条测试 RED(预期失败)**

```bash
npx vitest run src/__tests__/agent/image-utils.test.ts
```

Expected: 4 条改写后的测试失败,失败原因是实际 throw 消息含 `AUTO-0028`,不含 `缓存文件丢失`。其余 31 条左右测试仍过。

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/agent/image-utils.test.ts
git commit -m "test(image-utils): update throw contracts for AUTO-0028 rehydrate

原 /AUTO-0028/ 正则改为 /缓存文件丢失/,对应新实现从文件读取而非 throw。
本 commit 仅改测试,实现尚未跟进——故意 RED 驱动下一步实现。"
```

---

## Task 2: 新增「回填成功路径」测试组

**Files:**
- Modify: `src/__tests__/agent/image-utils.test.ts`(在「图片转换 helper — ensureImageData」describe 块末尾,约 267 行后插入)

### 背景

TDD 要求先观察失败、再写实现。本 task 新增的 6 条测试验证 rehydrate 成功路径,期望它们在 Task 4 实现前全部 RED(throw 而非返回 base64)。

- [ ] **Step 1: 确认测试基础设施已就位(无需新增)**

核查 `src/__tests__/agent/image-utils.test.ts`,以下符号本任务全部依赖且**均已在文件中定义**,无需新增:

| 符号 | 位置 | 用途 |
|---|---|---|
| `writeFileSync` | `:7`(fs import) | 写 tmp 文件 |
| `existsSync` | `:7`(fs import) | saveImageCache 测试已用(本任务新测试不直接用,但保留 import 不影响) |
| `join` | `:8`(path import) | 拼接 tmp 路径 |
| `tmpDir` | `:54` 声明,`:56-58` `beforeEach` 创建,`:61-63` `afterEach` 清理 | 每个测试独立目录 |
| `MIN_PNG` | `:26-36`(67 字节 1x1 红点) | PNG 回填测试 |
| `MIN_JPEG` | `:39-43`(22 字节) | JPEG 回填测试 |
| `MIN_GIF` | `:46-49`(14 字节) | GIF 回填测试 |

WebP 字节在 Task 2 Step 2 测试函数内部局部定义(与 `detectImageFormat` 测试块 `:88-93` 的 WebP Buffer 风格一致,隔离性更好),不提升到模块级。

- [ ] **Step 2: 在 ensureImageData describe 块末尾新增「回填成功」测试**

在 `src/__tests__/agent/image-utils.test.ts` 的 `describe('图片转换 helper — ensureImageData', () => { ... })` 块**末尾**(约 267 行,`});` 之前)插入:

```ts
  // ── AUTO-0028: cachePath 回填路径 ──

  it('空 data + cachePath 指向真实文件:返回文件内容的 base64', () => {
    const cachePath = join(tmpDir, 'cached.png');
    writeFileSync(cachePath, MIN_PNG);
    const block = makeImageBlock({ data: '', cachePath });
    expect(ensureImageData(block)).toBe(MIN_PNG.toString('base64'));
  });

  it('PNG 文件回填:base64 与源字节精确相等', () => {
    const cachePath = join(tmpDir, 'png.png');
    writeFileSync(cachePath, MIN_PNG);
    const block = makeImageBlock({ data: '', cachePath, mediaType: 'image/png' });
    expect(ensureImageData(block)).toBe(MIN_PNG.toString('base64'));
  });

  it('JPEG 文件回填:base64 与源字节精确相等', () => {
    const cachePath = join(tmpDir, 'jpeg.jpg');
    writeFileSync(cachePath, MIN_JPEG);
    const block = makeImageBlock({ data: '', cachePath, mediaType: 'image/jpeg' });
    expect(ensureImageData(block)).toBe(MIN_JPEG.toString('base64'));
  });

  it('GIF 文件回填:base64 与源字节精确相等', () => {
    const cachePath = join(tmpDir, 'gif.gif');
    writeFileSync(cachePath, MIN_GIF);
    const block = makeImageBlock({ data: '', cachePath, mediaType: 'image/gif' });
    expect(ensureImageData(block)).toBe(MIN_GIF.toString('base64'));
  });

  it('WebP 文件回填:base64 与源字节精确相等', () => {
    const webpBytes = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]);
    const cachePath = join(tmpDir, 'webp.webp');
    writeFileSync(cachePath, webpBytes);
    const block = makeImageBlock({ data: '', cachePath, mediaType: 'image/webp' });
    expect(ensureImageData(block)).toBe(webpBytes.toString('base64'));
  });

  it('0 字节文件:抛「缓存文件为空」错误', () => {
    const cachePath = join(tmpDir, 'empty.png');
    writeFileSync(cachePath, Buffer.alloc(0));
    const block = makeImageBlock({ data: '', cachePath });
    expect(() => ensureImageData(block)).toThrowError(/缓存文件为空/);
    expect(() => ensureImageData(block)).toThrowError(cachePath);
  });
```

- [ ] **Step 3: 运行测试,确认 6 条新测试 RED**

```bash
npx vitest run src/__tests__/agent/image-utils.test.ts
```

Expected: 6 条新测试失败,前 5 条失败原因「期望返回 base64,实际 throw 旧 AUTO-0028 消息」;第 6 条失败原因「期望 throw 含 `缓存文件为空`,实际 throw 含 `AUTO-0028`」。

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/agent/image-utils.test.ts
git commit -m "test(image-utils): add rehydrate success + empty-file tests (RED)

6 条新增测试覆盖:
- 通用回填成功路径(任意字节)
- PNG/JPEG/GIF/WebP 四种 mediaType 回填
- 0 字节文件边界

实现未跟进,全部 RED,驱动 Task 3-4 实现。"
```

---

## Task 3: 改造 `ensureImageData` + 新增 `rehydrateFromCache`

**Files:**
- Modify: `src/agent/image-utils.ts:8`(import 行,新增 `existsSync`、`readFileSync`)
- Modify: `src/agent/image-utils.ts:166-187`(改造 `ensureImageData`)
- Modify: `src/agent/image-utils.ts`(在 `ensureImageData` 之后新增 `rehydrateFromCache`)

- [ ] **Step 1: 扩展 fs import**

把 `src/agent/image-utils.ts:8`:

```ts
import { mkdirSync, writeFileSync } from 'fs';
```

改为:

```ts
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
```

- [ ] **Step 2: 改造 `ensureImageData`**

把 `src/agent/image-utils.ts:166-187`:

```ts
/**
 * 返回可用的 base64 data。
 * 先校验 mediaType 合法性（防御 cast 绕过类型），再校验 data 非空。
 * 空 data 时抛中文错误——AUTO-0028 会把此路径改为「从 cachePath 回填」。
 */
export function ensureImageData(block: ImageBlock): string {
  if (!SUPPORTED_MEDIA_TYPES.has(block.mediaType)) {
    throw new Error(
      `不支持的图片类型：${block.mediaType}\n` +
        `支持的类型：image/png、image/jpeg、image/gif、image/webp`,
    );
  }
  if (!block.data) {
    throw new Error(
      `图片数据缺失，无法发送。\n` +
        `原因：会话恢复后图片未从缓存回填（等待 AUTO-0028 实现）。\n` +
        `缓存路径：${block.cachePath ?? '(未记录)'}\n` +
        `建议：重新发送 /image 命令附加图片。`,
    );
  }
  return block.data;
}
```

改为:

```ts
/**
 * 返回可用的 base64 data。
 *
 * 路径优先级：
 *   1. mediaType 白名单校验（不变，防御 cast 绕过类型）
 *   2. 热路径：data 非空直接返回（首次发送）
 *   3. 冷路径：委托 rehydrateFromCache 从 cachePath 回填（resume 后）
 *
 * 三家 provider client 都经此 helper，一处修改三家受益。
 */
export function ensureImageData(block: ImageBlock): string {
  if (!SUPPORTED_MEDIA_TYPES.has(block.mediaType)) {
    throw new Error(
      `不支持的图片类型：${block.mediaType}\n` +
        `支持的类型：image/png、image/jpeg、image/gif、image/webp`,
    );
  }
  if (block.data) return block.data;
  return rehydrateFromCache(block);
}

/**
 * 从 cachePath 读回 base64 data（resume 场景）。
 *
 * 当前方案：每次 convertMessages 都读磁盘，不缓存。多轮对话中同一图片会重复读,
 * 但单图磁盘成本（µs-ms 级）远低于 API 往返（数百 ms 到数秒）。
 *
 * 注意：不回写 block.data，保持 ensureImageData 无副作用。
 * 如未来成为瓶颈，可在本函数内部加 Map<cachePath, string> 缓存，对外接口不变。
 *
 * 失败路径：
 *   - cachePath 缺失：状态损坏（理论上不可能，stripImagesForPersistence 总保留 cachePath）
 *   - 文件不存在：用户清缓存 / 跨设备迁移，建议重新 /image
 *   - 0 字节文件：剪贴板保存失败残留，silent corruption，必须 throw
 *   - EACCES/EIO 等系统错误：不包装，自然冒泡（与 encodeImageBlock 一致）
 */
function rehydrateFromCache(block: ImageBlock): string {
  if (!block.cachePath) {
    throw new Error(
      `图片数据缺失，且未记录缓存路径，无法发送。\n` +
        `mediaType：${block.mediaType}\n` +
        `这通常是会话状态损坏，请到 GitHub Issues 反馈。`,
    );
  }
  if (!existsSync(block.cachePath)) {
    throw new Error(
      `图片缓存文件丢失，无法发送历史图片。\n` +
        `缓存路径：${block.cachePath}\n` +
        `mediaType：${block.mediaType}\n` +
        `建议：重新使用 /image 命令附加该图片。`,
    );
  }
  const buf = readFileSync(block.cachePath);
  if (buf.length === 0) {
    throw new Error(
      `图片缓存文件为空：${block.cachePath}\n` +
        `建议：重新使用 /image 命令附加该图片。`,
    );
  }
  return buf.toString('base64');
}
```

- [ ] **Step 3: 运行测试,确认全 GREEN**

```bash
npx vitest run src/__tests__/agent/image-utils.test.ts
```

Expected: 全部测试通过(原 31 条 + 改写 4 条 + 新增 6 条 ≈ 41 条)。

- [ ] **Step 4: 运行三家 client 集成测试,确认不回归**

```bash
npx vitest run src/__tests__/agent/
```

Expected: 49 个测试全过(`openai-stream-client.test.ts` / `google-stream-client.test.ts` 的 image case mock SDK 测试不应受影响——它们传入的 block 都带非空 `data`,走热路径)。

- [ ] **Step 5: 类型检查**

```bash
npx tsc --noEmit
```

Expected: exit 0,无报错。

- [ ] **Step 6: Commit**

```bash
git add src/agent/image-utils.ts
git commit -m "feat(image): AUTO-0028 lazy rehydrate from cachePath

ensureImageData 在 data 空时从 cachePath 读回 base64,替换原 throw 兜底。
新增私有 rehydrateFromCache:existsSync + readFileSync + 0 字节校验。
三家 provider 零改动,经 ensureImageData 自动受益。

错误消息:
- cachePath 缺失 → 状态损坏(GitHub Issues)
- 文件不存在  → 缓存丢失(重新 /image)
- 0 字节文件  → 缓存为空(重新 /image)
- EACCES/EIO  → 不包装自然冒泡

不引入缓存(YAGNI),不回写 block.data(保持无副作用)。"
```

---

## Task 4: 全量回归 + 完成

**Files:**
- 无源码修改,仅验证 + 文档更新

- [ ] **Step 1: 全量测试**

```bash
npm test
```

Expected: 全部通过(注:StatusBar 多色高亮的 2 条既有无关失败按设计文档豁免,不阻塞)。

- [ ] **Step 2: 类型检查**

```bash
npx tsc --noEmit
```

Expected: exit 0。

- [ ] **Step 3: 更新 `to-do-list.md`**

把 `to-do-list.md:42-44` 的 AUTO-0028:

```markdown
- [ ] AUTO-0028: 会话恢复(resume)回填图片
  > `src/agent/image-utils.ts:128` `saveImageCache` 已落盘 `cachePath`,但全仓无读取处(只写不读)。重启会话时图片会以空 data 发送(损坏)。需补 `readFile(cachePath)` → 回填 base64 的 rehydrate 路径。
  > 依赖:AUTO-0001
```

从「待办」分区移动到「已完成」分区(放在 AUTO-0026 之后),并把 `[ ]` 改为 `[x]`,描述更新为完成态:

```markdown
- [x] AUTO-0028: 会话恢复(resume)回填图片
  > resume 后历史消息中的 ImageBlock 从 cachePath 读回 base64,替换原 throw 兜底。
  > 完成:ensureImageData 新增冷路径,委托私有 rehydrateFromCache(existsSync + readFileSync + 0 字节校验)。三家 provider client 零改动,经 ensureImageData 统一受益。4 种错误路径(cachePath 缺失 / 文件不存在 / 0 字节 / 系统 EACCES 等)分级处理,前三种 throw 中文消息,系统错误不包装自然冒泡。改写 2 条原契约测试(去掉 /AUTO-0028/ 正则) + 新增 6 条回填测试(通用 + PNG/JPEG/GIF/WebP + 0 字节边界)。不引入缓存(YAGNI),不回写 block.data(保持无副作用)。49 个 agent 测试全过、tsc exit 0。
```

- [ ] **Step 4: 追加日志条目**

在 `to-do-list.md:158` 日志表最后一行后追加:

```markdown
| 2026-07-21 | AUTO-0028 | @agent | 完成 resume 图片 rehydrate:ensureImageData 新增冷路径 + 私有 rehydrateFromCache(existsSync + readFileSync + 0 字节校验);2 条原契约测试改写 + 6 条新增;49 个 agent 测试全过、tsc exit 0。AUTO-0001 父任务仍不关闭(剩 AUTO-0027)。 |
```

- [ ] **Step 5: Commit**

```bash
git add to-do-list.md
git commit -m "docs(todo): mark AUTO-0028 done — image rehydrate from cachePath"
```

---

## 验收清单(全部完成后自查)

- [ ] `ensureImageData` 改造完成,`rehydrateFromCache` 私有 helper 实现
- [ ] 2 条原契约测试改写,6 条新测试新增,全部通过
- [ ] `npx vitest run src/__tests__/agent/` 49 个测试不回归
- [ ] `npx tsc --noEmit` exit 0
- [ ] `to-do-list.md` AUTO-0028 标记 `[x]`,日志追加
- [ ] AUTO-0001 暂不关闭(还有 AUTO-0027)
- [ ] grep 全仓无残留 `/AUTO-0028/` 正则(测试已全部改写)

```bash
grep -rn "AUTO-0028" src/
```

Expected: 仅在注释里出现(`image-utils.ts` 已移除,测试已改写)。预期命中 0 处或仅在历史 git log 里。
