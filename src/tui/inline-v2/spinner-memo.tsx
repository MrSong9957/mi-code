// src/tui/inline-v2/spinner-memo.tsx
//
// V2 inline 模式的 Spinner(memo + 内部订阅 store)。
//
// 物理本质:自己订阅 spinnerStore,父组件传 store 引用(store 本身不变,只是容器)。
// spinner tick 只触发本组件重渲染,不冒泡到 <InlineAppV2>(父不订阅 spinnerStore)。
//
// 与 alt-screen <Spinner> 的区别:alt-screen 版本在 <Footer> 内部,接收 spinnerView prop
// (由父 <App> 算 view 再下传)。V2 版本是 <InlineAppV2> 的子组件,自己订阅自己算 view,
// 这样 spinner tick 的爆炸范围严格限制在 <SpinnerMemo> 内部。
//
// React.memo 的作用:父 <InlineAppV2> 因其他 state(如 input)重渲染时,只要传的 store
// 引用不变,memo 拦截 → 本组件不重渲染。store 引用恒定(整个生命周期同一对象)。

import React from 'react';
import { useStore } from 'zustand/react';
import { selectSpinnerView } from '../state/spinner-view.js';
import { SpinnerWithVerb } from '../components/Spinner.js';
import type { SpinnerStore } from '../state/spinner-store.js';

export interface SpinnerMemoProps {
  store: SpinnerStore;
}

export const SpinnerMemo = React.memo(function SpinnerMemo({
  store,
}: SpinnerMemoProps): React.ReactElement | null {
  // 自己订阅 store → tick 只触发本组件重渲染
  const spinnerState = useStore(store);
  const view = React.useMemo(() => selectSpinnerView(spinnerState), [spinnerState]);
  return <SpinnerWithVerb view={view} />;
});
