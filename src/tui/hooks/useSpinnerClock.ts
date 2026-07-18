import { useEffect } from 'react';
import { useStore } from 'zustand/react';
import { TICK_MS, type SpinnerStore } from '../state/spinner-store.js';

export function useSpinnerClock(store: SpinnerStore): void {
  const active = useStore(store, state => state.active);

  useEffect(() => {
    if (!active) return;

    const id = setInterval(() => { store.getState().tick(); }, TICK_MS);
    return () => { clearInterval(id); };
  }, [active, store]);
}
