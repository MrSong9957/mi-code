// src/tui/input/clipboard.ts
// 跨平台剪贴板写入（OS 命令，charter §核心模块 2 步骤 3）
//
// 物理本质：把选中文本送到系统剪贴板的「快递员」。
// charter 要求用 OS 命令（pbcopy/clip/xclip），不引入 JS 库依赖。
// 用 child_process.spawn + 管道 stdin 传文本（避免 exec 的 shell 转义/长度问题）。
//
// 平台命令：
// - win32: clip（注意 Unicode 支持有限；本 MVP 先用 clip，复杂文本若乱码可切 PowerShell Set-Clipboard）
// - darwin: pbcopy
// - linux: xclip -selection clipboard（无 xclip 时可回退 xsel --clipboard --input）

import { spawn } from 'child_process';

/** 按平台返回剪贴板命令与参数 */
function clipboardCommand(): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'win32': return { cmd: 'clip', args: [] };
    case 'darwin': return { cmd: 'pbcopy', args: [] };
    default: return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  }
}

/**
 * 写文本到系统剪贴板。
 * @throws Error 若 spawn 失败（命令不存在等）或子进程出错
 */
export function writeClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const { cmd, args } = clipboardCommand();
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });

    child.on('error', (err) => reject(err));

    child.stdin.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });

    child.stdin.write(text);
    child.stdin.end();
  });
}
