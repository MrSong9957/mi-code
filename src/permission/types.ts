// 权限系统类型定义

/** 权限模式 */
export type PermissionMode = 'default' | 'plan' | 'auto';

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

/** 权限决策结果 */
export interface PermissionDecision {
  behavior: PermissionBehavior;
  reason: string;
}

/** 写操作工具列表（改变系统状态） */
export const WRITE_TOOLS = ['write_file', 'edit_file', 'run_bash', 'schedule_create', 'schedule_remove'];

/**
 * 只读工具列表
 *
 * 注意：与 tool-registry.ts 的 isReadOnlyTool 保持一致，
 * 避免权限判定与并发分区使用不同标准。
 */
export const READ_ONLY_TOOLS = [
  'read_file',
  'load_skill',
  'todo_write',
  'schedule_list',
  'glob',
  'ls',
];
