# Test Timeout Hardening 验证

> 计划: `docs/superpowers/plans/2026-07-31-test-timeout-hardening.md`
> spec: `docs/superpowers/specs/2026-07-31-test-timeout-hardening-design.md`
> 分支: `codex/test-timeout-hardening`（隔离 worktree，基于干净 master `2673ab0`）
> 日期: 2026-07-31

## 提交清单（3 个独立提交）

| 提交 | 改动 |
|------|------|
| `32b3a58` test: add global testTimeout/hookTimeout fallback | vitest.config.ts 全局 10000/10000 |
| `6941361` test: raise history seq-stress case timeout to 30s | history "同毫秒" 用例 per-test 30000 |
| `aaf3862` test: raise bootstrap-flag cases timeout to 15s | bootstrap-flag 3 用例 per-test 15000 |

## 验证证据

### 1. 连续 3 次全量稳定性（核心验收标准）

| Run | history.test.ts | bootstrap-flag.test.tsx | 全量其他 |
|-----|-----------------|------------------------|---------|
| 补充跑 | ✓ 29 tests (2434ms) | ✓ 3 tests (5983ms) | 1 failed（非目标 flaky） |
| Run 2 | ✓ 29 tests (2497ms) | ✓ 3 tests (5788ms) | 1 failed（非目标 flaky） |
| Run 3 | ✓ 29 tests（文件总 38955ms） | ✓ 3 tests (10424ms) | 全绿 297 passed |

两个目标文件在 3 次全量中全部不超时、全部通过。符合 spec 验收标准。

### 2. typecheck

```
npm run typecheck → exit 0
```

### 3. 范围检查

```
git diff master...HEAD --name-only → 3 个文件：
  vitest.config.ts
  src/__tests__/history.test.ts
  src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx
git status --short → 工作树干净
```

不含 prompt 文件或 ai-news-2026-07.html。

## 关键观察

- **history Run 3 文件总耗时 38955ms**：是 29 个用例的累计，非单用例。单用例有 30s 上限，3 次均在限内通过。说明全量负载极高时该文件整体变慢，但 per-test 30s 足以覆盖最重的"同毫秒"用例。
- **bootstrap-flag 单跑 inline 用例 5463ms**（修复后实测）：之前在默认 5s 下超时，15s 余量下稳定通过，直接验证修复有效。
- **其他 flaky（child-env-scrub 等）偶发失败**：3 次中有 2 次出现 1 failed（非目标文件），属 spec 明确的"不阻塞验收"范围，是独立的后续工作。

## 与 spec 的一致性

- 全局 testTimeout/hookTimeout = 10000 ✓
- history per-test = 30000 ✓
- bootstrap per-test = 15000 ✓
- 未引入 retry / vi.mock ✓
- 未改 history.ts 业务逻辑 / 20 轮循环 / seq tiebreaker ✓
