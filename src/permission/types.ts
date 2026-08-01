// 权限系统类型定义

/** 权限模式 */
export type PermissionMode = 'build' | 'plan' | 'auto';

/** 权限行为（教学版三态，符合 s07 四步管道） */
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

/**
 * 权限规则
 *
 * 匹配字段（均为可选，省略则匹配该工具的所有调用）：
 * - path：glob 匹配 input.path（文件类工具）
 * - content：glob 匹配 input.command（bash）或 input.content
 */
export interface PermissionRule {
  tool: string;
  behavior: PermissionBehavior;
  path?: string;
  content?: string;
}

/**
 * 权限决策结果（LEGACY / COMPAT）
 *
 * 这是 Wave A 之前的口语化决策单 `{ behavior, reason }`，
 * 被 streaming-executor.ts 与若干回归测试消费。
 *
 * RC-5 (Wave A) 引入了结构化的 `SecurityDecision`（见 ./decisions.js），
 * 它带身份、原因码、provenance 引用、协议版本——更适合跨边界传递。
 *
 * 迁移期保留此类型与 `PermissionChecker.check()` 的旧行为，二者并行：
 *   - check()         → PermissionDecision（legacy，不变）
 *   - checkDecision() → SecurityDecision（new）
 *
 * 不要删除此类型，直到所有调用方迁移完成。
 */
export interface PermissionDecision {
  behavior: PermissionBehavior;
  reason: string;
  /**
   * 稳定机器码(与 reason 同源产出,不参与人类阅读)。
   * 值与 mapLegacyReason 产出的 reason_code 完全一致(见对照表)。
   * 下游路由(subagent 静默策略 / session allowlist)据此判断,绝不反推 reason 文本。
   */
  reason_code: string;
}

/**
 * 写操作工具列表（改变系统/工作区状态，plan 模式下需禁用）
 *
 * 物理：所有"会留下痕迹"的工具——写文件、改任务/计划/收件箱状态、
 * 派生子代理等。plan 模式只允许观察，不允许动手，所以这些都得拦。
 *
 * 注意：run_bash 不在本列表（plan 模式下 run_bash 保留可见，
 * 由 PermissionChecker 的 isWriteBash 在执行前精细判定——
 * 读命令 allow、写命令 deny）。这与 Claude Code 的设计一致：
 * Bash 在 plan 模式可见，靠权限层拦写命令。
 *
 * 注：todo_write 不在内（plan 模式允许维护 TODO，与 Claude Code 一致）；
 *     read_file/glob/grep/load_skill/schedule_list/memory_read/memory_list/idle/read_inbox
 *     均为纯读，也不在内。
 *
 * 注：spawn_agent 不在本列表——plan 模式下可见（支持子代理委派探索），
 *     子代理自身的写操作由 PermissionChecker 硬约束兜底拦截。
 */
export const WRITE_TOOLS = [
  // 文件（Shell 不在此列——见上面 run_bash 的特殊处理）
  'write_file',
  'edit_file',
  // 调度
  'schedule_create',
  'schedule_update',
  'schedule_remove',
  // 任务看板
  'create_task_matrix',
  'mark_task_done',
  'claim_task',
  'task',
  // 后台 / 工作区
  'background',
  'worktree',
  // 记忆
  'memory_write',
  // 团队协作（改变协商/收件箱状态）
  'spawn_teammate',
  'spawn_self_organizing',
  'send_message',
  'shutdown_request',
  'respond_request',
  'submit_plan',
  'approve_plan',
];

/**
 * 只读工具列表
 *
 * 注意：与 tool-registry.ts 的 isReadOnlyTool 保持一致，
 * 避免权限判定与并发分区使用不同标准。
 */
export const READ_ONLY_TOOLS = [
  'read_file',
  'glob',
  'grep',
  'load_skill',
  'todo_write',
  'schedule_list',
];
