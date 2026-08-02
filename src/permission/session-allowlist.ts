// 主 Agent session 级 exact-match 授权缓存。
// key = toolName + NUL + JSON.stringify(input),完整结构化输入精确表示。
// 安全边界:只做查表,不做安全判定。调用方必须在 PermissionChecker 完整执行后查本表,
// 且只能覆盖 build_write_confirmation ask。deny/safety_uncertain 永远到不了这里。

export function sessionAllowlistKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}\u0000${JSON.stringify(input)}`;
}

export class SessionAllowlist {
  private readonly entries = new Map<string, { toolName: string; addedAt: number }>();

  has(toolName: string, input: Record<string, unknown>): boolean {
    return this.entries.has(sessionAllowlistKey(toolName, input));
  }

  add(toolName: string, input: Record<string, unknown>): void {
    this.entries.set(sessionAllowlistKey(toolName, input), { toolName, addedAt: Date.now() });
  }

  clear(): void {
    this.entries.clear();
  }
}
