// src/tui/input/clipboard.ts
// 跨平台剪贴板写入（三级回退：OS命令 → tmux → OSC52）。
//
// 物理本质：把选中文本送到系统剪贴板的「快递员」，三条投递路径按优先级回退。
//  1. 本地（非 SSH）：调原生 OS 命令（clip/pbcopy/xclip）—— 最快最可靠
//  2. tmux 环境：tmux load-buffer -w —— 转发到外层终端的剪贴板
//  3. 通用回退：OSC 52 序列（ESC ] 52 ; c ; <base64> BEL）—— 跨 SSH 的标准协议
//
// 不引第三方库（charter 要求）。Buffer + spawn 全部 Node 内置。
//
// 平台命令：
//  - win32: clip（Unicode 支持有限，复杂文本可考虑切 PowerShell Set-Clipboard，本期 YAGNI）
//  - darwin: pbcopy
//  - linux: xclip -selection clipboard（无 xclip 可回退 xsel，本期 YAGNI）
//
// 实现期验证点（spec §3.5）：OSC52 写 process.stdout（非 Ink output channel），
// 自研 renderer 下一帧只写 cell diff 不重写 DCS，预期不冲突。若被覆盖改 commit hook。

import { spawn } from 'child_process';

/** 按平台返回剪贴板命令与参数 */
function clipboardCommand(): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'win32': return { cmd: 'clip', args: [] };
    case 'darwin': return { cmd: 'pbcopy', args: [] };
    default: return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  }
}

/** 用 spawn 跑命令，stdin 管道传文本。失败 reject。 */
function runWithStdin(cmd: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
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

/** OS 原生命令（clip/pbcopy/xclip）。
 *  win32 用 PowerShell Set-Clipboard（原生 UTF-8）；clip 命令按系统 ANSI 代码页
 *  （中文 Windows 是 GBK）读 stdin，UTF-8 文本会乱码（"你是谁" → "浣犳槸璋侊紵"）。 */
function copyNative(text: string): Promise<void> {
  if (process.platform === 'win32') {
    return copyNativeWin32(text);
  }
  const { cmd, args } = clipboardCommand();
  return runWithStdin(cmd, args, text);
}

/** Windows：PowerShell Set-Clipboard。把 stdin 编码设为 UTF-8 后读全部 stdin。
 *  powershell.exe 启动慢（~200ms），但保证 Unicode 正确；失败时上层回退 OSC52。
 *  用 [Console]::In.ReadToEnd() 一次性读全部 stdin（$input 在 NonInteractive 下行为不稳）。 */
function copyNativeWin32(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; ' +
       'Set-Clipboard -Value ([Console]::In.ReadToEnd())',
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    child.on('error', (err) => reject(err));
    child.stdin.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`powershell Set-Clipboard exited with code ${code}`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

/** tmux load-buffer -w（转发到外层终端） */
function tmuxLoadBuffer(text: string): Promise<void> {
  return runWithStdin('tmux', ['load-buffer', '-w', '-'], text);
}

/** OSC 52 序列直接写 stdout（终端标准剪贴板协议） */
function osc52(text: string): void {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}

/**
 * 写文本到系统剪贴板（三级回退）。
 * 纯本地（非 SSH 且非 tmux）→OS命令；tmux 环境→load-buffer；否则（SSH 等）→OSC52。
 * 每级失败（spawn 抛错/退出码非0）静默落到下一级，最终 OSC52 永不抛错。
 *
 * 环境检测在函数内读取（非模块顶层），便于测试注入 env。
 */
export async function writeClipboard(text: string): Promise<void> {
  const isSSH = !!(process.env.SSH_CONNECTION || process.env.SSH_TTY);
  const isTmux = !!process.env.TMUX;

  // 1. 纯本地（非 SSH、非 tmux）：OS 命令最快最可靠。
  //    tmux 单独作为一级环境处理 —— 见下，load-buffer -w 会转发到外层终端，
  //    对本地-tmux 与 SSH-tmux 都比裸 xclip 更可靠（后者未必写得到可见终端的剪贴板）。
  if (!isSSH && !isTmux) {
    try {
      await copyNative(text);
      return;
    } catch {
      // 命令不存在/失败 → 落下一级
    }
  }
  // 2. tmux：load-buffer 转发外层
  if (isTmux) {
    try {
      await tmuxLoadBuffer(text);
      return;
    } catch {
      // 落 OSC52
    }
  }
  // 3. OSC 52：通用回退
  osc52(text);
}
