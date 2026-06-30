// src/output/encoder.ts
// GBK/UTF-8 自动检测 + 转换
//
// 物理本质：翻译官。
// 收到一封可能是中文写的信（GBK），先试着用英文读（UTF-8），
// 发现读不通（出现乱码符号），再换中文读（GBK）。

import { TextDecoder } from 'util';

/** 编码器：处理 GBK/UTF-8 编码问题 */
export class Encoder {
  /** 乱码检测正则：连续的替换字符或高位字节 */
  private static readonly GARBLED_PATTERN = /[�]{2,}|[\x80-\xff]{4,}/;

  /**
   * 标准化文本：确保输出是合法 UTF-8
   *
   * 物理本质：把收到的信翻译成标准格式。
   * 1. 移除 null 字节（终端不认）
   * 2. 检测乱码特征
   * 3. 返回合法 UTF-8
   */
  static normalize(text: string): string {
    if (!text) return '';

    // 移除 null 字节（终端会显示为 ^@）
    let result = text.replace(/\x00/g, '');

    // 检测是否含乱码特征
    if (this.isGarbled(result)) {
      // 尝试从 GBK 恢复（如果原始数据是 Buffer）
      // 注意：这里只能处理已经是字符串的情况
      // Buffer 的 GBK 解码应该在调用方处理
      result = this.cleanupGarbled(result);
    }

    return result;
  }

  /**
   * 检测是否是乱码
   *
   * 物理本质：检查信里有没有明显的乱码符号。
   * 连续的替换字符（�）或高位字节序列是乱码的特征。
   */
  static isGarbled(text: string): boolean {
    return this.GARBLED_PATTERN.test(text);
  }

  /**
   * 清理乱码文本
   *
   * 物理本质：把信里看不懂的符号替换成占位符。
   * 无法恢复原始内容，只能让它显示得更友好。
   */
  private static cleanupGarbled(text: string): string {
    // 替换连续的乱码字符为省略号
    return text.replace(/[�]{2,}/g, '...');
  }

  /**
   * 从 Buffer 解码（优先 UTF-8，回退 GBK）
   *
   * 物理本质：先试着用英文读，读不通再用中文读。
   * 这是处理 Windows CMD 错误信息的关键函数。
   */
  static decodeBuffer(buf: Buffer): string {
    // 优先尝试 UTF-8
    const utf8 = buf.toString('utf8');

    // 检测是否含替换字符（U+FFFD）
    if (!utf8.includes('�')) {
      return utf8;
    }

    // 回退到 GBK
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      // GBK 解码失败，返回 UTF-8（含乱码）
      return utf8;
    }
  }
}
