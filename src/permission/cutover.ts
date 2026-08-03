// Compatibility Corpus 与 Shadow Cutover（Task 14 / 设计 §10 A83/A85）
//
// 物理本质：auto 权限链的"切换开关"。
//   - enforced（默认）：走新权限链（checker → resolver → classifier → gate）
//   - legacy：只走 checker → gate（不构造 resolver/classifier）
//   - shadow：同时跑新链 candidate 和 legacy，比较差异但始终返回 legacy 结果
//
// 不变量（计划 Step 3）：
//   - authority 只允许 legacy | shadow | enforced；
//   - undefined/空串 → enforced（默认走新权限链）；
//   - 非法显式值 fail-safe 到 enforced（不静默回到会放行的 legacy）；
//   - shadow 记录 disagreement 但最终授权由 legacy 决定；
//   - shadow candidate failure 不能改变或 broaden legacy 结果；
//   - enforced 才允许新链成为 authority。

/** 权限权威模式 */
export type PermissionAuthority = 'legacy' | 'shadow' | 'enforced';

/** 合法 authority 值集合（小写精确匹配） */
const VALID_AUTHORITIES: ReadonlySet<string> = new Set(['legacy', 'shadow', 'enforced']);

/**
 * 解析 AUTO_PERMISSION_AUTHORITY 环境变量（计划 Step 3）。
 *
 * - undefined/空串 → enforced（默认走新权限链）
 * - 显式 'legacy'/'shadow'/'enforced'（trim 后精确匹配）→ 对应值
 * - 任何其他显式值（含大小写错误的 'LEGACY'）→ enforced（fail-safe）
 *
 * fail-safe 语义：非法值不静默回到会直接放行的 legacy，而是回到 enforced。
 */
export function resolveAuthority(envValue: string | undefined): PermissionAuthority {
  if (envValue === undefined || envValue === '') return 'enforced';
  const trimmed = envValue.trim();
  if (VALID_AUTHORITIES.has(trimmed)) return trimmed as PermissionAuthority;
  return 'enforced';
}

/** 简化的决策结果（用于 evaluateAuthority 比较） */
export interface AuthorityDecision {
  readonly behavior: 'allow' | 'deny' | 'ask';
  readonly reason_code: string;
}

/** shadow 观察记录 */
export type AuthorityObservation =
  | { kind: 'permission_disagreement'; legacy: string; candidate: string }
  | { kind: 'candidate_error'; message: string };

/** evaluateAuthority 的输入 */
export interface EvaluateAuthorityInput {
  readonly legacy: AuthorityDecision | Promise<AuthorityDecision>;
  readonly candidate: AuthorityDecision | Promise<AuthorityDecision>;
}

/** evaluateAuthority 的结果 */
export interface EvaluateAuthorityResult {
  readonly authoritative: AuthorityDecision;
  readonly observations: readonly AuthorityObservation[];
}

/**
 * 根据 authority 模式评估 legacy/candidate 决策（A85）。
 *
 * - legacy：不求 candidate，直接返回 legacy（observations 为空）
 * - enforced：返回 candidate（legacy 不参与）
 * - shadow：同时求 legacy 和 candidate，比较差异，始终返回 legacy；
 *   candidate 抛错时记录 candidate_error 但不影响 legacy 结果
 */
export async function evaluateAuthority(
  authority: PermissionAuthority,
  input: EvaluateAuthorityInput,
): Promise<EvaluateAuthorityResult> {
  // legacy：不求 candidate
  if (authority === 'legacy') {
    const legacyDecision = await Promise.resolve(input.legacy);
    return { authoritative: legacyDecision, observations: [] };
  }

  // enforced：返回 candidate
  if (authority === 'enforced') {
    const candidateDecision = await Promise.resolve(input.candidate);
    return { authoritative: candidateDecision, observations: [] };
  }

  // shadow：求 legacy + candidate，比较，返回 legacy
  const observations: AuthorityObservation[] = [];

  // legacy 必须成功（它是权威）
  const legacyDecision = await Promise.resolve(input.legacy);

  // candidate 可能失败（它是观察对象）
  let candidateDecision: AuthorityDecision | undefined;
  try {
    candidateDecision = await Promise.resolve(input.candidate);
  } catch (err) {
    observations.push({
      kind: 'candidate_error',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 如果 candidate 成功且与 legacy 不一致，记录 disagreement
  if (candidateDecision !== undefined) {
    if (candidateDecision.behavior !== legacyDecision.behavior) {
      observations.push({
        kind: 'permission_disagreement',
        legacy: legacyDecision.behavior,
        candidate: candidateDecision.behavior,
      });
    }
  }

  // 始终返回 legacy 结果（A85：shadow 的最终授权由 legacy 决定）
  return { authoritative: legacyDecision, observations };
}
