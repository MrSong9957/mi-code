# AUTO-0028 会话恢复图片回填(rehydrate)设计

## 目标

让 resume 后历史消息中的 `ImageBlock` 能从 `cachePath` 自动读回 base64 并正确发送给三家 provider,而非停留在「数据缺失」的 throw 兜底。

## 背景

AUTO-0001 父任务的主链路已打通:`/image` 命令 → 文件/剪贴板读取 → 魔数格式检测 → base64 → Anthropic vision 格式 → 3.75MB 校验 → `saveImageCache` 落盘。AUTO-0026 已补齐 OpenAI / Google 两家 provider 的图片输入支持,并在持久化前用 `stripImagesForPersistence`(`src/agent/image-utils.ts:124-141`)把 `data` 清空只保留 `cachePath`,避免 JSONL 膨胀。

但 resume 时 `sessionStore.loadSync`(`src/session/store.ts:119-135`)原样读回**带空 `data`** 的 ImageBlock,全仓没有任何代码调 `readFile(cachePath)` 把 base64 回填——grep `cachePath` 在全仓只有写、没有读。注释「resume 时通过 cachePath 从磁盘重新读取 base64」(`image-utils.ts:128`)是承诺但未实现。

当前唯一的兜底是 `ensureImageData`(`image-utils.ts:166-187`)在三家 client 都会抛中文错误(消息字面含 `AUTO-0028`),让这条损坏链路「快速失败」而非把空 base64 发给 API;测试 `image-utils.test.ts:250-255`、`:322-326` 锁死这个 throw 契约。

本任务(AUTO-0028)兑现上述承诺,把 throw 兜底替换为真正的回填路径。

## 范围

本任务覆盖:

- 修改 `src/agent/image-utils.ts:166-187` 的 `ensureImageData` 函数:把「data 空即 throw」改为「data 空则尝试从 `cachePath` 回填」。
- 新增私有 helper `rehydrateFromCache(block: ImageBlock): string`,负责 `existsSync` 校验 + `readFileSync` + base64 编码。
- 改写两条原契约测试(去掉 `/AUTO-0028/` 正则,改为新错误消息断言)。
- 新增回填成功路径测试(4 种 mediaType + 0 字节文件边界 + 路径不存在)。
- 新增 tmp 文件管理 helper(`mkdtempSync` + `afterEach` 清理)。

## 非目标

- **不引入任何缓存**(LRU / Map / WeakMap):YAGNI,`readFileSync` 微秒级,API 网络往返才是热点。
- **不修改 resume 回显显示**:resume 后历史带图消息目前回显成 `(结构化内容)`(`src/index.ts:885-909`),这是 AUTO-0001 父任务的独立 UI 缺口,留作后续任务(可能 AUTO-0029)。
- **不改 `stripImagesForPersistence`**:持久化前 strip 逻辑保持不变。
- **不改 `sessionStore.loadSync`**:resume 加载逻辑保持原样。
- **不改 `saveImageCache`**:写盘逻辑保持不变。
- **不改三家 provider client 的调用代码**:`ensureImageData` 对外签名不变,调用方零改动。
- **不改 `ImageBlock` 类型定义**:`cachePath?` 字段已存在。
- **不引入新依赖**:仅复用 `node:fs` 的 `existsSync` + `readFileSync`。
- **不在 `ensureImageData` 之外做改动**(除非测试必需)。

## 方案

懒加载(lazy rehydrate):不改 resume 加载流程,不改 `sessionStore.loadSync`,只把 `ensureImageData` 的 throw 路径替换为「按需从 `cachePath` 读取」。

理由:

- **接缝天然存在**:`ensureImageData` 已经是三家 provider 的统一入口(`anthropic-stream-client.ts:264`、`openai-stream-client.ts:246` 经 `buildOpenAIImagePart`、`google-stream-client.ts:222` 经 `buildGeminiInlineData`),一处修改三家受益。
- **对外签名不变**:`(block: ImageBlock) => string` 保持,调用方零改动。
- **内存峰值低**:按需读取,不会一次性把所有历史图片载入内存(对比方案 A「resume 批量回填」在多图场景内存峰值高)。
- **失败粒度细**:单条消息的图片读不到只影响该次请求,不会让整个 resume 失败。

放弃的方案:

- A(resume 加载时批量回填):语义清晰但内存峰值高、调用点要在 `index.ts:852-858` 改动、改动面更大。
- C(显式触发 `/reload-image`):引入用户需学习的隐藏概念,体验差。

## 改造锚点

`src/agent/image-utils.ts:166-187` 的 `ensureImageData(block: ImageBlock): string`

### 改造前

```ts
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

### 改造后(结构骨架,具体消息文案见「错误处理」节)

```ts
export function ensureImageData(block: ImageBlock): string {
  // 1. mediaType 校验(不变)
  if (!SUPPORTED_MEDIA_TYPES.has(block.mediaType)) {
    throw new Error(
      `不支持的图片类型:${block.mediaType}\n` +
        `支持的类型:image/png、image/jpeg、image/gif、image/webp`,
    );
  }

  // 2. 热路径:data 已有,直接返回
  if (block.data) return block.data;

  // 3. 冷路径:从 cachePath 回填
  return rehydrateFromCache(block);
}
```

### 新增私有 helper

```ts
function rehydrateFromCache(block: ImageBlock): string {
  if (!block.cachePath) throw new Error(/* 见 §3-B */);
  if (!existsSync(block.cachePath)) throw new Error(/* 见 §3-C */);
  const buf = readFileSync(block.cachePath);
  if (buf.length === 0) throw new Error(/* 见 §3-D */);
  return buf.toString('base64');
}
```

### 解耦决策

把核心判断留在 `ensureImageData`,把「回填」抽成私有 `rehydrateFromCache`:

- **单一职责**:`ensureImageData` 负责「拿到 data」,`rehydrateFromCache` 负责「从磁盘读回」。
- **测试边界清晰**:可分别对两者写测试,后者用 tmp 文件。
- **未来逃生阀**:若要加缓存(YAGNI 现在不加),替换 `rehydrateFromCache` 内部即可,不影响入口。

## 数据流

### 完整生命周期时序

```
┌─ 首次对话 (AUTO-0001 主链路,不改) ────────────────────────────────┐
│                                                                     │
│  /image foo.png                                                     │
│       │                                                             │
│       ▼                                                             │
│  processImageCommand                                                │
│       │                                                             │
│       ▼                                                             │
│  encodeImageBlock(foo.png)  →  block.data = "<base64>"              │
│       │                                                             │
│       ▼                                                             │
│  saveImageCache(sid, id, block)  →  ~/.micode/image-cache/          │
│                                       <sid>/<id>.png  (二进制)       │
│       │                                                             │
│       ▼                                                             │
│  block.cachePath = "/home/u/.micode/image-cache/<sid>/1.png"        │
│       │                                                             │
│       ▼                                                             │
│  streamingQuery([block, ...])                                       │
│       │                                                             │
│       ▼                                                             │
│  convertMessages → ensureImageData(block)                           │
│       │                                                             │
│       ▼                                                             │
│  block.data 非空 → 热路径直接返回  ──────────────► 发给 provider     │
│       │                                                             │
│       ▼                                                             │
│  onMessages → stripImagesForPersistence(msg)                        │
│       │                                                             │
│       ▼                                                             │
│  block.data 被清成 ""  →  append 到 session.jsonl                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─ 进程重启 + resume (AUTO-0028 新增路径) ──────────────────────────┐
│                                                                     │
│  micode --resume <sid>                                              │
│       │                                                             │
│       ▼                                                             │
│  sessionStore.loadSync(sid)                                         │
│       │                                                             │
│       ▼                                                             │
│  sessionMessages = [{ role:'user',                                  │
│                      content:[ { type:'image',                      │
│                                  mediaType:'image/png',             │
│                                  data:'',            ← 空字符串     │
│                                  cachePath:'/.../1.png' },          │
│                                { type:'text',                       │
│                                  text:'这是什么' } ] }, ...]        │
│       │                                                             │
│       ▼                                                             │
│  initialMessages: sessionMessages  (index.ts:710)                   │
│       │                                                             │
│       ▼                                                             │
│  用户输入下一条 → streamingQuery([历史 + 新消息])                   │
│       │                                                             │
│       ▼                                                             │
│  convertMessages → ensureImageData(block)                           │
│       │                                                             │
│       ▼                                                             │
│  block.data 空  →  走冷路径                                         │
│       │                                                             │
│       ▼                                                             │
│  rehydrateFromCache(block)                                          │
│       │                                                             │
│       ├─ cachePath 存在?                                             │
│       │   └─ 是 → existsSync(cachePath)?                            │
│       │       └─ 是 → readFileSync → base64 ──► 发给 provider      │
│       │                                                             │
│       ├─ cachePath 缺失? → throw (见错误处理 B)                     │
│       ├─ 文件不存在?   → throw (见错误处理 C)                       │
│       └─ 文件 0 字节?  → throw (见错误处理 D)                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 三种路径对照

| 路径 | 触发条件 | 代码流 | IO | 内存占用 |
|---|---|---|---|---|
| **热路径**(首次发送) | `block.data` 非空 | `ensureImageData` 直接 return | 0 | 已有 base64 在内存 |
| **冷路径**(resume 后) | `block.data` 空 + `cachePath` 有 + 文件存在 | `rehydrateFromCache` → `existsSync` + `readFileSync` | 2 次(1 stat + 1 read) | 多一份 base64 字符串(短命,convert 完即 GC) |
| **失败路径** | `data` 空 + `cachePath` 缺 / 文件不存在 / 文件 0 字节 | `throw` | ≤1 次(stat) | 无 |

### 内存与 IO 分析

- **单次请求成本**:resume 后每张历史图 `existsSync` (~µs) + `readFileSync` (3.75MB 上限,~ms 级),远低于 API 网络往返(数百 ms 到数秒)。
- **重读场景**:`convertMessages` 每次请求遍历所有历史消息,同一张图会在多轮对话中被读 N 次。单图磁盘读 ~1-5ms,base64 encode ~1ms,真正热点是 API JSON 序列化(把 base64 塞进 request body),那部分本来就在每次请求发生。
- **不缓存理由(YAGNI)**:① 引入 LRU/Map 缓存会增加内存常驻(单图 5MB,10 图 50MB);② 引入缓存失效/进程生命周期问题;③ 实测反馈成为瓶颈前不优化。
- **逃生阀**:未来若真成为瓶颈,在 `rehydrateFromCache` 内部加 `Map<cachePath, string>` 即可,对外接口不变。

### 并发与一致性

- `ensureImageData` 是纯函数(除 IO 外无副作用)。
- `readFileSync` 同步阻塞,无竞态。
- 单进程内 `streamingQuery` 串行,无并发问题。
- 文件系统视角:cachePath 文件由 `saveImageCache` 写入后**只读**,不存在写-读冲突。

## 错误处理

### 错误传播链路(已查证)

```
ensureImageData throw
  │
  │  convertMessages (无 try/catch)
  ▼
  │  stream() (Anthropic try 只包 SDK,不包 convertMessages)
  ▼
  │  query-engine.submit() (无 try/catch)
  ▼
  │  streamingQuery catch (streaming-query.ts:218)
  │    classifyError → 'unknown'
  │    handleError → return false (不重试)
  │    emitError(recoverable:false) + emitLoopEnd
  │    throw error  ← 重新抛出
  ▼
  │  index.ts:801 catch
  │    formatErrorForDisplay(err) → err.message(去 stack,截 300 字符)
  │    tuiHandle.printStyled(`[Error] ${msg}`, 'error')
  ▼
  红色 system 消息进 messagesStore → Ink 渲染
```

**结论**:只要 `ensureImageData` throw 中文 `Error`,用户会看到红色 `[Error] 中文消息` 行,无 stack trace,**无需新增 UI 代码**。

### 错误消息设计

#### A · mediaType 不支持(保留不变)

```ts
throw new Error(
  `不支持的图片类型:${block.mediaType}\n` +
    `支持的类型:image/png、image/jpeg、image/gif、image/webp`,
);
```

#### B · data 空 + cachePath 缺失(改写)

**场景**:理论上不可能发生(strip 永远保留 cachePath,saveImageCache 总会返回路径),但作为防御性兜底。用户无法自救,需要开发者排查。

```ts
throw new Error(
  `图片数据缺失,且未记录缓存路径,无法发送。\n` +
    `mediaType:${block.mediaType}\n` +
    `这通常是会话状态损坏,请到 GitHub Issues 反馈。`,
);
```

#### C · data 空 + cachePath 有 + 文件不存在(新增)

**场景**:用户清了 `~/.micode/image-cache/`、磁盘换了、跨设备迁移会话。用户可自愈——重新发 `/image` 即可。

```ts
throw new Error(
  `图片缓存文件丢失,无法发送历史图片。\n` +
    `缓存路径:${block.cachePath}\n` +
    `mediaType:${block.mediaType}\n` +
    `建议:重新使用 /image 命令附加该图片。`,
);
```

#### D · 文件存在但 0 字节(新增)

**场景**:剪贴板保存失败的残留、磁盘写入异常中断。属于 silent corruption,必须 throw。

```ts
throw new Error(
  `图片缓存文件为空: ${block.cachePath}\n` +
    `建议:重新使用 /image 命令附加该图片。`,
);
```

#### E · readFileSync 抛其他错误(EACCES/EIO 等)

**不额外包装**,让它自然冒泡到 `index.ts:801`,用户看到原始 `Error: EACCES: permission denied, open '/.../1.png'`。

**理由**:① 这些错误极罕见,加包装反而掩盖根因;② `formatErrorForDisplay` 会保留 `err.message`,用户能看到完整 system 错误;③ 与项目其他 `readFileSync` 调用(如 `encodeImageBlock`)一致,不特殊化。

### 错误消息约束

| 约束 | 数值/规则 | 来源 |
|---|---|---|
| 最大长度 | ≤300 字符(超出被 `formatErrorForDisplay` 截断 + `…`) | `format-error.ts:18` |
| 换行 | `\n` 会原样渲染为多行 | Ink `<Static>` 原样输出 |
| 字符 | 中文 + 半角标点 | 与现有错误消息一致 |
| 前缀 | `[Error]`(由 `index.ts:810` 加) | 不在 message 内重复 |
| 必含字段 | `cachePath`(失败时)、`mediaType`(上下文) | 用户可执行自救 |

## 测试策略

### 测试分层

| 层 | 范围 | 是否新增/改动 |
|---|---|---|
| 单元 | `ensureImageData` + `rehydrateFromCache` | ✅ 新增 + 改动 |
| 集成 | 三家 provider client 的 image case | ❌ 不动(helper 行为对它们透明) |
| E2E | resume 全流程 | ❌ 不新增(投入产出比低,核心契约已由单元层锁死) |

### 原契约测试改动

`src/__tests__/agent/image-utils.test.ts` 现有两条 throw 契约测试(约 250-255 行、322-326 行)断言 throw 消息含 `/AUTO-0028/`。改造后:

| 原测试 | 处理 |
|---|---|
| `throws when mediaType is unsupported` | ✅ 保留(逻辑未变) |
| `throws when data is empty (AUTO-0028 placeholder)` | ♻️ **改写**:场景改为「data 空 + 无 cachePath」,断言消息含 `未记录缓存路径` |
| 测试名里的 `AUTO-0028` 字样 | ♻️ **全部移除**(契约已交付,不留过期标记) |

### TDD 红灯顺序

```
1. 基线:运行现有测试 → GREEN,确认 35 条左右全过
   npx vitest run src/__tests__/agent/image-utils.test.ts

2. RED:改写「data 空」测试为「data 空 + 无 cachePath」
        + 新增「文件不存在」测试
        + 新增「文件存在 → 回填」测试(4 种 mediaType)
        + 新增「0 字节文件」测试
   预期失败:
   - 「无 cachePath」:实际消息含 AUTO-0028,不含「未记录缓存路径」
   - 「文件不存在」:throw 的是 AUTO-0028 消息,不含「缓存文件丢失」
   - 「文件存在」:throw 而非返回 base64
   - 「0 字节」:返回 '' 而非 throw

3. GREEN:改 ensureImageData + 新增 rehydrateFromCache → 全过

4. REFACTOR:如有必要 → 全过
```

### 新增测试矩阵

#### 测试组 1:`ensureImageData` 入口(5 条)

| # | 测试名 | 输入 | 期望 |
|---|---|---|---|
| 1.1 | 返回已有 data(热路径) | `{data:'abc', mediaType:'image/png'}` | 返回 `'abc'`,无 IO |
| 1.2 | mediaType 不支持时 throw | `{mediaType:'image/bmp', data:'x'}` | throw `/不支持的图片类型/` |
| 1.3 | data 空 + cachePath 缺失 throw | `{data:'', mediaType:'image/png'}` | throw `/未记录缓存路径/` |
| 1.4 | data 空 + cachePath 文件不存在 throw | `{data:'', cachePath:'/no/such.png', mediaType:'image/png'}` | throw `/缓存文件丢失/` 且消息含 `/no/such.png` |
| 1.5 | data 空 + cachePath 文件存在 → 回填 | tmp 文件写入已知字节 | 返回值 === `Buffer.from(已知字节).toString('base64')` |

#### 测试组 2:跨 mediaType 回填(4 条)

| # | mediaType | 文件内容 | 期望 |
|---|---|---|---|
| 2.1 | `image/png` | PNG 魔数 `89 50 4E 47` 开头字节 | 返回正确 base64 |
| 2.2 | `image/jpeg` | JPEG 魔数 `FF D8 FF` 开头字节 | 返回正确 base64 |
| 2.3 | `image/gif` | GIF 魔数 `47 49 46` 开头字节 | 返回正确 base64 |
| 2.4 | `image/webp` | WebP 魔数 `RIFF....WEBP` | 返回正确 base64 |

**目的**:确保 `rehydrateFromCache` 不依赖魔数分支,纯按字节读回 base64。mediaType 字段在 rehydrate 路径下**只用于白名单校验**(已由 `ensureImageData` 入口完成),不参与读取逻辑。

#### 测试组 3:边界条件(2 条)

| # | 场景 | 期望 |
|---|---|---|
| 3.1 | cachePath 是符号链接指向真实文件 | 正常回填(操作系统层面 `existsSync`/`readFileSync` 自然支持) |
| 3.2 | cachePath 指向 0 字节文件 | throw `/缓存文件为空/` |

### 临时文件管理

**选 Node `os.tmpdir()` + `mkdtempSync` + `afterEach` 清理**(跨平台、系统级隔离)。

封装 helper(在测试文件内私有):

```ts
function makeTmpImage(bytes: Buffer, ext = '.png'): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'micode-img-'));
  const path = join(dir, `test-${Date.now()}${ext}`);
  fs.writeFileSync(path, bytes);
  return path;
}

function cleanupTmp(path: string): void {
  try {
    const dir = dirname(path);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}
```

### 防止空跑

| 防线 | 实现 |
|---|---|
| 测试 1.5 必须断言返回的 base64 === 已知字节算出的 base64 | 防止返回了"某个"字符串但实际不是源 |
| 测试 2.1-2.4 用不同的魔数前缀字节 | 防止 `rehydrateFromCache` 硬编码某个 base64 返回值 |
| 测试 1.4 断言消息含完整路径字符串 | 防止 throw 了但消息里没带定位信息 |
| 新增的 rehydrate 路径必须先 RED 再 GREEN | 严格遵守 TDD,不允许先实现再补测试 |

### 测试执行命令

| 阶段 | 命令 | 预期 |
|---|---|---|
| 基线确认 | `npx vitest run src/__tests__/agent/image-utils.test.ts` | 全过(35 条左右) |
| RED | 同上 | 3 条新增/改写测试失败,其余过 |
| GREEN | 同上 | 全过 |
| REFACTOR | 同上 | 全过 |
| 不回归 | `npx vitest run src/__tests__/agent/` | 49 个全过 |
| 类型 | `npx tsc --noEmit` | exit 0 |

### 不写的测试(YAGNI)

- ❌ 不写「readFileSync 抛 EACCES 时的行为」(依赖系统权限,跨平台不稳)
- ❌ 不写「并发读同一文件」(项目无并发场景)
- ❌ 不写「LRU 缓存」(不引入)
- ❌ 不写「三家 provider 的 convertMessages 改动」(它们零改动)
- ❌ 不写「resume 全流程 E2E」(投入产出比低,核心契约已由单元层锁死)

## 防御边界(按 AGENTS.md S 级规则)

| 高频崩溃异常操作 | 防护设计 |
|---|---|
| 用户手动删 `~/.micode/image-cache/` | `existsSync` 检测 + 错误处理 C 清晰消息 |
| cachePath 指向 0 字节文件(剪贴板保存失败残留) | 错误处理 D + 测试组 3.2 `buf.length === 0` throw |
| 跨设备迁移会话(cachePath 绝对路径失效) | 错误处理 C 错误消息含完整路径,用户可自救 |
| mediaType cast 绕过 TS(如 `'application/octet-stream'`) | `SUPPORTED_MEDIA_TYPES` 白名单(已存在) |
| 测试污染(tmp 文件残留) | `afterEach` + `mkdtempSync` 隔离 |

## 完成验收

- [ ] `ensureImageData` 改造完成,`rehydrateFromCache` 私有 helper 实现。
- [ ] 4 条新增测试 + 2 条改写测试全部通过。
- [ ] `npx vitest run src/__tests__/agent/` 49 个测试不回归。
- [ ] `npx tsc --noEmit` exit 0。
- [ ] `to-do-list.md` 中 AUTO-0028 标记 `[x]`,日志追加一行。
- [ ] AUTO-0001 暂不关闭(还有 AUTO-0027)。

## 参考资料

- 错误传播查证:基于 `src/agent/streaming-query.ts:218`、`src/index.ts:801`、`src/cli/format-error.ts:26-38`、`src/tui/bootstrap.tsx:151-169` 的实际代码追踪。
- 类似 throw 模式参考:`src/agent/anthropic-stream-client.ts:92-103`(API 错误中文包装,明确意图「不让 streamingQuery 的恢复逻辑吞掉」)。
- 上游 spec:`docs/superpowers/specs/2026-07-21-openai-google-image-support-design.md`(AUTO-0026,预留 `ensureImageData` 作为本任务接缝)。
