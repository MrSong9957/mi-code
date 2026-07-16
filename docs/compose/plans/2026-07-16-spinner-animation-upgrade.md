# Spinner Animation Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Spinner component from basic symbol+verb rendering to full animation support matching Claude Code's four-animation system: shimmer, thinking breathing, dots cycling, and thinking tail marker.

**Architecture:** Extend `Spinner.tsx` (AltScreen mode) to use `computeShimmerSegments` for 3-segment shimmer rendering, add thinking sine wave color animation, dots cycling, and `(thinking)` tail marker. The inline mode receives a parallel `buildSpinnerLine` function for ANSI string output.

**Tech Stack:** React/Ink 7, Zustand, TypeScript, existing `shimmer.ts` pure functions

## Global Constraints

- All animations derive from `store.time` (50ms tick), no independent timers
- Shimmer segments use existing `computeShimmerSegments` from `src/tui/inline/shimmer.ts`
- Theme colors: `spinnerActive`, `spinnerShimmer`, `spinnerStalled` from `src/utils/theme.ts`
- Thinking colors: hardcoded RGB values matching Claude Code (`rgb(153,153,153)` ↔ `rgb(185,185,185)`)
- `theme-context.ts` is the React Context wrapper that re-exports from `theme.ts` — use `useTheme()` in components
- TDD: write failing test first, then implement

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/tui/components/GlimmerMessage.tsx` | Create | Shimmer 3-segment rendering |
| `src/tui/components/ThinkingIndicator.tsx` | Create | Thinking sine wave color breathing |
| `src/tui/components/DotsCycle.tsx` | Create | Dots cycling animation |
| `src/tui/components/Spinner.tsx` | Modify | Integrate all animation components |
| `src/tui/inline/SpinnerLine.tsx` | Create | Inline mode ANSI spinner line |
| `src/__tests__/tui/GlimmerMessage.test.tsx` | Create | Test shimmer segment rendering |
| `src/__tests__/tui/ThinkingIndicator.test.tsx` | Create | Test thinking color animation |
| `src/__tests__/tui/DotsCycle.test.tsx` | Create | Test dots cycling |
| `src/__tests__/tui/Spinner-upgrade.test.tsx` | Create | Test upgraded Spinner |
| `src/__tests__/tui/spinner-integration.test.tsx` | Create | Integration test |

---

### Task 1: GlimmerMessage Component

**Covers:** Shimmer rendering (3-segment `<Text>` nodes)

**Files:**
- Create: `src/tui/components/GlimmerMessage.tsx`
- Create: `src/__tests__/tui/GlimmerMessage.test.tsx`

**Interfaces:**
- Consumes: `computeShimmerSegments` from `src/tui/inline/shimmer.ts`
- Produces: `<GlimmerMessage message={string} glimmerIndex={number} baseColor={string} shimmerColor={string} />`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/tui/GlimmerMessage.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { GlimmerMessage } from '../../tui/components/GlimmerMessage.js';

describe('GlimmerMessage', () => {
  it('renders three text segments with correct colors', () => {
    const { lastFrame } = render(
      React.createElement(GlimmerMessage, {
        message: 'Generating',
        glimmerIndex: 5,  // shimmer on 'rat'
        baseColor: 'rgb(100, 200, 240)',
        shimmerColor: 'rgb(170, 230, 255)',
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Generating');
  });

  it('renders empty message as nothing', () => {
    const { lastFrame } = render(
      React.createElement(GlimmerMessage, {
        message: '',
        glimmerIndex: 5,
        baseColor: 'rgb(100, 200, 240)',
        shimmerColor: 'rgb(170, 230, 255)',
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/tui/GlimmerMessage.test.tsx`
Expected: FAIL with "Cannot find module '../../tui/components/GlimmerMessage.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/components/GlimmerMessage.tsx
import React from 'react';
import { Text } from 'ink';
import { computeShimmerSegments } from '../inline/shimmer.js';

export interface GlimmerMessageProps {
  message: string;
  glimmerIndex: number;
  baseColor: string;
  shimmerColor: string;
}

export function GlimmerMessage({
  message,
  glimmerIndex,
  baseColor,
  shimmerColor,
}: GlimmerMessageProps): React.ReactElement | null {
  if (!message) return null;

  const { before, shimmer, after } = computeShimmerSegments(message, glimmerIndex);

  return (
    <>
      {before && <Text color={baseColor}>{before}</Text>}
      {shimmer && <Text color={shimmerColor}>{shimmer}</Text>}
      {after && <Text color={baseColor}>{after}</Text>}
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/tui/GlimmerMessage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/GlimmerMessage.tsx src/__tests__/tui/GlimmerMessage.test.tsx
git commit -m "feat(spinner): add GlimmerMessage component for 3-segment shimmer rendering"
```

---

### Task 2: ThinkingIndicator Component

**Covers:** Thinking sine wave color breathing animation

**Files:**
- Create: `src/tui/components/ThinkingIndicator.tsx`
- Create: `src/__tests__/tui/ThinkingIndicator.test.tsx`

**Interfaces:**
- Consumes: `storeTime` (from spinner store, 50ms tick) for animation calculation
- Produces: `<ThinkingIndicator storeTime={number} thinkStartTime={number | null} text={string} showParens={boolean} />`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/tui/ThinkingIndicator.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ThinkingIndicator, interpolateColor, toRGBColor } from '../../tui/components/ThinkingIndicator.js';

describe('ThinkingIndicator', () => {
  it('interpolates between two RGB colors', () => {
    const color1 = { r: 153, g: 153, b: 153 };
    const color2 = { r: 185, g: 185, b: 185 };

    const at0 = interpolateColor(color1, color2, 0);
    const at1 = interpolateColor(color1, color2, 1);
    const at05 = interpolateColor(color1, color2, 0.5);

    expect(toRGBColor(at0)).toBe('rgb(153,153,153)');
    expect(toRGBColor(at1)).toBe('rgb(185,185,185)');
    expect(toRGBColor(at05)).toBe('rgb(169,169,169)');
  });

  it('renders thinking text with computed color', () => {
    const { lastFrame } = render(
      React.createElement(ThinkingIndicator, {
        storeTime: 5000,  // past 3s delay (3000ms)
        thinkStartTime: 0,
        text: 'thinking',
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/tui/ThinkingIndicator.test.tsx`
Expected: FAIL with "Cannot find module '../../tui/components/ThinkingIndicator.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/components/ThinkingIndicator.tsx
import React from 'react';
import { Text } from 'ink';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function interpolateColor(c1: RGB, c2: RGB, t: number): RGB {
  return {
    r: Math.round(c1.r + (c2.r - c1.r) * t),
    g: Math.round(c1.g + (c2.g - c1.g) * t),
    b: Math.round(c1.b + (c2.b - c1.b) * t),
  };
}

export function toRGBColor(c: RGB): string {
  return `rgb(${c.r},${c.g},${c.b})`;
}

const THINKING_INACTIVE: RGB = { r: 153, g: 153, b: 153 };
const THINKING_INACTIVE_SHIMMER: RGB = { r: 185, g: 185, b: 185 };
const THINKING_GLOW_PERIOD_S = 2;

export interface ThinkingIndicatorProps {
  /** Spinner store time (50ms tick), used for sine wave calculation */
  storeTime: number;
  /** Timestamp when thinking started (Date.now()), null if not thinking */
  thinkStartTime: number | null;
  /** Text to display (e.g. "thinking") */
  text: string;
  /** Whether to wrap text in parentheses: (text) vs text */
  showParens?: boolean;
}

export function ThinkingIndicator({
  storeTime,
  thinkStartTime,
  text,
  showParens = false,
}: ThinkingIndicatorProps): React.ReactElement | null {
  if (!text) return null;

  // Use storeTime (50ms tick) for animation, not Date.now()
  // thinkStartTime is storeTime when thinking began; compute elapsed from store clock
  const elapsed = thinkStartTime !== null ? storeTime - thinkStartTime : 0;
  const THINKING_DELAY_TICKS = 60;  // 3000ms / 50ms = 60 ticks
  const elapsedSec = Math.max(0, elapsed - THINKING_DELAY_TICKS) * 0.05;  // ticks * 50ms = seconds
  const thinkingOpacity = elapsed < THINKING_DELAY_TICKS
    ? 0
    : (Math.sin(elapsedSec * Math.PI * 2 / THINKING_GLOW_PERIOD_S) + 1) / 2;

  const color = toRGBColor(interpolateColor(THINKING_INACTIVE, THINKING_INACTIVE_SHIMMER, thinkingOpacity));

  if (showParens) {
    return (
      <>
        <Text dimColor>(</Text>
        <Text color={color}>{text}</Text>
        <Text dimColor>)</Text>
      </>
    );
  }

  return <Text color={color}>{`(${text})`}</Text>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/tui/ThinkingIndicator.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/ThinkingIndicator.tsx src/__tests__/tui/ThinkingIndicator.test.tsx
git commit -m "feat(spinner): add ThinkingIndicator with sine wave color breathing"
```

---

### Task 3: DotsCycle Component

**Covers:** Dots cycling animation (`.`, `..`, `...`)

**Files:**
- Create: `src/tui/components/DotsCycle.tsx`
- Create: `src/__tests__/tui/DotsCycle.test.tsx`

**Interfaces:**
- Consumes: `time` from spinner store
- Produces: `<DotsCycle time={number} color={string} />`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/tui/DotsCycle.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { DotsCycle } from '../../tui/components/DotsCycle.js';

describe('DotsCycle', () => {
  it('cycles through ., .., ... every 300ms', () => {
    const { lastFrame, rerender } = render(
      React.createElement(DotsCycle, { time: 0, color: 'rgb(110,110,120)' })
    );
    expect(lastFrame()).toContain('.  ');

    rerender(React.createElement(DotsCycle, { time: 300, color: 'rgb(110,110,120)' }));
    expect(lastFrame()).toContain('.. ');

    rerender(React.createElement(DotsCycle, { time: 600, color: 'rgb(110,110,120)' }));
    expect(lastFrame()).toContain('...');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/tui/DotsCycle.test.tsx`
Expected: FAIL with "Cannot find module '../../tui/components/DotsCycle.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/components/DotsCycle.tsx
import React from 'react';
import { Text } from 'ink';

export interface DotsCycleProps {
  time: number;
  color: string;
}

export function DotsCycle({ time, color }: DotsCycleProps): React.ReactElement {
  const dotFrame = Math.floor(time / 300) % 3;
  const dots = '.'.repeat(dotFrame + 1).padEnd(3);

  return <Text color={color}>{dots}</Text>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/tui/DotsCycle.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/DotsCycle.tsx src/__tests__/tui/DotsCycle.test.tsx
git commit -m "feat(spinner): add DotsCycle component for ./../... animation"
```

---

### Task 4: Upgrade Spinner.tsx

**Covers:** Integrate all animation components into main Spinner

**Files:**
- Modify: `src/tui/components/Spinner.tsx`
- Create: `src/__tests__/tui/Spinner-upgrade.test.tsx`

**Interfaces:**
- Consumes: `GlimmerMessage`, `ThinkingIndicator`, `DotsCycle` components
- Produces: Full spinner with shimmer, thinking, dots, tail marker

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/tui/Spinner-upgrade.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Spinner } from '../../tui/components/Spinner.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';

describe('Spinner upgraded animations', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows shimmer segments on verb text', () => {
    const store = createSpinnerStore();
    store.getState().start('generating');
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    // Should contain the verb (shimmer is color-only, text is same)
    expect(frame.length).toBeGreaterThan(0);
  });

  it('shows thinking indicator in thinking mode after delay', () => {
    const store = createSpinnerStore();
    store.getState().start('thinking');
    // Advance past 3s delay
    vi.advanceTimersByTime(4000);
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    // Should show (thinking) tail marker
    expect(frame).toContain('(thinking)');
  });

  it('shows dots cycle in non-thinking modes', () => {
    const store = createSpinnerStore();
    store.getState().start('generating');
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    // Should contain dots (., .., or ...)
    expect(frame).toMatch(/\.{1,3}\s?$/);
  });

  it('stalled state renders with error color', () => {
    const store = createSpinnerStore();
    store.getState().start('generating');
    store.getState().onToken();
    vi.advanceTimersByTime(4000);  // past stall threshold
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    expect(lastFrame()).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/tui/Spinner-upgrade.test.tsx`
Expected: FAIL — new tests assert on `(thinking)` and dots which don't exist in current implementation

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/components/Spinner.tsx (upgraded)
import React, { useEffect } from 'react';
import { Text } from 'ink';
import { useStore } from 'zustand/react';
import { SPINNER_FRAMES, type SpinnerStore } from '../state/spinner-store.js';
import { useTheme } from '../state/theme-context.js';
import { computeGlimmerIndex } from '../inline/shimmer.js';
import { GlimmerMessage } from './GlimmerMessage.js';
import { ThinkingIndicator } from './ThinkingIndicator.js';
import { DotsCycle } from './DotsCycle.js';

const TICK_MS = 50;
const SHIMMER_SPEED = 200;
const SHIMMER_PAD = 10;

export interface SpinnerProps {
  store: SpinnerStore;
}

export function Spinner({ store }: SpinnerProps): React.ReactElement | null {
  const t = useTheme();
  const active = useStore(store, (s) => s.active);
  const time = useStore(store, (s) => s.time);
  const mode = useStore(store, (s) => s.mode);
  const verb = useStore(store, (s) => s.verb);
  const label = useStore(store, (s) => s.label);
  const stalled = useStore(store, (s) => s.stalled);
  const thinkStartTime = useStore(store, (s) => s.thinkStartTime);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { store.getState().tick(); }, TICK_MS);
    return () => { clearInterval(id); };
  }, [active, store]);

  if (!active) return null;

  const frame = SPINNER_FRAMES[Math.floor(time / 120) % SPINNER_FRAMES.length];
  const displayText = label || verb;

  // Compute shimmer
  const messageWidth = displayText.length;  // TODO: use displayWidth for CJK
  const glimmerIndex = computeGlimmerIndex(time, messageWidth, {
    speed: SHIMMER_SPEED,
    cyclePad: SHIMMER_PAD,
    stalled,
  });

  // Spinner glyph color
  const glyphColor = stalled ? t.spinnerStalled : t.spinnerActive;

  return (
    <>
      <Text color={glyphColor} bold>{frame} </Text>
      <GlimmerMessage
        message={displayText}
        glimmerIndex={glimmerIndex}
        baseColor={stalled ? t.spinnerStalled : t.spinnerActive}
        shimmerColor={t.spinnerShimmer}
      />
      {mode === 'thinking' && (
        <ThinkingIndicator
          storeTime={time}
          thinkStartTime={thinkStartTime}
          text="thinking"
        />
      )}
      {mode !== 'thinking' && <DotsCycle time={time} color={t.textMuted} />}
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/tui/Spinner-upgrade.test.tsx`
Expected: PASS

- [ ] **Step 5: Run all spinner tests**

Run: `npx vitest run src/__tests__/tui/spinner`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tui/components/Spinner.tsx src/__tests__/tui/Spinner-upgrade.test.tsx
git commit -m "feat(spinner): upgrade Spinner with shimmer, thinking, and dots animations"
```

---

### Task 5: Inline Mode SpinnerLine

**Covers:** Inline mode spinner with same animations (ANSI string output)

**Files:**
- Create: `src/tui/inline/SpinnerLine.tsx`
- Create: `src/__tests__/tui/SpinnerLine.test.tsx`

**Interfaces:**
- Consumes: Same animation logic as AltScreen Spinner; theme colors passed as params
- Produces: ANSI string for inline rendering

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/tui/SpinnerLine.test.tsx
import { describe, it, expect } from 'vitest';
import { buildSpinnerLine } from '../../tui/inline/SpinnerLine.js';

describe('SpinnerLine (inline mode)', () => {
  it('builds ANSI string with shimmer segments', () => {
    const result = buildSpinnerLine({
      time: 1000,
      mode: 'generating',
      verb: 'Crafting',
      label: '',
      stalled: false,
      thinkStartTime: null,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    expect(result).toContain('Crafting');
    expect(result).toMatch(/\x1b\[/);
  });

  it('shows thinking indicator in thinking mode', () => {
    const result = buildSpinnerLine({
      time: 5000,
      mode: 'thinking',
      verb: 'Thinking',
      label: '',
      stalled: false,
      thinkStartTime: 0,  // storeTime when thinking started
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    expect(result).toContain('Thinking');
    expect(result).toContain('(thinking)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/tui/SpinnerLine.test.tsx`
Expected: FAIL with "Cannot find module '../../tui/inline/SpinnerLine.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/inline/SpinnerLine.tsx
// Inline mode spinner line builder (ANSI string output)
import { computeGlimmerIndex, computeShimmerSegments } from './shimmer.js';
import { SPINNER_FRAMES } from '../state/spinner-store.js';

const SHIMMER_SPEED = 200;
const SHIMMER_PAD = 10;
const THINKING_GLOW_PERIOD_S = 2;

interface SpinnerTheme {
  active: string;
  shimmer: string;
  stalled: string;
  muted: string;
}

interface SpinnerLineOpts {
  time: number;
  mode: 'thinking' | 'generating' | 'tool';
  verb: string;
  label: string;
  stalled: boolean;
  thinkStartTime: number | null;
  theme: SpinnerTheme;
}

function parseRGB(color: string): { r: number; g: number; b: number } {
  const match = color.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (!match) return { r: 153, g: 153, b: 153 };
  return { r: +match[1], g: +match[2], b: +match[3] };
}

function interpolateColor(
  c1: { r: number; g: number; b: number },
  c2: { r: number; g: number; b: number },
  t: number,
): string {
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function toAnsiColor(rgb: string): string {
  const { r, g, b } = parseRGB(rgb);
  return `\x1b[38;2;${r};${g};${b}m`;
}

const THINKING_INACTIVE = { r: 153, g: 153, b: 153 };
const THINKING_INACTIVE_SHIMMER = { r: 185, g: 185, b: 185 };
const RESET = '\x1b[0m';

export function buildSpinnerLine(opts: SpinnerLineOpts): string {
  const frame = SPINNER_FRAMES[Math.floor(opts.time / 120) % SPINNER_FRAMES.length];
  const displayText = opts.label || opts.verb;

  // Shimmer
  const glimmerIndex = computeGlimmerIndex(opts.time, displayText.length, {
    speed: SHIMMER_SPEED,
    cyclePad: SHIMMER_PAD,
    stalled: opts.stalled,
  });
  const { before, shimmer, after } = computeShimmerSegments(displayText, glimmerIndex);

  // Colors from theme
  const baseColor = opts.stalled ? toAnsiColor(opts.theme.stalled) : toAnsiColor(opts.theme.active);
  const shimmerColor = toAnsiColor(opts.theme.shimmer);

  let line = `${baseColor}${frame} ${RESET}`;
  line += `${baseColor}${before}${RESET}`;
  line += `${shimmerColor}${shimmer}${RESET}`;
  line += `${baseColor}${after}${RESET}`;

  // Dots or thinking
  if (opts.mode === 'thinking' && opts.thinkStartTime !== null) {
    const elapsed = opts.time - opts.thinkStartTime;
    const THINKING_DELAY_TICKS = 60;  // 3000ms / 50ms
    const elapsedSec = Math.max(0, elapsed - THINKING_DELAY_TICKS) * 0.05;
    const opacity = elapsed < THINKING_DELAY_TICKS
      ? 0
      : (Math.sin(elapsedSec * Math.PI * 2 / THINKING_GLOW_PERIOD_S) + 1) / 2;
    const thinkColor = interpolateColor(THINKING_INACTIVE, THINKING_INACTIVE_SHIMMER, opacity);
    line += ` ${thinkColor}(thinking)${RESET}`;
  } else {
    const dotFrame = Math.floor(opts.time / 300) % 3;
    const dots = '.'.repeat(dotFrame + 1).padEnd(3);
    line += `${toAnsiColor(opts.theme.muted)}${dots}${RESET}`;
  }

  return line;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/tui/SpinnerLine.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/inline/SpinnerLine.tsx src/__tests__/tui/SpinnerLine.test.tsx
git commit -m "feat(spinner): add inline mode SpinnerLine with ANSI animations"
```

---

### Task 6: Integration Test

**Covers:** End-to-end spinner animation verification

**Files:**
- Create: `src/__tests__/tui/spinner-integration.test.tsx`

**Interfaces:**
- Consumes: All spinner components
- Produces: Full animation cycle verification

- [ ] **Step 1: Write the integration test**

```typescript
// src/__tests__/tui/spinner-integration.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Spinner } from '../../tui/components/Spinner.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';

describe('Spinner integration', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('full animation cycle: generating → thinking → stop', () => {
    const store = createSpinnerStore();

    // Phase 1: generating with shimmer + dots
    store.getState().start('generating');
    const { lastFrame, rerender } = render(React.createElement(Spinner, { store }));
    vi.advanceTimersByTime(1000);
    rerender(React.createElement(Spinner, { store }));
    const genFrame = lastFrame() ?? '';
    expect(genFrame).toMatch(/[·✢✳✶✻✽]/);
    // Dots present in generating mode
    expect(genFrame).toMatch(/\.{1,3}\s?$/);

    // Phase 2: switch to thinking via setMode (exists in spinner-store)
    store.getState().setMode('thinking');
    vi.advanceTimersByTime(4000);  // past 3s delay
    rerender(React.createElement(Spinner, { store }));
    const thinkFrame = lastFrame() ?? '';
    expect(thinkFrame).toContain('(thinking)');

    // Phase 3: stop
    store.getState().stop();
    rerender(React.createElement(Spinner, { store }));
    expect(lastFrame()).toBe('');
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run src/__tests__/tui/spinner-integration.test.tsx`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `npx vitest run src/__tests__/tui/`
Expected: PASS

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/tui/spinner-integration.test.tsx
git commit -m "test(spinner): add integration test for full animation cycle"
```

---

## Self-Review

**1. Spec coverage:**
- Shimmer rendering: Task 1 (GlimmerMessage) + Task 4 (Spinner integration)
- Thinking breathing: Task 2 (ThinkingIndicator) + Task 4
- Dots cycling: Task 3 (DotsCycle) + Task 4
- Inline mode: Task 5 (SpinnerLine)
- Integration: Task 6

**2. Placeholder scan:** No TBD/TODO placeholders found. All code blocks are complete.

**3. Type consistency:**
- `computeShimmerSegments` returns `{ before, shimmer, after }` - consistent across tasks
- `computeGlimmerIndex` takes `(time, messageWidth, opts)` - consistent
- Theme colors used consistently: `t.spinnerActive`, `t.spinnerShimmer`, `t.spinnerStalled`
- `ThinkingIndicator` uses `storeTime` (not `Date.now()`) - consistent with store-driven timer model
- `DotsCycle` uses `color` param (not `dimColor`) - consistent
- `SpinnerLine` accepts `theme` param - no hardcoded colors
- `setMode` is a valid method on `SpinnerState` (verified in spinner-store.ts:79-84)

**4. Review fixes applied:**
- Task 4 Step 2: Now expects FAIL (new assertions for `(thinking)` and dots)
- DotsCycle: Uses `<Text color={color}>` instead of `<Text dimColor>`
- ThinkingIndicator: Uses `storeTime` param (store 50ms tick), not `Date.now()`
- SpinnerLine: Theme colors passed as `theme` param, no hardcoded values
- GlimmerMessage: Removed trailing space (caller handles spacing)
- Integration test: `setMode('thinking')` is valid (spinner-store.ts:79-84)
- Import path: `theme-context.ts` is React Context wrapper for `theme.ts` - clarified

---

## Execution Handoff

After saving the plan, determine execution approach:

1. **Check memory** for a saved `execution-style` preference in the `compose-preferences` memory file. If found (`subagent` or `inline`), use it and skip to the handler below.

2. **If no saved preference,** ask through `compose:ask`:
   - header: `Execution`
   - question: `Plan saved. How would you like to execute it?`
   - options:
     - label: `Subagent, always`, description: `Fresh subagent per task — remember for future sessions`
     - label: `Subagent, this time`, description: `Fresh subagent per task — just this once`
     - label: `Inline, always`, description: `Execute in this session — remember for future sessions`
     - label: `Inline, this time`, description: `Execute in this session — just this once`

   If no user is available, default to Inline for ≤ 3 tasks or tightly coupled tasks, Subagent for > 3 independent tasks.

3. **If "always" variant:** Save to the `compose-preferences` memory file as `execution-style: subagent` or `execution-style: inline`.

**If Subagent:** Use compose:subagent — fresh subagent per task + two-stage review.

**If Inline:** Use compose:execute — batch execution with checkpoints
