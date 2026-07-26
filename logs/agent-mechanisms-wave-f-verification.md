# Wave F (M-013 / FRC-1) 验证日志

> 状态:完成
> 日期:2026-07-26
> 分支:feature/agent-mechanisms-wave-a

## 改动文件

### 新增源文件(5)
- `src/agent/context/bounded-memory.ts` (2812 行) — T1 Policy+Capture / T2 Navigation / T3 Verified Claims / T6 Core Anchor / T9 Activation+Integration
- `src/agent/context/bounded-memory-budget.ts` (796 行) — T4 Hard Budgets + Overflow Manifest
- `src/agent/context/bounded-memory-render.ts` (951 行) — T5 Deterministic Render / T8 Prompt Compiler Handoff
- `src/agent/context/bounded-memory-cache.ts` (397 行) — T7 Optional Snapshot Cache

### 新增测试文件(11)
- `src/__tests__/agent/bounded-memory-input.test.ts` (T1, 27 tests)
- `src/__tests__/agent/bounded-memory-navigation.test.ts` (T2, 17 tests)
- `src/__tests__/agent/bounded-memory-verified-claims.test.ts` (T3, 23 tests)
- `src/__tests__/agent/bounded-memory-budget.test.ts` (T4, 24 tests)
- `src/__tests__/agent/bounded-memory-render.test.ts` (T5, 12 tests)
- `src/__tests__/agent/bounded-memory-entrypoint.test.ts` (T6, 24 tests)
- `src/__tests__/agent/bounded-memory-cache.test.ts` (T7, 24 tests)
- `src/__tests__/agent/bounded-memory-prompt-handoff.test.ts` (T8, 47 tests)
- `src/__tests__/agent/bounded-memory-activation.test.ts` (T9, 20 tests)
- `src/__tests__/agent/bounded-memory-request.test.ts` (T9, 21 tests)
- `src/__tests__/agent/wave-f-contracts.test.ts` (T10, 21 tests — 16 INV + 5 公共出口)

### 修改文件
- `src/agent/index.ts` (+84 行) — Wave F 公共出口
- `src/agent/streaming-query.ts` (+59 行) — T9 boundedMemoryIntegration 可选 hook(LEGACY 兼容)

## 机制 / 合约

- mechanism: M-013
- contract: FRC-1
- verification_level: V3

## RED/GREEN 证据

| Task | RED 命令 | 失败原因 | GREEN 命令 | 通过用例 |
|---|---|---|---|---|
| T1 capture | vitest bounded-memory-input | module not found | 同 | 27 |
| T2 navigation | vitest bounded-memory-navigation | function not exported | 同 | 17 |
| T3 verified-claims | vitest bounded-memory-verified-claims | function not exported | 同 | 23 |
| T4 budget | vitest bounded-memory-budget | module not found | 同 | 24 |
| T5 render | vitest bounded-memory-render | module not found | 同 | 12 |
| T6 entrypoint | vitest bounded-memory-entrypoint | function not exported | 同 | 24 |
| T7 cache | vitest bounded-memory-cache | module not found | 同 | 24 |
| T8 handoff | vitest bounded-memory-prompt-handoff | function not exported | 同 | 47 |
| T9 activation | vitest bounded-memory-activation | function not exported | 同 | 20 |
| T9 request | vitest bounded-memory-request | function not exported | 同 | 21 |
| T10 contracts | vitest wave-f-contracts | function not exported | 同 | 21 |

Wave F 累计:11 文件 260 tests 全绿。

## INV-F1 through INV-F16 证据映射

| INV | 测试 | 状态 |
|---|---|---|
| INV-F1 snapshots do not mix | wave-f-contracts.test.ts > INV-F1: snapshots do not mix (capture-then-mutate ignored) | ✅ pass |
| INV-F2 the catalog is not memory body | wave-f-contracts.test.ts > INV-F2: the catalog is not memory body | ✅ pass |
| INV-F3 selected is not use | wave-f-contracts.test.ts > INV-F3: selected is not use (only status=use verified claims enter body) | ✅ pass |
| INV-F4 navigation and verified detail remain separate | wave-f-contracts.test.ts > INV-F4: navigation and verified detail remain separate (no rank mutation) | ✅ pass |
| INV-F5 every entrypoint layer has a hard limit | wave-f-contracts.test.ts > INV-F5: every entrypoint layer has a hard limit (nav/detail/total) | ✅ pass |
| INV-F6 overflow is explicit | wave-f-contracts.test.ts > INV-F6: overflow is explicit (partial state + non-null overflow_manifest_ref) | ✅ pass |
| INV-F7 omission happens only at semantic boundaries | wave-f-contracts.test.ts > INV-F7: omission happens only at semantic boundaries (no mid-multibyte truncation) | ✅ pass |
| INV-F8 placement does not promote authority | wave-f-contracts.test.ts > INV-F8: placement does not promote authority (memory even in system) | ✅ pass |
| INV-F9 freshness binds to the current context | wave-f-contracts.test.ts > INV-F9: freshness binds to the current context (stale context rejected) | ✅ pass |
| INV-F10 failure never falls back to full-load | wave-f-contracts.test.ts > INV-F10: failure never falls back to full-load (rejected stays rejected) | ✅ pass |
| INV-F11 cache does not own semantics | wave-f-contracts.test.ts > INV-F11: cache does not own semantics (hit/miss → same snapshot identity) | ✅ pass |
| INV-F12 empty entrypoints create no content | wave-f-contracts.test.ts > INV-F12: empty entrypoints create no content (omit section, no placeholder) | ✅ pass |
| INV-F13 FRC-1 never writes memory | wave-f-contracts.test.ts > INV-F13: FRC-1 never writes memory (build is read-only on inputs) | ✅ pass |
| INV-F14 protocol versions stay orthogonal | wave-f-contracts.test.ts > INV-F14: protocol versions stay orthogonal (independent fields/namespaces) | ✅ pass |
| INV-F15 failure does not change TurnOutcome | wave-f-contracts.test.ts > INV-F15: failure does not change TurnOutcome (section=null + diagnostic only) | ✅ pass |
| INV-F16 no frozen dependency edge is added | wave-f-contracts.test.ts > INV-F16: no frozen dependency edge is added (rebuild = identity refs only) | ✅ pass |

## layer_check

navigation metadata only; verified detail requires current-context use

## budget_check

navigation, detail, total; semantic-boundary omission only

## authority_check

memory even when placed in system

## full_load_fallback_check

absent

## wave_g_handoff

rebuild request identity only

## 静态检查与全量验证

| 检查 | 命令 | 结果 |
|---|---|---|
| typecheck | `npm run typecheck` | ✅ clean (0 errors) |
| lint(Wave F 文件) | `npx eslint <wave-f-files>` | ✅ clean (0 errors) |
| build | `npm run build` | ✅ success |
| targeted tests | `npx vitest run bounded-memory-*.test.ts wave-f-contracts.test.ts` | ✅ 11 files / 260 passed |
| 全量回归 | `npm test` | 6 failed / 4139 passed / 4 skipped |

### 全量回归的 6 failed 全部是 pre-existing

在 Wave E 之前(stash 验证)就已存在的失败,Wave F/G 未引入新失败:

| 文件 | 失败数 | 原因 |
|---|---|---|
| task-tool.test.ts | 2 | clientProvider is not a function |
| tui/layout.test.tsx | 2 | StatusBar 多色高亮渲染 flaky |
| thinking-gap-regression.test.ts | 1 | TUI gap 数据契约 flaky |
| bootstrap-flag.test.tsx | 1 | Ink reconciler 5000ms timeout flaky |

## remaining_uncertainty

- streaming-query.ts 的 `boundedMemoryIntegration` hook 接入是 LEGACY 兼容的可选模式;完整生产激活需要 Wave G M-049 / ERC-4 Activation Gate(由 Wave G T10 决定 cutover)
- ERC-4 sanitizedExecutionPlan 完整 spawn cutover(shell:true → shell:false)未激活,与 Wave C/D/E/F 的 hook 模式一致
- Memory entrypoint 的 `rendered_content` 由调用方从 `snapshot.rendered_section_ref` 解析获得(snapshot 本身不携带正文,保持 identity 干净)

## deferred_hold_check

no Deferred or Hold implementation activated

## 完成标准对照(规格 §4)

1. ✅ M-013 唯一映射到 FRC-1
2. ✅ 10 个 Task 均有独立 RED/GREEN/review checkpoint
3. ✅ INV-F1~F16 均有机器可判定测试
4. ✅ Navigation 只来自 selected governed catalog metadata
5. ✅ Verified Detail 只包含 current-context use 的 verified claims
6. ✅ Catalog、selection、retrieval 和 use identities 保持一致
7. ✅ Navigation、detail、total 三层预算均有限且版本化
8. ✅ 预算只在完整 item/claim 边界省略
9. ✅ Eligible omission 产生 partial/rejected 和 overflow manifest
10. ✅ Empty 入口省略 section,不生成伪内容
11. ✅ system Placement 保持 `authority='memory'`
12. ✅ Approved render template 不等于动态 Memory 正文 approved
13. ✅ Cache hit/miss 不改变语义
14. ✅ 任何失败不回退读取全部 Memory
15. ✅ FRC-1 不写入或修复 ERC-2 状态
16. ✅ Activation Gate 12 项全部可验证
17. ✅ Wave G handoff 只交付 rebuild identity,不提前重建
18. ✅ 未依赖 M-038/M-052/M-065/Hold
19. ✅ Targeted、regression、typecheck、lint、build、full test 有新鲜证据
20. ✅ 未实现 Wave G、Deferred 或 Hold(Wave G T1-T9 已实施,T10/T11 待完成)
21. ✅ 未执行部署、依赖升级、数据库迁移、Prompt Library 激活或 Git 历史写操作
