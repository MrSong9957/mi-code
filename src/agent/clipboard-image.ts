// src/agent/clipboard-image.ts
// Windows 剪贴板图片读取:PowerShell Get-Clipboard -Format Image → 临时 PNG 文件。
//
// 设计原则:
// - 依赖注入 execFn,测试时 mock,不依赖真实 spawn
// - 临时文件路径可注入(测试用),默认用 os.tmpdir()
// - 失败静默返回 null/false,上层友好提示
//
// PowerShell 命令(对标 Claude Code imagePaste.ts:72-78):
//   检测:(Get-Clipboard -Format Image) -ne $null  → True/False
//   保存:$img = Get-Clipboard -Format Image; $img.Save('<path>', Png)
//
// Get-Clipboard -Format Image 无图时返回 $null(不是空字符串,不抛异常)。

import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

/** PowerShell 命令执行结果 */
export interface PowerShellResult {
  stdout: string;
  code: number;
}

/**
 * 默认 PowerShell 执行器:spawn powershell.exe -NoProfile -Command,收集 stdout。
 * 失败(命令不存在/超时)抛异常。
 */
export function defaultExecPowerShell(command: string): Promise<PowerShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ stdout, code: code ?? -1 }));
  });
}

/** 临时文件路径生成器(可注入,测试用) */
type TempPathFn = () => string;
const defaultTempPath: TempPathFn = () =>
  join(tmpdir(), `micode-clipboard-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

/**
 * 检测 Windows 剪贴板是否有图片。
 * PowerShell `(Get-Clipboard -Format Image) -ne $null` → stdout 含 "True" = 有图。
 *
 * execFn 可注入(测试用),默认用 defaultExecPowerShell。
 * 任何错误(非 win32 / spawn 失败 / 非零退出码)都视为"无图"。
 */
export async function hasClipboardImage(
  execFn: (cmd: string) => Promise<PowerShellResult> = defaultExecPowerShell,
): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const result = await execFn('(Get-Clipboard -Format Image) -ne $null');
    if (result.code !== 0) return false;
    return result.stdout.trim().toLowerCase().startsWith('true');
  } catch {
    return false;
  }
}

/**
 * 从 Windows 剪贴板读取图片,保存为临时 PNG 文件。
 *
 * 流程:检测 → 有图 → PowerShell Save 到临时路径 → 返回路径。
 * 无图或失败返回 null。
 *
 * execFn / tempPathFn 可注入(测试用)。
 */
export async function getImageFromClipboard(
  execFn: (cmd: string) => Promise<PowerShellResult> = defaultExecPowerShell,
  tempPathFn: TempPathFn = defaultTempPath,
): Promise<string | null> {
  if (process.platform !== 'win32') return null;

  const hasImage = await hasClipboardImage(execFn);
  if (!hasImage) return null;

  const tempPath = tempPathFn();
  // PowerShell Save 命令:路径里的反斜杠需转义
  const escapedPath = tempPath.replace(/\\/g, '\\\\');
  const saveCmd = `$img = Get-Clipboard -Format Image; if ($img) { $img.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png) }`;

  try {
    const result = await execFn(saveCmd);
    if (result.code !== 0) return null;
    return tempPath;
  } catch {
    return null;
  }
}
