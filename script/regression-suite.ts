// 回归测试集清单（高风险功能防退化基线）
//
// 物理本质：消防设备的点检表。
// 每次改动后照这张表逐项按下"测试按钮"，确认资金/权限/数据三道防线没退化。
//
// 触发：npm run test:regression
// （脚本通过 vitest run <patterns> 精准跑这些文件，而非全量 93 个）
//
// 清单分两类：
//   A. 现有基线（src/__tests__/ 下高质量测试，已验证覆盖副作用/边界）
//   B. 新增缺口测试（script/ 下，锁定 5 个未覆盖的高危点）
//
// 维护规则：
//   - 新增高风险功能时，在此追加对应测试文件路径
//   - 修复"已知缺口"后，把对应 script/ 测试的 .fails 去掉，仍保留在清单里
//   - 低风险测试（UI 渲染、纯解析）不进此清单

export const REGRESSION_SUITE = {
  // ── A. 现有基线（src/__tests__/） ──
  baseline: [
    // 权限安全（🔴 最高危）
    'src/__tests__/permission.test.ts',
    'src/__tests__/write-bash-patterns.test.ts',
    // Shell/进程
    'src/__tests__/background.test.ts',
    'src/__tests__/background-advanced.test.ts',
    // 文件/Git
    'src/__tests__/tools.test.ts',
    'src/__tests__/worktree.test.ts',
    'src/__tests__/worktree-isolation.test.ts',
    // 资金/重试
    'src/__tests__/recovery.test.ts',
    // 持久化（🟠 高危）
    'src/__tests__/config.test.ts',
    'src/__tests__/scheduler.test.ts',
    'src/__tests__/compression.test.ts',
    'src/__tests__/task-board.test.ts',
    'src/__tests__/task-board-tool.test.ts',
    'src/__tests__/history.test.ts',
    'src/__tests__/team-protocol.test.ts',
    'src/__tests__/session/session-store.test.ts',
  ],

  // ── B. 新增缺口测试（script/） ──
  gaps: [
    // 路径沙箱前缀碰撞（🔴 数据越界写）
    'script/path-sandbox-prefix-collision.test.ts',
    // build 模式权限全维度（🔴 权限：归类正确性 + 三本册子一致性 + 模式校验）
    'script/build-mode-permission.test.ts',
    // 权限↔执行↔磁盘端到端集成（🔴 权限：决策与执行背离的客观证据）
    'script/permission-executor-integration.test.ts',
    // 流式路径 ask 静默放行（🔴 权限：写操作零确认）
    'script/streaming-permission-passthrough.test.ts',
    // 子代理权限透传（🔴 权限：task/self_organizing 裸跑）
    'script/subagent-permission-passthrough.test.ts',
    // worktree 删除安全性（🔴 数据：未提交改动保护）
    'script/worktree-remove-safety.test.ts',
    // PreToolUse hook 接线（🟠 权限：双重防线退化）
    'script/pretooluse-hook-wiring.test.ts',
  ],

  /** 全部路径（供 npm 脚本引用） */
  get all(): string[] {
    return [...this.baseline, ...this.gaps];
  },
} as const;
