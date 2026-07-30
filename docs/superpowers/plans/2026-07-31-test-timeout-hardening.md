# Test Timeout Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除全量 `npm test` 中 history / bootstrap-flag 两个测试在高 IO 负载下的超时 flaky，通过分层 timeout 治理（全局兜底 + 重 IO/冷启动用例 per-test 覆盖）让它们在全量跑中稳定通过。

**Architecture:** 纯配置改动，零业务逻辑修改。根因是高负载下的耗时膨胀（非 env 竞争、非隔离缺陷、非逻辑 bug），所以治超时而非改测试设计或引入 mock。分三层：`vitest.config.ts` 全局 `testTimeout`/`hookTimeout` 兜底 → history 重 IO 用例 per-test 30s → bootstrap-flag 冷启动用例 per-test 15s。参考本仓库已验证模式：`child-process-env-scrub.test.ts` 用 15s per-test timeout 保持稳定。

**Tech Stack:** Vitest 3.x、TypeScript、Node.js、Git Bash（Windows）

## Global Constraints

- 从干净的 `master`（当前 `9dc8294`）创建隔离 worktree 和 `codex/test-timeout-hardening` 分支；不要在带未提交改动的工作区直接执行。
- 不修改 `src/history.ts` 业务逻辑——seq tiebreaker 实现正确，单跑 20 次全绿已证明。
- 不引入 vitest retry / flaky 容忍机制——根因是确定性超时，retry 只会掩盖。
- 不用 `vi.mock` 砍 bootstrap 模块图——该测试目的是验证真实启动不崩，mock 会摧毁其价值。
- 不改 history 的 20 轮循环设计——循环有意放大同毫秒概率以验证 seq tiebreaker。
- 不修改三个 prompt 文件或 `ai-news-2026-07.html`。
- 每个任务独立提交。
- 本计划的"RED 证据"与传统 TDD 不同：纯配置改动无新逻辑可写失败单元测试，故 RED = "全量跑目标文件出现超时失败"，GREEN = "加 timeout 后全量跑该文件不超时"。不要为 timeout 配置编写额外的行为测试——那属于测实现细节。

## Baseline and Success Criteria

当前基线（已在 spec 诊断阶段证实）：

```text
history.test.ts 全量跑：1 failed（"同毫秒 seq" 用例 Test timed out in 5000ms，5048ms）
history.test.ts 单跑：1089ms（PASS，20/20 稳定）
bootstrap-flag.test.tsx 单跑：inline 用例 5021ms（偶发超时失败），alt-screen 1423ms，env 用例 421ms
vitest.config.ts：无 testTimeout / hookTimeout（默认 5000ms）
```

本计划完成后：

```text
连续 3 次全量 npm test：
  - src/__tests__/history.test.ts：0 超时失败
  - src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx：0 超时失败
  - 其他已知 flaky（如 child-process-env-scrub）的偶发失败不阻塞本轮验收
npm run typecheck：通过
```

---

### Task 1: vitest 全局 testTimeout / hookTimeout 兜底

**Files:**
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: Vitest `defineConfig({ test: { ... } })`
- Produces: 全局 `testTimeout: 10000`、`hookTimeout: 10000`，作为所有未显式设置 timeout 的测试/hook 的兜底

- [ ] **Step 1: 确认当前配置无 timeout 设置（基线）**

Run:

```bash
grep -nE "testTimeout|hookTimeout" vitest.config.ts
```

Expected: 无输出（当前未设置任何 timeout）。

- [ ] **Step 2: 添加全局 testTimeout 和 hookTimeout**

在 `vitest.config.ts` 的 `test: { ... }` 块内，`env` 字段之后，添加两个 timeout 字段。把：

```ts
    // 启用 ANSI 颜色输出，以便测试可以验证 ink 组件的颜色渲染
    env: {
      FORCE_COLOR: '1',
    },
  },
```

改为：

```ts
    // 启用 ANSI 颜色输出，以便测试可以验证 ink 组件的颜色渲染
    env: {
      FORCE_COLOR: '1',
    },
    // 高负载下默认 5000ms 不足：history 全量跑实测耗时膨胀至 5s 量级触发超时。
    // 10s 作为全局兜底，覆盖未显式设置 timeout 的测试；重 IO/冷启动用例由 per-test 覆盖更高值。
    testTimeout: 10000,
    // 预防性设置：本轮未观察到 hook 超时失败（三个 flaky 全部是 testTimeout），
    // 但 history 的 beforeEach 含 mkdirSync + writeFileSync，极端负载下存在同类风险，成本为零。
    hookTimeout: 10000,
  },
```

- [ ] **Step 3: 确认配置语法正确（typecheck + 单跑一个文件不报错）**

Run:

```bash
npm run typecheck
```

Expected: exit code 0。

Run:

```bash
npx vitest run src/__tests__/history.test.ts 2>&1 | tail -3
```

Expected: `1 passed`（配置加载正常，单跑仍通过——全局 10s 兜底对单跑无影响）。

- [ ] **Step 4: 提交**

```bash
git add -- vitest.config.ts
git commit -m "test: add global testTimeout/hookTimeout fallback"
```

---

### Task 2: history 重 IO 用例 per-test timeout

**Files:**
- Modify: `src/__tests__/history.test.ts:130-149`

**Interfaces:**
- Consumes: Vitest `it(name, fn, timeout)` 第三参数
- Produces: "同毫秒 seq tiebreaker" 用例获得 30s per-test timeout，覆盖 20 轮磁盘 IO 在高负载下的累积耗时

- [ ] **Step 1: 确认目标用例当前无 timeout 参数（基线）**

Run:

```bash
sed -n '130,149p' src/__tests__/history.test.ts
```

Expected: 用例以 `})` 闭合（第 149 行），无第三参数 timeout。

- [ ] **Step 2: 给用例加 30s per-test timeout**

把 `src/__tests__/history.test.ts` 中的：

```ts
        rmSync(tdir, { recursive: true, force: true })
      }
    })
```

改为：

```ts
        rmSync(tdir, { recursive: true, force: true })
      }
      // 20 轮 × (mkdtemp + 3×appendFile + readFile + rmSync) = 100+ 次真实磁盘 IO。
      // 单跑 1089ms，全量负载下膨胀至 5s 量级；30s 约为全量实测峰值的 6 倍余量，
      // 覆盖 Windows Defender 扫描等极端干扰。
    }, 30000)
```

注意：只改这一个用例的闭合。下面紧跟的 `it('should cache results per project'...)` 用例不动（单 IO，10s 全局兜底足够）。

- [ ] **Step 3: 确认改动只影响目标用例（typecheck + 单跑）**

Run:

```bash
npm run typecheck
```

Expected: exit code 0。

Run:

```bash
npx vitest run src/__tests__/history.test.ts 2>&1 | tail -3
```

Expected: `1 passed`（29 tests，含目标用例）。

- [ ] **Step 4: 全量验证 history 不再超时（第 1 次）**

Run:

```bash
npm test 2>&1 | grep -E "history\.test|Test Files|Tests " | tail -3
```

Expected: `history.test.ts` 行显示 `29 tests`（无 `| N failed`）。如果仍有失败，确认失败原因不是超时（超时说明 30s 仍不够，需调大；非超时失败不属本轮，记录后继续）。

注意：全量跑约需 6-8 分钟。

- [ ] **Step 5: 提交**

```bash
git add -- src/__tests__/history.test.ts
git commit -m "test: raise history seq-stress case timeout to 30s"
```

---

### Task 3: bootstrap-flag 冷启动用例 per-test timeout

**Files:**
- Modify: `src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx:28-67`

**Interfaces:**
- Consumes: Vitest `it(name, fn, timeout)` 第三参数
- Produces: 3 个 bootstrap 用例各获 15s per-test timeout，覆盖动态 import + 真实 Ink render 冷启动

- [ ] **Step 1: 确认三个用例当前无 timeout 参数（基线）**

Run:

```bash
grep -nE "^\s*\}, [0-9]+\)|^\s*\}\);" src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx
```

Expected: 无 `}, <number>)` 形式的 timeout 闭合（三个用例当前都是 `});` 闭合）。

- [ ] **Step 2: 给三个用例统一加 15s per-test timeout**

把第一个用例的闭合：

```tsx
    // 不崩 + cleanup 不崩 = pass
    expect(() => handle.cleanup()).not.toThrow();
  });
```

改为：

```tsx
    // 不崩 + cleanup 不崩 = pass
    expect(() => handle.cleanup()).not.toThrow();
    // 动态 import bootstrap.js + 真实 Ink render 冷启动；inline 用例单跑实测 5021ms（逼近默认 5s），
    // 全量负载下进一步膨胀。15s 对齐 child-env-scrub 的既有 timeout，约 3 倍余量。
  }, 15000);
```

把第二个用例（alt-screen 模式）的闭合：

```tsx
    expect(() => handle.cleanup()).not.toThrow();
  });
```

改为：

```tsx
    expect(() => handle.cleanup()).not.toThrow();
  }, 15000);
```

把第三个用例（MICODE_INLINE_V2 env）的闭合：

```tsx
    // 不崩即可(V2 路径,忽略 env)
    expect(() => handle.cleanup()).not.toThrow();
    delete process.env.MICODE_INLINE_V2;
  });
```

改为：

```tsx
    // 不崩即可(V2 路径,忽略 env)
    expect(() => handle.cleanup()).not.toThrow();
    delete process.env.MICODE_INLINE_V2;
  }, 15000);
```

注意：第二个用例的闭合 `expect(() => handle.cleanup()).not.toThrow();\n  });` 在文件里出现两次（第 38-39、50-51 行附近），需用带上下文的精确匹配或逐个按行号定位，避免误改。推荐用 Edit 工具时把前后唯一上下文（如注释行）一并纳入 old_string。

- [ ] **Step 3: 确认三个用例都加了 timeout（grep 验证）**

Run:

```bash
grep -nE "^\s*\}, 15000\)" src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx
```

Expected: 输出 3 行（三个用例都带 `}, 15000)`）。

- [ ] **Step 4: 确认改动正确（typecheck + 单跑）**

Run:

```bash
npm run typecheck
```

Expected: exit code 0。

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx 2>&1 | tail -4
```

Expected: 该文件通过（`3 passed` 或偶尔 `2 passed` 因 inline 用例本身在边缘——重点是"不再因 5s 超时报错"。若仍超时，说明 15s 不够，需调大；但单跑 5021ms 加 15s 应足够）。

- [ ] **Step 5: 全量验证 bootstrap-flag 不再超时（第 1 次）**

Run:

```bash
npm test 2>&1 | grep -E "bootstrap-flag|Test Files|Tests " | tail -3
```

Expected: `bootstrap-flag.test.tsx` 行显示 `3 tests`（无 `| N failed`）。

注意：全量跑约需 6-8 分钟。

- [ ] **Step 6: 提交**

```bash
git add -- src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx
git commit -m "test: raise bootstrap-flag cases timeout to 15s"
```

---

### Task 4: 连续 3 次全量稳定性验证（停止线）

**Files:**
- Verify only: 本计划修改的所有文件
- Do not modify: 任何文件

**Interfaces:**
- Consumes: Tasks 1-3 的三个独立提交
- Produces: 可交付分支；两个目标测试在全量负载下连续 3 次不超时

- [ ] **Step 1: 全量稳定性验证（连续 3 次）**

依次运行 3 次全量测试，每次记录 history 和 bootstrap-flag 的结果：

```bash
for run in 1 2 3; do
  echo "===== FULL RUN $run ====="
  npm test 2>&1 | grep -E "history\.test|bootstrap-flag|Test Files" | tail -4
done
```

Expected（每次）：
- `history.test.ts` 行：`29 tests`，无 `| N failed`
- `bootstrap-flag.test.tsx` 行：`3 tests`，无 `| N failed`

如果某次 history 或 bootstrap-flag 出现超时失败：
- 偶发 1 次：记录后重跑该次确认是否稳定（高负载偶发可接受，但目标是 3 次全绿）。
- 多次复现：说明 timeout 值仍不够，回到对应 Task 调大数值（history 30s→60s，bootstrap 15s→30s），重新验证。
- 出现非超时的真实失败：不属本轮，记录现象但单独排查。

注意：3 次全量跑共需约 20-25 分钟。其他已知 flaky（如 child-process-env-scrub）的偶发失败不阻塞本轮。

- [ ] **Step 2: TypeScript 检查**

Run:

```bash
npm run typecheck
```

Expected: exit code 0。

- [ ] **Step 3: 范围检查**

Run:

```bash
git diff master...HEAD --name-only
git status --short
```

Expected:
- diff 仅包含 3 个文件：`vitest.config.ts`、`src/__tests__/history.test.ts`、`src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx`
- worktree 工作树干净
- 不包含三个 prompt 文件或 `ai-news-2026-07.html`

- [ ] **Step 4: 最终审查**

使用 `superpowers:requesting-code-review`，审查重点：

1. timeout 数值是否有实测依据（history 30s 锚定单跑 1089ms；bootstrap 15s 锚定单跑 5021ms）。
2. 是否越界修改了 history.ts 业务逻辑或测试设计（20 轮循环、seq tiebreaker 应保持不变）。
3. 是否引入了 retry / mock 等被 Global Constraints 禁止的机制。
4. 全局 testTimeout/hookTimeout 是否只作兜底，未掩盖 per-test 的精准设置。
5. 三个目标文件的超时是否确实消除。

审查无 Critical/Important 后停止。不要继续追求全量 lint 通过或修复其他 flaky；那是独立工作。
