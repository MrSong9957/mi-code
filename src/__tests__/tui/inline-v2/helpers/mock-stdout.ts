// src/__tests__/tui/inline-v2/helpers/mock-stdout.ts
//
// MockStdout:捕获 stdout 每次写入(用于 inline-v2 POC 回归测试)。
//
// 物理本质:一段录制流。Ink reconciler 把渲染帧通过 write() 推过来,
// 我们把每次写入的时间戳/原文/字节存进 writes 数组,供测试断言:
//   - <Static> 已固化消息只写一次(进 scrollback)
//   - spinner tick 时未变行(footer / statusbar)不被重写
//   - spinner tick 帧字节远小于完整活动区
//
// 必须实现完整 NodeJS.WriteStream 接口,供 `as unknown as NodeJS.WriteStream`
// 强制转换通过类型检查。所有事件/流方法均为 no-op 占位。
//
// 关键:`isTTY = true` 让 Ink 走交互路径(createIncremental),否则会退化为
// createStandard 一次性输出全量,失去回归意义。

/**
 * 单次 stdout 写入记录。
 */
export interface MockWrite {
  /** 写入时刻(Date.now())。 */
  time: number;
  /** 写入原始字符串(已从 Uint8Array 转换)。 */
  data: string;
  /** 字节长度(Buffer.byteLength)。 */
  bytes: number;
}

/**
 * Mock stdout:实现 NodeJS.WriteStream 接口,记录所有写入。
 *
 * 仅供 inline-v2 回归测试使用 —— 不渲染到真实终端。
 */
export class MockStdout {
  /** 所有 write() 调用的录制结果。 */
  writes: MockWrite[] = [];

  /** 终端宽度(Ink 按此断行)。 */
  columns = 80;
  /** 终端高度。 */
  rows = 24;
  /** 关键:必须 true,让 Ink 走交互路径(createIncremental)。 */
  isTTY = true;

  constructor() {
    // 显式重置(避免跨测试污染)。
    this.writes = [];
  }

  write(data: string | Uint8Array): boolean {
    const s = typeof data === 'string' ? data : Buffer.from(data).toString();
    this.writes.push({
      time: Date.now(),
      data: s,
      bytes: Buffer.byteLength(s),
    });
    return true;
  }

  // ─── tty / 流控制(全部 no-op 占位) ──────────────────────
  on(): boolean { return false; }
  off(): boolean { return false; }
  resume(): void {}
  pause(): void {}
  end(): void {}
  cork(): void {}
  uncork(): void {}
  destroy(): void {}
  writev(): boolean { return true; }
  getDefaultHighWaterMark(): number { return 16384; }
  getBytesRead(): number { return 0; }
  getBytesWritten(): number { return 0; }
  isRaw?: boolean;
  setRawMode(): boolean { return false; }
  ref(): void {}
  unref(): void {}

  // ─── NodeJS stream 状态字段 ──────────────────────────────
  readable = false;
  writable = true;
  destroyed = false;
  encoding: BufferEncoding | null = null;
  readonly readableLength = 0;
  readonly writableLength = 0;
  readonly readableHighWaterMark = 0;
  readonly writableHighWaterMark = 0;
  readonly readableFlowing: boolean | null = null;
  readonly readableObjectMode = false;
  readonly writableObjectMode = false;
  readonly readableEnded = false;
  readonly writableEnded = false;
  readonly writableFinished = false;
  readonly writableCorked = 0;
  readonly closed = false;
  readonly errored: Error | null = null;
  readonly writableNeedDrain = false;
  readonly writableObjectModeFlag = false;
  readonly autoDestroy = false;
  readonly emitClose = true;
  readonly highWaterMark = 16384;
  readonly objectMode = false;
  readonly decodeStrings = true;
  readonly signal: AbortSignal | undefined = undefined;

  // ─── EventEmitter(全部返回空,签名兼容) ────────────────
  listeners(): (() => void)[] { return []; }
  rawListeners(): (() => void)[] { return []; }
  eventNames(): (string | symbol)[] { return []; }
  getMaxListeners(): number { return 10; }
  setMaxListeners(): this { return this; }
  addListener(): this { return this; }
  removeListener(): this { return this; }
  removeAllListeners(): this { return this; }
  once(): this { return this; }
  prependListener(): this { return this; }
  prependOnceListener(): this { return this; }
  emit(): boolean { return false; }
  listenerCount(): number { return 0; }
}

/**
 * 创建 MockStdout 实例。统一工厂入口,后续 V2 测试都走这里。
 */
export function createMockStdout(): MockStdout {
  return new MockStdout();
}
