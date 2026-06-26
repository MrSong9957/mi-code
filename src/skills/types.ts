// 技能系统类型定义

/** 技能轻量元信息（放进 system prompt） */
export interface SkillManifest {
  name: string;
  description: string;
  /** 条件激活：文件模式列表，匹配时自动激活 */
  paths?: string[];
  /** 隔离上下文：'fork' 表示在子代理中运行 */
  context?: 'fork' | 'main';
  /** 工具白名单：限制该技能可用的工具 */
  allowedTools?: string[];
  /** 技能来源 */
  source?: 'builtin' | 'user' | 'project' | 'mcp';
  /** 加载确认：'need-confirm' 表示需要用户确认才返回全文 */
  loadConfirmation?: 'need-confirm';
}

/** 技能完整文档 */
export interface SkillDocument {
  manifest: SkillManifest;
  body: string;
}

/** 技能使用状态（per-user, per-skill） */
export interface SkillUsageState {
  used: boolean;
  skip: boolean;
  blocked: boolean;
  loadConfirmation?: 'need-confirm';
  triggeredBy?: { confidence: number };
}

/** 技能上下文（S10 协议：受控字典） */
export interface SkillContext {
  /** 是否必须加载（不可跳过） */
  required?: boolean;
  /** 推荐加载（可跳过但不推荐） */
  recommended?: boolean;
  /** 工具白名单 */
  allowedTools?: string[];
  /** 作用范围 */
  scope?: 'session' | 'global';
  /** 是否需要确认 */
  loadConfirmation?: 'need-confirm';
}

/** 元数据 Schema 验证定义 */
export const META_SCHEMAS = {
  'controlled-validation': {
    required: ['name', 'description'],
    optional: ['paths', 'context', 'allowedTools', 'source', 'loadConfirmation'],
  },
  'trigger-matching': {
    required: ['name', 'description'],
    optional: ['paths'],
  },
} as const;
