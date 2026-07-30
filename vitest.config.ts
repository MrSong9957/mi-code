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
      'src/render/**/*.test.ts',
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
    // 启用 ANSI 颜色输出，以便测试可以验证 ink 组件的颜色渲染
    env: {
      FORCE_COLOR: '1',
    },
    // 高负载下默认 5000ms 不足：history 全量跑实测耗时膨胀至 5s 量级触发超时。
    // 10s 作为全局兜底，覆盖未显式设置 timeout 的测试；重 IO/冷启动用例由 per-test 覆盖更高值。
    testTimeout: 10000,
    // 预防性设置：本轮未观察到 hook 超时失败（三个 flaky 全部是 testTimeout），
    // 但 history 的 beforeEach 含 mkdirSync + writeFileSync，极端负载下存在同类风险，成本为零。
    hookTimeout: 10000,
  },
});
