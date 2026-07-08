// Vitest 配置
//
// 物理本质：考试场地的排座表。
// 告诉 vitest 该去哪些教室找试卷（include），哪些房间别进（exclude）。
//
// 关键：让 vitest 同时识别两处测试源——
//   - src/__tests__/  现有 TDD 单元测试基线（不迁移）
//   - script/         高风险回归测试集（AGENTS.md 规定的沉淀目录）
//
// test 项目（projects）划分两个逻辑集，便于精准触发：
//   - unit      默认 npm test，跑全量
//   - regression npm run test:regression，只跑高风险回归集

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 同时包含两处测试源
    include: [
      'src/__tests__/**/*.test.ts',
      'src/__tests__/**/*.test.tsx',
      'script/**/*.test.ts',
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
