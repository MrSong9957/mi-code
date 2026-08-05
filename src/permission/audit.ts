// 脱敏权限审计（Task 13 / 设计 §9、§10 A86-A87）
//
// 物理本质：权限决策的"脱敏信访记录簿"。
//   每个最终 permission decision 恰好产生一个 result audit event。
//   事件只记录 allowlist 字段，禁止 command/raw path/file content/classifier prompt。
//
// 不变量（设计 §9 audit）：
//   - 字段严格 allowlist：decisionId、toolName、behavior、reasonCode、source、latencyBucket、phase；
//   - latency 分桶（不记录精确毫秒，避免通过时间侧信道泄漏内容长度）；
//   - audit/observer 异常不改变授权结果，只留下脱敏本地诊断；
//   - result fan-out 放在 RuntimeSecurityGate 的最终决定出口，避免重复记录。

/**
 * 权限审计事件（设计 §9 allowlist）。
 *
 * 字段固定为 7 个，不多不少：
 *   - decisionId：SecurityDecision.decision_id（脱敏标识符）
 *   - toolName：canonical tool name（如 write_file/run_bash）
 *   - behavior：最终行为 allow/deny
 *   - reasonCode：decision reason code（如 auto.allowlist / command.dangerous）
 *   - source：决策来源（checker/resolver/classifier/session/gate）
 *   - latencyBucket：延迟桶（<10ms / 10-100ms / 100-1000ms / 1s-10s / >10s）
 *   - phase：事件阶段（固定 'result'，表示最终决定出口）
 *
 * 禁止字段：command、content、path、classifierPrompt、humanReason（含敏感细节）。
 */
export interface PermissionAuditEvent {
  readonly decisionId: string;
  readonly toolName: string;
  readonly behavior: 'allow' | 'deny';
  readonly reasonCode: string;
  readonly source: string;
  readonly latencyBucket: string;
  readonly phase: 'result';
}

/**
 * 审计 sink 回调。接收 PermissionAuditEvent，异常被调用方静默吞掉。
 */
export type PermissionAuditSink = (event: PermissionAuditEvent) => void;

/**
 * 构造审计事件的输入。
 * 可能包含敏感字段（command/path/content/classifierPrompt），
 * 但 buildAuditEvent 只提取 allowlist 字段，丢弃其余。
 */
export interface PermissionDecisionInput {
  readonly decisionId: string;
  readonly toolName: string;
  readonly behavior: 'allow' | 'deny';
  readonly reasonCode: string;
  readonly source: string;
  readonly latencyMs: number;
  // 以下字段可能存在但绝不进入事件（设计 §9 禁止）
  readonly command?: string;
  readonly path?: string;
  readonly content?: string;
  readonly classifierPrompt?: string;
}

/**
 * 把毫秒延迟分桶（设计 §9：latency bucket）。
 * 分桶避免精确延迟泄漏内容长度等侧信道信息。
 *
 * 桶：<10ms / 10-100ms / 100-1000ms / 1s-10s / >10s
 */
export function toLatencyBucket(ms: number): string {
  if (ms < 10) return '<10ms';
  if (ms < 100) return '10-100ms';
  if (ms < 1000) return '100-1000ms';
  if (ms < 10000) return '1s-10s';
  return '>10s';
}

/**
 * 从决策输入构造脱敏审计事件（A87）。
 *
 * 只提取 allowlist 字段，丢弃 command/path/content/classifierPrompt。
 * 返回 frozen 对象，字段恰好 7 个。
 */
export function buildAuditEvent(input: PermissionDecisionInput): PermissionAuditEvent {
  return Object.freeze({
    decisionId: input.decisionId,
    toolName: input.toolName,
    behavior: input.behavior,
    reasonCode: input.reasonCode,
    source: input.source,
    latencyBucket: toLatencyBucket(input.latencyMs),
    phase: 'result' as const,
  });
}

/**
 * 便捷函数：构造事件并写入 sink（A86）。
 * sink 异常被静默吞掉（不改变授权结果）。
 */
export function logPermissionDecision(
  input: PermissionDecisionInput,
  sink: PermissionAuditSink,
): void {
  const event = buildAuditEvent(input);
  try {
    sink(event);
  } catch {
    // 静默吞掉：audit 异常不改变授权结果（设计 §9）
  }
}
