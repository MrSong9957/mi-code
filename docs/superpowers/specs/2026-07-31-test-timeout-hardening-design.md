# Test Timeout Hardening Design

> **状态**: 设计已认可，待转 writing-plans
> **日期**: 2026-07-31
> **分支**: 待建 `codex/test-timeout-hardening`（从干净 master `06fab2c` 出发）

## 背景与问题

全量 `npm test` 存在三个间歇性失败的 flaky 测试，阻塞 CI/合并可信度。本轮 lint 修复期间首次观察到，初步怀疑是 env 竞争 / 模块状态泄漏（基于一份反编译源码的分析文档的推测）。

## 根因诊断（基于 mi-code 真实代码的实证）

**结论：三个 flaky 同属一类——高 IO/系统负载下的超时，不是逻辑 bug、不是 env 污染、不是隔离缺陷。**

诊断推翻了反编译文档的推测。关键证据链：

### 证据 1：history 单跑稳定，全量才失败

```
history.test.ts 单独连跑 20 次：20/20 PASS
history.test.ts 全量跑：1 failed（"同毫秒 seq tiebreaker" 用例）
```

单跑稳定本身只能排除"单跑场景下的 env 竞争"。完整的排除需要两个证据合在一起：**单跑稳定 + 全量失败被定位为超时（而非断言错位，见证据 2）**——后者证明失败不是"读到了污染数据"（那会是断言错位），而是纯粹的耗时问题。两个证据共同排除 env 竞争 / 跨测试残留假设。

### 证据 2：失败是超时，不是断言错位

全量跑失败用例的精确错误：

```
× HistoryManager > getHistory > 同毫秒时间戳下仍按加入顺序倒序（seq tiebreaker 防 flaky）  5048ms
  → Test timed out in 5000ms.
```

不是"期望 2 得 4"的断言失败，而是 `Test timed out in 5000ms`。

### 证据 3：耗时膨胀量化

同一用例的耗时对比：

| 场景 | 报告耗时 | 结果 |
|------|---------|------|
| 单跑（系统空闲） | 1089ms | PASS（真实耗时） |
| 全量（IO 争用） | 5048ms | FAIL（超时中断值） |

**注意**：单跑的 1089ms 是测试完整跑完的真实耗时；全量的 5048ms 是 **vitest 在 5000ms 阈值处中断后报告的值**（含少量调度开销），不代表真实执行耗时上限——实际 IO 耗时可能远超 5048ms，只是被超时机制截断了。因此下文余量计算以"单跑真实耗时 1089ms"为锚点，而非 5048ms。

即便如此，从 1089ms（完整跑完）到触发 5000ms 超时，仍证明全量负载下该用例耗时膨胀至至少 5s 量级（4.6× 以上）。根因是该用例做 **20 轮 × (mkdtemp + 3×appendFile + readFile + rmSync) = 100+ 次真实磁盘 IO**，在高负载下累积耗时突破阈值。

### 证据 4：bootstrap-flag 同类

`bootstrap-flag.test.tsx` 单跑已偶发超时（3 次中 1 次），根因是动态 `import('bootstrap.js')` + 真实 Ink `render()` 的冷启动开销（实例化 11 个 zustand store + React reconciler 首帧），在 Windows 冷启动下逼近 5s。

### 证据 5：child-env-scrub 反证

`child-process-env-scrub.test.ts` 同样做真实 IO（spawn 子进程），但**已设 per-test timeout（15000ms）**，因此相对稳定。这证明 per-test timeout 是本仓库已验证的有效缓解手段。

### 被推翻的假设

反编译分析文档（基于 Claude Code v2.1.88 反编译源码）对 mi-code 的三个推测**均不成立**：

| 文档推测 | mi-code 实际 |
|---------|------------|
| history 是模块级 `pendingEntries` 状态泄漏 | ✗ `HistoryManager` 是实例化类，每测试 new 新实例 |
| "没有 seq tiebreaker" | ✗ 已实现 `seq: ++this.seqCounter`（history.ts:47） |
| USERPROFILE env 竞争导致读错文件 | ✗ 测试传显式 `testHistoryPath`，不走 homedir；单跑 20 次全绿 |

**教训：**
- **基于不同代码库的推测必须用目标仓库的真实复现验证，不能直接照搬方案。**
- **诊断代码必须先在单跑场景验证自身无副作用，再投入全量复现。** 本轮诊断过程中，最初加的 buggy 诊断代码（`afterEach(function() { this.currentTest... })` 中 `this` 在严格模式下为 `undefined`）导致 history 29 个测试全部失败，一度被误判为"history 全量必然失败"。这证明了诊断手段本身会干扰结论——先还原诊断代码、确认单跑 29 passed，才得到后续的真实证据。

## 设计：分层 timeout 治理

### 核心思路

根因是超时，就治超时。遵循 AGENTS.md「简单可靠优先，禁止过度设计」。不重写测试逻辑、不引入 mock 砍模块图（那会摧毁测试价值），仅通过 timeout 配置消除高负载下的误判。

### 改动清单（3 处，纯配置/参数，零逻辑改动）

#### 1. `vitest.config.ts` — 全局兜底

```ts
test: {
  // ...existing config...
  testTimeout: 10000,   // 兜底：覆盖未显式设置的测试（默认 5000 在高负载下不足）
  hookTimeout: 10000,   // 预防性设置：本轮未观察到 hook 超时失败（三个 flaky 全部是 testTimeout），
                        // 但 history 的 beforeEach 含 mkdirSync + writeFileSync，在极端负载下理论上
                        // 存在同类风险。加一行成本为零，作为预防而非修复。
}
```

依据：child-env-scrub 的 15s 是已验证的稳定值；10s 作为全局兜底（多数测试远低于此），重 IO 测试由下面的 per-test 覆盖到更高值。

#### 2. `src/__tests__/history.test.ts` — 重 IO 用例

给"同毫秒 seq tiebreaker"用例加 per-test timeout：

```ts
it('同毫秒时间戳下仍按加入顺序倒序（seq tiebreaker 防 flaky）', async () => {
  // ...20 轮循环...
}, 30000)   // 20 轮 × 100+ 次磁盘 IO；单跑 1089ms，全量膨胀至 5048ms（4.6×），
            // 30s 约为全量实测峰值的 6 倍余量，覆盖 Windows Defender 扫描等极端干扰
```

仅此一个用例需要（其余用例单 IO，10s 全局兜底足够）。

#### 3. `src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx` — 冷启动用例

给 3 个用例加 per-test timeout：

```ts
it('inline 模式启动不崩(Ink reconciler + <Static>)', async () => {
  // ...
}, 15000)   // 动态 import + 真实 Ink render 冷启动
```

3 个用例统一 15000ms。

**余量依据（实测数据）**：bootstrap-flag 单跑时三个用例耗时差异显著——inline 模式用例 **5021ms**（单跑就已逼近 5s 超时边缘，因此偶发失败）、alt-screen 模式 1423ms、MICODE_INLINE_V2 env 用例 421ms。以最慢的 inline 用例 5021ms 为基线，15s 给予约 3 倍余量，覆盖全量负载下的进一步膨胀。此余量低于 history 用例（6 倍）是合理的——bootstrap 的瓶颈是冷启动模块求值（一次性开销），不像 history 是 20 轮累积 IO（随负载线性放大）。

### 明确不做的事（YAGNI）

- **不引入 vitest retry / flaky 容忍机制**：根因是确定性超时（可根治），retry 只会掩盖；Vitest 3.x 也不原生支持 retry 配置。
- **不用 vi.mock 砍 bootstrap 模块图**：该测试目的就是验证真实启动不崩，mock 会使其失去价值。
- **不改 history 的 20 轮循环设计**：循环是有意放大同毫秒概率以验证 seq tiebreaker，减轮或 mock fs 会削弱验证力度。
- **不修 child-env-scrub**：它已设 per-test timeout 且稳定，不在本轮范围。
- **不碰 history.ts 业务逻辑**：seq tiebreaker 实现正确，单跑全绿证明逻辑无 bug。

## 验证标准

1. **定向**：三个目标文件 `--quiet` ESLint 无新增 error（本轮不应引入 lint 问题，但作为回归门禁）。
2. **typecheck**：`npm run typecheck` exit 0。
3. **稳定性（核心）**：连续 **3 次**全量 `npm test`，`history.test.ts` 和 `bootstrap-flag.test.tsx` 均不因超时失败。其他已知 flaky（如 child-env-scrub）的偶发失败不阻塞本轮验收——全量 exit 0 取决于它们，不在本轮可控范围。若本轮目标文件出现非超时的真实失败，单独排查（不属本轮）。
4. **范围**：`git diff master...HEAD --name-only` 仅含 3 个文件；不含 prompt 文件或 `ai-news-2026-07.html`。

## 防御边界（高频崩溃异常操作防护）

识别到的同类风险模式及对应防护：

- **风险**：任何"真实磁盘 IO 循环"或"动态 import 重模块图"的测试，在全量高负载下都可能超时。
- **防护准则**：新增此类测试时，必须显式设置 per-test timeout，不依赖全局兜底；全局 `testTimeout`/`hookTimeout` 只作最后一道防线，不作首选缓解。

## 核心函数突破口

本轮无核心业务函数修改。诊断锚点是"同毫秒 seq tiebreaker"用例的耗时膨胀数据（1089ms → 5048ms），它是定位根因的决定性证据。
