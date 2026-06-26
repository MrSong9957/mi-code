// 命令解析器：解析斜杠命令和 ! 拦截前缀

export interface Command {
  name: string;
  args: string[];
}

/** 拦截请求 */
export interface BlockRequest {
  skillName: string;
}

/** 解析斜杠命令，非命令返回 null */
export function parseCommand(input: string): Command | null {
  if (!input.startsWith('/')) return null;
  const parts = input.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { name: parts[0]!, args: parts.slice(1) };
}

/**
 * 解析 ! 前缀拦截命令
 *
 * 支持格式：
 *   !skill_name          → 拦截 skill_name
 *   !trigger skill_name  → 拦截 skill_name
 *   !load_skill name     → 拦截 name
 *
 * 非拦截输入返回 null
 */
export function parseBlockPrefix(input: string): BlockRequest | null {
  if (!input.startsWith('!')) return null;
  const rest = input.slice(1).trim();
  if (!rest) return null;

  // !trigger <name> 或 !load_skill <name>
  if (rest.startsWith('trigger ') || rest.startsWith('load_skill ')) {
    const skillName = rest.split(/\s+/)[1]?.trim();
    return skillName ? { skillName } : null;
  }

  // !<skill_name>
  return { skillName: rest.split(/\s+/)[0]! };
}
