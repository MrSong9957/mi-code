// classifier 模型选择与绑定（Task 4 / 设计 §7.4 ClassifierModelPolicy）
//
// 物理本质：classifier 用哪个模型的“调度器”。只选择并冻结模型，不调用 provider。
//
// 模型选择与绑定语义（设计 §7.4）：
//   1. 显式 classifierModel：必须绑定该模型，不得静默替换。
//      模型不存在/静态已知不可用 -> 抛 ClassifierModelUnavailableError（classifier 据此 deny，不 fallback）。
//   2. 未显式配置：provider 静态声明的 fast classifier model 是 advisory optimization；
//      请求前已知不可选 -> 绑定 session 主模型。
//   3. 未显式配置且无可选 fast model -> 绑定 session 主模型（第一版不要求第二模型，auto 仍可工作）。
//
// 模型在 Stage 1 RPC 前绑定；绑定后禁止跨模型重判。
// Stage 2 默认返回 Stage 1 已绑定模型。

/** 模型引用（provider + model id） */
export interface ModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * 模型选择上下文。
 * - classifierModel：显式配置的 classifier 专用模型（可选）。
 * - providerFastClassifierModel：provider 静态声明的 fast classifier 模型（advisory，可选）。
 * - staticallySelectableModels：请求前静态已知可选的模型集合（adapter/config 声明，非运行时 discovery）。
 * - sessionMainModel：当前 session 主模型（fallback 兜底）。
 */
export interface ClassifierModelContext {
  readonly classifierModel?: ModelRef;
  readonly providerFastClassifierModel?: ModelRef;
  readonly staticallySelectableModels: readonly ModelRef[];
  readonly sessionMainModel: ModelRef;
}

/**
 * 显式配置的 classifierModel 不可选时抛出。
 * classifier 捕获后 fail-closed deny，不 fallback 到其他模型。
 */
export class ClassifierModelUnavailableError extends Error {
  constructor(message = 'Explicitly configured classifier model is not statically selectable') {
    super(message);
    this.name = 'ClassifierModelUnavailableError';
  }
}

/** ModelRef 相等比较 */
function modelRefEqual(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/** freeze ModelRef */
function freezeModelRef(ref: ModelRef): ModelRef {
  return Object.freeze({ providerId: ref.providerId, modelId: ref.modelId });
}

/** 判断一个 ModelRef 是否在静态可选集合中 */
function isStaticallySelectable(ref: ModelRef, context: ClassifierModelContext): boolean {
  return context.staticallySelectableModels.some((s) => modelRefEqual(s, ref));
}

/**
 * 模型选择策略接口（设计 §7.4）。
 * 第一版 DefaultClassifierModelPolicy 实现固定语义；保留未来替换为更强策略的能力。
 */
export interface ClassifierModelPolicy {
  selectStage1(context: ClassifierModelContext): ModelRef;
  selectStage2(context: ClassifierModelContext, stage1Model: ModelRef): ModelRef;
}

/**
 * 默认模型选择策略（设计 §7.4）。
 *
 * selectStage1：
 *   - 显式 classifierModel 可选 -> 绑定（frozen）；
 *   - 显式 classifierModel 不可选 -> 抛 ClassifierModelUnavailableError；
 *   - 无显式模型 + fast 可选 -> fast；
 *   - 无显式模型 + fast 不可选/无 fast -> session main。
 * selectStage2：原样返回 Stage 1 绑定（第一版不独立配置 Stage 2 模型）。
 */
export class DefaultClassifierModelPolicy implements ClassifierModelPolicy {
  selectStage1(context: ClassifierModelContext): ModelRef {
    if (context.classifierModel) {
      if (!isStaticallySelectable(context.classifierModel, context)) {
        throw new ClassifierModelUnavailableError();
      }
      return freezeModelRef(context.classifierModel);
    }
    const fast = context.providerFastClassifierModel;
    if (fast && isStaticallySelectable(fast, context)) {
      return freezeModelRef(fast);
    }
    return freezeModelRef(context.sessionMainModel);
  }

  selectStage2(_context: ClassifierModelContext, stage1Model: ModelRef): ModelRef {
    return stage1Model;
  }
}
