import type { Patch } from './screen-buffer.js';

// 优化补丁序列，减少终端写入次数
export function optimize(patches: Patch[]): Patch[] {
  if (patches.length <= 1) return patches;

  const result: Patch[] = [];
  let len = 0;

  for (const patch of patches) {
    // 跳过空操作
    if (patch.type === 'write' && patch.content === '') continue;

    if (len > 0) {
      const last = result[len - 1]!;

      // 合并连续的 write 操作
      if (patch.type === 'write' && last.type === 'write') {
        result[len - 1] = { type: 'write', content: last.content + patch.content };
        continue;
      }

      // 合并连续的 style 操作（只保留最后一个）
      if (patch.type === 'style' && last.type === 'style') {
        result[len - 1] = patch;
        continue;
      }

      // 如果 write 紧跟 cursorTo，且位置连续，合并
      if (patch.type === 'write' && last.type === 'cursorTo') {
        // 保持 cursorTo，后面会自然合并
      }
    }

    result.push(patch);
    len++;
  }

  return result;
}
