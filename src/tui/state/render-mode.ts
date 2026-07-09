// src/tui/state/render-mode.ts
import { createContext, useContext, useState, useCallback, createElement, type ReactNode } from 'react';

export type RenderMode = 'inline' | 'alt-screen';

export const DEFAULT_RENDER_MODE: RenderMode = 'inline';

export interface RenderModeState {
  mode: RenderMode;
  setMode: (mode: RenderMode) => void;
}

const RenderModeContext = createContext<RenderModeState>({
  mode: DEFAULT_RENDER_MODE,
  setMode: () => {},
});

export function RenderModeProvider({ children, initialMode }: {
  children: ReactNode;
  initialMode?: RenderMode;
}): React.ReactElement {
  const [mode, setMode] = useState<RenderMode>(initialMode ?? DEFAULT_RENDER_MODE);
  const stableSetMode = useCallback((m: RenderMode) => setMode(m), []);
  return createElement(
    RenderModeContext.Provider,
    { value: { mode, setMode: stableSetMode } },
    children,
  );
}

export function useRenderMode(): RenderModeState {
  return useContext(RenderModeContext);
}
