// Vitest 配置
//
// 物理本质：考试场地的排座表。
// 告诉 vitest 该去哪些教室找试卷（include），哪些房间别进（exclude）。
//
// 测试源（全部递归匹配，npm test 一键全量跑）：
//   - src/__tests__/**/*.test.ts(x)  常规单元/集成测试（功能正确性）
//   - src/__tests__/regression/      安全缺口回归测试（权限/沙箱/数据，大量 it.fails）
//   - src/tui/**/*.test.ts           TUI 渲染层测试
//
// 两个 npm 脚本：
//   - npm test            全量跑所有测试（每次修改后都应跑这个）
//   - npm run test:regression  只跑 src/__tests__/regression/（安全缺口子集）

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/**/*.test.ts',
      'src/__tests__/**/*.test.tsx',
      'src/tui/**/*.test.ts',
    ],
    exclude: [
      'dist/**',
      'node_modules/**',
    ],
    globals: false,
    // 单进程跑（子进程/git 真实操作的测试对隔离敏感，避免并发污染 tmpdir）
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
