import { describe, it, expect } from 'vitest';
import { buildRuntimeEnvironmentInfo } from '../../agent/runtime-environment.js';

describe('buildRuntimeEnvironmentInfo', () => {
  it('包含运行时 platform(来自 process.platform,不硬编码)', () => {
    const info = buildRuntimeEnvironmentInfo();
    expect(info).toContain(process.platform);
  });

  it('包含可读的 OS 标签', () => {
    const info = buildRuntimeEnvironmentInfo();
    const expectedLabel = process.platform === 'win32' ? 'Windows'
      : process.platform === 'darwin' ? 'macOS'
      : process.platform === 'linux' ? 'Linux'
      : process.platform;
    expect(info).toContain(expectedLabel);
  });
});
