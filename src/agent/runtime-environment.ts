// src/agent/runtime-environment.ts
//
// 运行时环境信息(注入 system prompt):让模型知道当前 OS/platform,
// 避免发出平台不兼容命令(如 Windows 上用 /dev/null、wc)。
// 信息来自运行时实际值(process.platform),不硬编码。

/**
 * 构建运行时环境信息段,注入主 system prompt。
 *
 * 只提供可靠确定的字段:`process.platform`(始终可用)。
 * shell 类型不能可靠确定时不猜测(避免误导模型)。
 */
export function buildRuntimeEnvironmentInfo(): string {
  const platform = process.platform;
  const label = platform === 'win32' ? 'Windows'
    : platform === 'darwin' ? 'macOS'
    : platform === 'linux' ? 'Linux'
    : platform;
  return `# Runtime Environment\n\nYou are running on ${label} (platform: ${platform}). Ensure all shell commands and file paths are compatible with this platform.`;
}
