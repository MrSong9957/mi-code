import type { Patch } from './screen-buffer.js';

// 将优化后的补丁写入 stdout
export function writePatches(patches: Patch[]): void {
  if (patches.length === 0) return;

  let buf = '';
  for (const patch of patches) {
    switch (patch.type) {
      case 'cursorTo':
        buf += `\x1b[${patch.y + 1};${patch.x + 1}H`;
        break;
      case 'style':
        buf += patch.ansi;
        break;
      case 'write':
        buf += patch.content;
        break;
      case 'clear':
        buf += '\x1b[2J\x1b[H';
        break;
    }
  }

  process.stdout.write(buf);
}
