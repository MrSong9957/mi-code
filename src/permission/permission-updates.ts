// 单一 PermissionUpdate 状态变换与危险 allow 分区（Task 2 / A17-A19、A32、A64、A88）
//
// 物理本质：权限规则状态的“唯一记账台”。
//   - applyPermissionUpdate：唯一允许改变 { rules, mode, strippedDangerousRules } 的入口。
//     add/remove/replace/reload/setMode 都只经此函数；SessionState/ConfigStore 不得复制其逻辑。
//   - isDangerousAllowRule：危险 allow 判定的唯一真相源（设计 §3.1）。auto dangerous stash
//     的进入/退出/add/remove/replace/reload/resume/repartition 全部只调用该函数，
//     不得在 SessionState、配置层或 resolver 维护第二套命令表、正则或例外。
//   - partitionDangerousAllows：把 auto 模式下的危险 allow 从 visible 规则分区到 stash。
//
// 数据模型：复用既有 { tool, behavior, path?, content? }（types.ts PermissionRule）。
// 设计 §3 的 AutoPermissionState.denial 在 SessionState 内维护，本模块只管规则快照。
//
// 不变量：
//   - applyPermissionUpdate 不修改输入 snapshot/rules，返回新的 frozen snapshot；
//   - 非 auto 模式不分区（危险 allow 留 visible，stash 为空）；
//   - auto 模式下危险 allow 必在 stash、不在 visible；退出 auto 时仍在 stash 的回 visible；
//   - remove 同步删 visible + stash（禁止权限复活）。

import type { PermissionRule, PermissionMode } from './types.js';
import { normalizePermissionToolName, hasUnescapedStar } from './rules.js';

/** 权限快照：某时刻的规则集合 + 模式 + 危险 stash。frozen。 */
export interface PermissionSnapshot {
  readonly mode: PermissionMode;
  readonly rules: readonly PermissionRule[];
  readonly strippedDangerousRules: readonly PermissionRule[];
}

/**
 * PermissionUpdate：唯一状态变换指令。
 * SessionState.applyPermissionUpdate / ConfigStore.persistPermissionUpdate 都只产生并消费它。
 */
export type PermissionUpdate =
  | { kind: 'setMode'; mode: PermissionMode }
  | { kind: 'addRule'; rule: PermissionRule }
  | { kind: 'removeRule'; rule: PermissionRule }
  | { kind: 'replaceRules'; rules: PermissionRule[] };

// ─── isDangerousAllowRule：危险 allow 唯一判定（设计 §3.1）──────────────────────

/**
 * 危险 shell/interpreter/runner 可执行文件集合（设计 §3.1.5）。
 * 判定前先去前置环境变量赋值，提取首个可执行文件；Windows 下大小写不敏感并去 `.exe`。
 */
const DANGEROUS_EXECUTABLES = new Set([
  // shell / interpreter
  'sh', 'bash', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd',
  'python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'osascript',
  // runner / indirect executor
  'npx', 'npm', 'pnpm', 'yarn', 'bunx', 'uv', 'pipx', 'xargs', 'env', 'make', 'just', 'task',
  'docker', 'podman', 'kubectl',
]);

/**
 * 从 run_bash content（exact 规则）提取首个可执行文件名。
 * 先去前置环境变量赋值（`KEY=val KEY2=val2 cmd ...`），再取首个 token。
 * 返回小写、去 `.exe` 的可执行名（用于集合查找）。
 */
function extractExecutable(content: string): string {
  // 去前置环境变量赋值：连续的 IDENT=VALUE 形式，遇到第一个非赋值 token 停止
  // 简化实现：逐 token 扫描，跳过 `IDENT=...` 形式
  const tokens = content.trim().split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok.slice(0, eq))) {
      // 环境变量赋值，跳过
      continue;
    }
    // 首个非赋值 token：取可执行名（去路径前缀）
    const basename = tok.replace(/^.*[/\\]/, '');
    // Windows：去 .exe（大小写不敏感由 toLower 统一）
    return basename.replace(/\.exe$/i, '').toLowerCase();
  }
  return '';
}

/**
 * 判断一条 allow 规则是否危险（设计 §3.1 唯一真相源）。
 *
 * 判定顺序：
 * 1. 非 allow 规则 -> 不危险（只对 allow 分区）。
 * 2. canonicalize tool id（Task/Agent/AgentTool -> spawn_agent）。
 * 3. 全局 tool allow `*` -> 危险。
 * 4. canonical spawn_agent 任意 allow（裸/具体/wildcard）-> 危险。
 * 5. canonical run_bash：
 *    a. 裸 allow（无 content）-> 危险；
 *    b. content 含未转义 wildcard（含 legacy `:*`）-> 危险（不尝试证明窄化安全）；
 *    c. exact content：提取首个可执行文件，若属于危险 shell/interpreter/runner -> 危险；
 *    d. 其他 exact run_bash（如精确 `git status`）-> 不危险。
 * 6. 其他 canonical tool 的 exact allow -> 不危险。
 *
 * 注意：转义星 `\*` 是字面量，不算未转义 wildcard。
 */
export function isDangerousAllowRule(rule: PermissionRule): boolean {
  if (rule.behavior !== 'allow') return false;
  const tool = normalizePermissionToolName(rule.tool);

  // 3. 全局 allow `*`
  if (tool === '*') return true;

  // 4. spawn_agent 任意 allow
  if (tool === 'spawn_agent') return true;

  // 5. run_bash
  if (tool === 'run_bash') {
    // 5a. 裸 allow
    if (rule.content === undefined) return true;
    // 5b. legacy prefix wildcard `:*` 或未转义 `*`
    if (rule.content.endsWith(':*') || hasUnescapedStar(rule.content)) return true;
    // 5c. exact content：提取可执行文件
    const exe = extractExecutable(rule.content);
    if (exe && DANGEROUS_EXECUTABLES.has(exe)) return true;
    // 5d. 其他 exact run_bash
    return false;
  }

  // 6. 其他 tool exact allow
  return false;
}

/**
 * 把 auto 模式下的危险 allow 从 rules 分区到 stash（设计 §3.1 / A17）。
 * 非 auto 模式不分区。返回新的 frozen { visible, stash }。
 */
export function partitionDangerousAllows(
  rules: readonly PermissionRule[],
  mode: PermissionMode,
): { visible: readonly PermissionRule[]; stash: readonly PermissionRule[] } {
  if (mode !== 'auto') {
    return { visible: rules, stash: [] };
  }
  const visible: PermissionRule[] = [];
  const stash: PermissionRule[] = [];
  for (const r of rules) {
    if (isDangerousAllowRule(r)) stash.push(r);
    else visible.push(r);
  }
  return { visible, stash };
}

// ─── applyPermissionUpdate：唯一状态变换 ────────────────────────────────────────

/** 规则深比较（结构化相等，用于 remove 匹配） */
function ruleEqual(a: PermissionRule, b: PermissionRule): boolean {
  return (
    a.tool === b.tool &&
    a.behavior === b.behavior &&
    a.path === b.path &&
    a.content === b.content
  );
}

/** freeze 快照（浅 freeze + 两个数组 freeze）。入参用 readonly，因 freeze 不修改数组。 */
function freezeSnapshot(snap: {
  mode: PermissionMode;
  rules: readonly PermissionRule[];
  strippedDangerousRules: readonly PermissionRule[];
}): PermissionSnapshot {
  Object.freeze(snap.rules);
  Object.freeze(snap.strippedDangerousRules);
  return Object.freeze(snap) as PermissionSnapshot;
}

/**
 * 唯一状态变换：对 snapshot 应用 update，返回新的 frozen snapshot。
 *
 * 语义：
 *   - setMode：切换 mode；进入 auto 时把 visible 中的危险 allow 分区到 stash；
 *     退出 auto 时把 stash 合并回 visible（按当前 stash，不复活已删除规则）。
 *   - addRule：加入规则；auto 模式下危险 allow 进 stash，其余进 visible。
 *   - removeRule：从 visible + stash 同步删除匹配规则（禁止复活）。
 *   - replaceRules：清空全部 rules + stash，重新装入并按当前 mode 分区（reload 走此语义）。
 *
 * 不修改输入；返回新 frozen 对象。
 */
export function applyPermissionUpdate(
  snapshot: PermissionSnapshot,
  update: PermissionUpdate,
): PermissionSnapshot {
  switch (update.kind) {
    case 'setMode': {
      if (update.mode === snapshot.mode) {
        // 同 mode：原样返回（冻结的同一对象）
        return snapshot;
      }
      if (update.mode === 'auto') {
        // 进入 auto：把 visible 中的危险 allow 分区到 stash（与已有 stash 合并）
        const visible = snapshot.rules.filter((r) => !isDangerousAllowRule(r));
        const newStash = [
          ...snapshot.rules.filter((r) => isDangerousAllowRule(r)),
          ...snapshot.strippedDangerousRules,
        ];
        return freezeSnapshot({ mode: 'auto', rules: visible, strippedDangerousRules: newStash });
      }
      // 退出 auto：把 stash 合并回 visible
      const merged = [...snapshot.rules, ...snapshot.strippedDangerousRules];
      return freezeSnapshot({ mode: update.mode, rules: merged, strippedDangerousRules: [] });
    }

    case 'addRule': {
      const rule = update.rule;
      if (snapshot.mode === 'auto' && isDangerousAllowRule(rule)) {
        // auto + 危险 allow -> 进 stash（避免重复）
        const inStash = snapshot.strippedDangerousRules.some((r) => ruleEqual(r, rule));
        if (inStash) return snapshot;
        return freezeSnapshot({
          mode: snapshot.mode,
          rules: snapshot.rules,
          strippedDangerousRules: [...snapshot.strippedDangerousRules, rule],
        });
      }
      // 非 auto 或非危险 -> 进 visible
      const inVisible = snapshot.rules.some((r) => ruleEqual(r, rule));
      if (inVisible) return snapshot;
      return freezeSnapshot({
        mode: snapshot.mode,
        rules: [...snapshot.rules, rule],
        strippedDangerousRules: snapshot.strippedDangerousRules,
      });
    }

    case 'removeRule': {
      const rule = update.rule;
      // 同步从 visible + stash 删除（禁止复活）
      const newVisible = snapshot.rules.filter((r) => !ruleEqual(r, rule));
      const newStash = snapshot.strippedDangerousRules.filter((r) => !ruleEqual(r, rule));
      // 无变化则原样返回
      if (
        newVisible.length === snapshot.rules.length &&
        newStash.length === snapshot.strippedDangerousRules.length
      ) {
        return snapshot;
      }
      return freezeSnapshot({
        mode: snapshot.mode,
        rules: newVisible,
        strippedDangerousRules: newStash,
      });
    }

    case 'replaceRules': {
      // 清空全部 + 重新装入并按当前 mode 分区
      const { visible, stash } = partitionDangerousAllows(update.rules, snapshot.mode);
      return freezeSnapshot({
        mode: snapshot.mode,
        rules: [...visible],
        strippedDangerousRules: [...stash],
      });
    }
  }
}
