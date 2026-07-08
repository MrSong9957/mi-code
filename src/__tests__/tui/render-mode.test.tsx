// src/__tests__/tui/render-mode.test.tsx
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { RenderModeProvider, useRenderMode } from '../../tui/state/render-mode.js';

describe('RenderMode', () => {
  it('defaults to inline mode', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <RenderModeProvider>{children}</RenderModeProvider>
    );
    const { result } = renderHook(() => useRenderMode(), { wrapper });
    expect(result.current.mode).toBe('inline');
  });

  it('provides setMode to switch', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <RenderModeProvider>{children}</RenderModeProvider>
    );
    const { result } = renderHook(() => useRenderMode(), { wrapper });
    act(() => {
      result.current.setMode('alt-screen');
    });
    expect(result.current.mode).toBe('alt-screen');
  });
});
