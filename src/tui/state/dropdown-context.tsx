// src/tui/state/dropdown-context.tsx
// 下拉菜单 Context（Claude Code Portal 模式）
//
// 物理本质：数据传递的「信箱」。
// PromptInputFooter 写入候选数据 → FullscreenLayout 读取并渲染下拉菜单。
// 分离渲染：菜单和输入框各画各的，通过 Context 传数据，避免互相重绘。

import React, { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { COMMAND_SUGGESTIONS, type SuggestionItem } from '../../commands/suggestion-data.js';

export interface DropdownState {
  /** 是否显示下拉菜单 */
  visible: boolean;
  /** 候选命令列表 */
  candidates: SuggestionItem[];
  /** 当前选中项索引 */
  selectedIndex: number;
}

export interface DropdownContextValue extends DropdownState {
  /** 显示下拉菜单（传入前缀过滤候选） */
  show: (prefix: string) => void;
  /** 隐藏下拉菜单 */
  hide: () => void;
  /** 向下选择 */
  next: () => void;
  /** 向上选择 */
  prev: () => void;
  /** 获取当前选中的命令名 */
  selected: () => string | null;
}

const DropdownContext = createContext<DropdownContextValue | null>(null);

export interface DropdownProviderProps {
  children: ReactNode;
}

/**
 * DropdownProvider：管理下拉菜单状态。
 *
 * Claude Code 模式：数据通过 Context 传递，
 * 渲染在布局顶层（FullscreenLayout），与输入框分离。
 */
export function DropdownProvider({ children }: DropdownProviderProps): React.ReactElement {
  const [visible, setVisible] = useState(false);
  const [candidates, setCandidates] = useState<SuggestionItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const show = useCallback((prefix: string) => {
    const filtered = COMMAND_SUGGESTIONS.filter(s => s.name.startsWith(prefix));
    if (filtered.length > 0) {
      setCandidates(filtered);
      setSelectedIndex(0);
      setVisible(true);
    } else {
      setVisible(false);
    }
  }, []);

  const hide = useCallback(() => {
    setVisible(false);
  }, []);

  const next = useCallback(() => {
    setSelectedIndex(prev => (prev + 1) % candidates.length);
  }, [candidates.length]);

  const prev = useCallback(() => {
    setSelectedIndex(prev => (prev - 1 + candidates.length) % candidates.length);
  }, [candidates.length]);

  const selected = useCallback(() => {
    return candidates[selectedIndex]?.name ?? null;
  }, [candidates, selectedIndex]);

  return (
    <DropdownContext.Provider value={{ visible, candidates, selectedIndex, show, hide, next, prev, selected }}>
      {children}
    </DropdownContext.Provider>
  );
}

/**
 * 获取下拉菜单 Context（组件内使用）。
 *
 * @example
 * const { visible, candidates, show, hide } = useDropdown();
 */
export function useDropdown(): DropdownContextValue {
  const ctx = useContext(DropdownContext);
  if (!ctx) {
    // Provider 缺失时返回空实现（防止崩溃）
    return {
      visible: false,
      candidates: [],
      selectedIndex: 0,
      show: () => {},
      hide: () => {},
      next: () => {},
      prev: () => {},
      selected: () => null,
    };
  }
  return ctx;
}
