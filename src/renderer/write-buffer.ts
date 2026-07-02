// 写入缓冲器：将多次小写入合并为一次原子输出，消除逐字符闪烁
//
// 物理本质：快递打包站。
// 原来每个小包裹（ANSI 序列）单独发一趟快递（stdout.write），
// 现在攒一批一起发——一趟快递送完，终端一帧刷新，无闪烁。

/** 写出接口 */
export type Writer = (s: string) => void;

/**
 * WriteBuffer
 *
 * 收集多段 ANSI 写入，flush 时拼接为单个字符串一次写出。
 * 减少 stdout.write 调用次数，消除逐字符帧闪烁。
 */
export class WriteBuffer {
  private chunks: string[] = [];
  private writer: Writer;

  constructor(writer: Writer) {
    this.writer = writer;
  }

  /** 追加一段待写入内容（不立即写出） */
  write(s: string): void {
    this.chunks.push(s);
  }

  /** 将缓冲区内容一次性写出 */
  flush(): void {
    if (this.chunks.length === 0) return;
    this.writer(this.chunks.join(''));
    this.chunks.length = 0;
  }

  /** 缓冲区是否为空 */
  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }
}
