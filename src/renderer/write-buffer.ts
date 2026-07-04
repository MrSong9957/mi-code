// 写入缓冲器：将多次小写入合并为一次原子输出，消除逐字符闪烁
//
// 物理本质：快递打包站 + 揭幕控制器。
// 原来每个小包裹（ANSI 序列）单独发一趟快递（stdout.write），
// 现在攒一批一起发——一趟快递送完，终端一帧刷新，无闪烁。
//
// BSU/ESU（DEC 2026 同步更新）：
// 当 useSyncUpdate=true 时，flush() 会在整批内容外包一层 BSU…ESU，
// 告诉终端"先把这帧藏起来，画完再一次性揭幕"——彻底消除中间态闪烁。
// flushRaw() 始终不走 BSU，用于 enter/exit 等必须立即可见、不能被揭幕延迟的序列。

import { bsu, esu } from './ansi.js';

/** 写出接口 */
export type Writer = (s: string) => void;

/** WriteBuffer 构造选项 */
export interface WriteBufferOptions {
  /** 是否在 flush 时包裹 BSU/ESU（DEC 2026 同步更新）。
   *  默认 false（裸 flush，向后兼容）。Renderer 探测终端能力后传入。 */
  useSyncUpdate?: boolean;
}

/**
 * WriteBuffer
 *
 * 收集多段 ANSI 写入，flush 时拼接为单个字符串一次写出。
 * 减少 stdout.write 调用次数，消除逐字符帧闪烁。
 */
export class WriteBuffer {
  private chunks: string[] = [];
  private writer: Writer;
  private useSyncUpdate: boolean;

  constructor(writer: Writer, opts?: WriteBufferOptions) {
    this.writer = writer;
    this.useSyncUpdate = opts?.useSyncUpdate ?? false;
  }

  /** 追加一段待写入内容（不立即写出） */
  write(s: string): void {
    this.chunks.push(s);
  }

  /** 将缓冲区内容一次性写出。
   *  useSyncUpdate=true 时包裹 BSU…ESU（整帧原子揭幕，防闪烁）。
   *  空缓冲区不写出（避免发孤立的 BSU/ESU 垃圾）。 */
  flush(): void {
    if (this.chunks.length === 0) return;
    const body = this.chunks.join('');
    this.chunks.length = 0;
    this.writer(this.useSyncUpdate ? `${bsu()}${body}${esu()}` : body);
  }

  /** 将缓冲区内容一次性写出，**不走 BSU/ESU**。
   *  用于 enter/exit/clearMessages 等必须立即可见、不能被同步更新揭幕延迟的序列。
   *  幂等性：空缓冲区不写出。 */
  flushRaw(): void {
    if (this.chunks.length === 0) return;
    const body = this.chunks.join('');
    this.chunks.length = 0;
    this.writer(body);
  }

  /** 缓冲区是否为空 */
  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }
}
