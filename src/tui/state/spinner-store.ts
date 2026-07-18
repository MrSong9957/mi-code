import { createStore, type StoreApi } from 'zustand/vanilla';
import { sampleVerb, type SpinnerVerbConfig } from './spinner-verbs.js';

/** Claude Code 的 6 帧往返序列；time 的单位始终是毫秒。 */
export const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'] as const;
export const TICK_MS = 50;
export const SPINNER_FRAME_MS = 120;
const STALL_MS = 3_000;
const STALL_RAMP_MS = 2_000;
export const THINKING_GLOW_DELAY_MS = 3_000;
export const THINKING_GLOW_PERIOD_MS = 2_000;
export const THINKING_SUMMARY_MIN_VISIBLE_MS = 2_000;

/** 与流生命周期对应的五种视觉状态。 */
export type SpinnerMode = 'requesting' | 'responding' | 'thinking' | 'tool-use' | 'tool-input';
export interface SpinnerCompletion { durationMs: number; }
export interface ThinkingSummary { durationMs: number; visibleUntil: number; }
export interface SpinnerRGB { r: number; g: number; b: number; }

export type SpinnerVariant = 'normal' | 'brief';

export interface SpinnerTeammate {
  name: string;
  role: string;
  status: 'idle' | 'working' | 'shutdown';
}

export interface SpinnerTask {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner: string | null;
  activeForm: string | null;
  blockedBy: readonly string[];
}

export interface SpinnerContextSnapshot {
  variant: SpinnerVariant;
  teammates: readonly SpinnerTeammate[];
  tasks: readonly SpinnerTask[];
  spinnerTip: string | null;
  hasUsedBtw: boolean;
  budgetText: string | null;
  nextTaskText: string | null;
}

export const EMPTY_SPINNER_CONTEXT: SpinnerContextSnapshot = Object.freeze({
  variant: 'normal',
  teammates: Object.freeze([]),
  tasks: Object.freeze([]),
  spinnerTip: null,
  hasUsedBtw: false,
  budgetText: null,
  nextTaskText: null,
});

function normalizeSpinnerText(text: string): string {
  return text.replace(/\r\n|[\r\n]/g, ' ').trim();
}

function normalizeOptionalSpinnerText(text: string | null): string | null {
  return text === null ? null : normalizeSpinnerText(text) || null;
}

export function normalizeSpinnerContext(
  context: SpinnerContextSnapshot,
): SpinnerContextSnapshot {
  return {
    variant: context.variant,
    teammates: context.teammates.map(member => ({
      ...member,
      name: normalizeSpinnerText(member.name),
      role: normalizeSpinnerText(member.role),
    })),
    tasks: context.tasks.map(task => ({
      ...task,
      content: normalizeSpinnerText(task.content),
      owner: normalizeOptionalSpinnerText(task.owner),
      activeForm: normalizeOptionalSpinnerText(task.activeForm),
      blockedBy: task.blockedBy.map(normalizeSpinnerText),
    })),
    spinnerTip: normalizeOptionalSpinnerText(context.spinnerTip),
    hasUsedBtw: context.hasUsedBtw,
    budgetText: normalizeOptionalSpinnerText(context.budgetText),
    nextTaskText: normalizeOptionalSpinnerText(context.nextTaskText),
  };
}

const THINKING_BASE_COLOR: SpinnerRGB = { r: 153, g: 153, b: 153 };
const THINKING_SHIMMER_COLOR: SpinnerRGB = { r: 185, g: 185, b: 185 };

/** 从统一动画时钟推导当前 SpinnerGlyph 帧。 */
export function spinnerFrameAt(timeMs: number): typeof SPINNER_FRAMES[number] {
  const safeTime = Math.max(0, timeMs);
  return SPINNER_FRAMES[Math.floor(safeTime / SPINNER_FRAME_MS) % SPINNER_FRAMES.length]!;
}

export function formatSpinnerDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export function thinkingStatusText(effort: string | null): string {
  const normalizedEffort = effort?.trim();
  return normalizedEffort ? `thinking ${normalizedEffort}` : 'thinking';
}

export function thoughtStatusText(durationMs: number): string {
  return `thought for ${formatSpinnerDuration(durationMs)}`;
}

/** 由毫秒级统一时钟派生 thinking 灰色呼吸颜色。 */
export function thinkingColorAt(timeMs: number, thinkStartTime: number | null): SpinnerRGB {
  if (thinkStartTime === null) return { ...THINKING_BASE_COLOR };
  const elapsedMs = Math.max(0, timeMs - thinkStartTime);
  const opacity = elapsedMs < THINKING_GLOW_DELAY_MS
    ? 0
    : (Math.sin(
        (elapsedMs - THINKING_GLOW_DELAY_MS) * Math.PI * 2 / THINKING_GLOW_PERIOD_MS,
      ) + 1) / 2;
  return {
    r: Math.round(THINKING_BASE_COLOR.r + (THINKING_SHIMMER_COLOR.r - THINKING_BASE_COLOR.r) * opacity),
    g: Math.round(THINKING_BASE_COLOR.g + (THINKING_SHIMMER_COLOR.g - THINKING_BASE_COLOR.g) * opacity),
    b: Math.round(THINKING_BASE_COLOR.b + (THINKING_SHIMMER_COLOR.b - THINKING_BASE_COLOR.b) * opacity),
  };
}

export function spinnerElapsedTime(
  now: number,
  loadingStartTime: number,
  totalPausedMs: number,
  pauseStartTime: number | null,
): number {
  const effectiveNow = pauseStartTime ?? now;
  return Math.max(0, effectiveNow - loadingStartTime - totalPausedMs);
}

export function shouldShowSpinnerTimer(
  elapsedTimeMs: number,
  verbose: boolean,
  activeTeammateCount: number,
): boolean {
  return verbose || activeTeammateCount > 0 || elapsedTimeMs >= 30_000;
}

export function estimateSpinnerTokens(responseLength: number): number {
  const safeLength = Number.isFinite(responseLength) ? Math.max(0, responseLength) : 0;
  return Math.round(safeLength / 4);
}

export function advanceSpinnerTokenCounter(
  displayedTokens: number,
  responseLength: number,
): number {
  const current = Number.isFinite(displayedTokens) ? Math.max(0, Math.floor(displayedTokens)) : 0;
  const target = estimateSpinnerTokens(responseLength);
  const difference = target - current;
  if (difference <= 0) return current;
  const increment = difference < 70
    ? 3
    : difference < 200
      ? Math.ceil(difference * 0.15)
      : 50;
  return Math.min(target, current + increment);
}

export function totalSpinnerTokens(leaderTokens: number, teammateTokens: number): number {
  const leader = Number.isFinite(leaderTokens) ? Math.max(0, Math.floor(leaderTokens)) : 0;
  const teammates = Number.isFinite(teammateTokens) ? Math.max(0, Math.floor(teammateTokens)) : 0;
  return leader + teammates;
}

export interface SpinnerState {
  active: boolean;
  /** 从同一个动画时钟派生帧、shimmer、thinking 与计时。 */
  time: number;
  mode: SpinnerMode;
  verb: string;
  label: string;
  thinkStartTime: number | null;
  thinkingEffort: string | null;
  thinkingSummary: ThinkingSummary | null;
  stalled: boolean;
  stalledIntensity: number;
  hasActiveTools: boolean;
  reducedMotion: boolean;
  lastTokenAt: number;
  responseLength: number;
  displayedTokens: number;
  teammateTokens: number;
  loadingStartTime: number;
  totalPausedMs: number;
  pauseStartTime: number | null;
  verbose: boolean;
  context: SpinnerContextSnapshot;
  start: (mode: SpinnerMode) => void;
  stop: () => SpinnerCompletion | null;
  pause: () => void;
  resume: () => void;
  setMode: (mode: SpinnerMode) => void;
  setThinkingEffort: (effort: string | null) => void;
  setHasActiveTools: (hasActiveTools: boolean) => void;
  setLabel: (label: string) => void;
  setReducedMotion: (enabled: boolean) => void;
  setVerbose: (enabled: boolean) => void;
  setContext: (context: SpinnerContextSnapshot) => void;
  setTeammateTokens: (tokens: number) => void;
  tick: () => void;
  /** 流式增量到达；长度用于 token 粗估与停滞检测。 */
  onToken: (length?: number) => void;
}

export type SpinnerStore = StoreApi<SpinnerState>;

export function createSpinnerStore(
  verbConfig?: SpinnerVerbConfig,
  initialContext: SpinnerContextSnapshot = EMPTY_SPINNER_CONTEXT,
): SpinnerStore {
  return createStore<SpinnerState>((set, get) => ({
    active: false, time: 0, mode: 'responding', verb: '', label: '',
    thinkStartTime: null, thinkingEffort: null, thinkingSummary: null,
    stalled: false, stalledIntensity: 0, hasActiveTools: false,
    reducedMotion: false,
    lastTokenAt: 0, responseLength: 0, displayedTokens: 0, teammateTokens: 0,
    loadingStartTime: 0, totalPausedMs: 0, pauseStartTime: null,
    verbose: false, context: normalizeSpinnerContext(initialContext),

    start: (mode) => {
      const now = Date.now();
      set({ active: true, time: 0, mode, label: '',
        thinkStartTime: mode === 'thinking' ? 0 : null,
        thinkingSummary: null,
        // verb 是 turn 级值：只在 start 时抽样一次，后续 mode 切换不重新抽样。
        verb: sampleVerb(verbConfig),
        stalled: false, stalledIntensity: 0, hasActiveTools: false, lastTokenAt: now,
        responseLength: 0, displayedTokens: 0, teammateTokens: 0,
        loadingStartTime: now, totalPausedMs: 0, pauseStartTime: null });
    },
    stop: () => {
      const current = get();
      if (!current.active) return null;
      const durationMs = spinnerElapsedTime(
        Date.now(),
        current.loadingStartTime,
        current.totalPausedMs,
        current.pauseStartTime,
      );
      set({ active: false, time: 0, verb: '', label: '', thinkStartTime: null,
        thinkingSummary: null,
        stalled: false, stalledIntensity: 0, hasActiveTools: false,
        responseLength: 0, displayedTokens: 0,
        teammateTokens: 0,
        totalPausedMs: 0, pauseStartTime: null });
      return { durationMs };
    },
    pause: () => set((s) => {
      if (!s.active || s.pauseStartTime !== null) return s;
      const now = Date.now();
      return {
        pauseStartTime: now,
        time: spinnerElapsedTime(now, s.loadingStartTime, s.totalPausedMs, null),
      };
    }),
    resume: () => set((s) => {
      if (!s.active || s.pauseStartTime === null) return s;
      const pausedMs = Math.max(0, Date.now() - s.pauseStartTime);
      return {
        totalPausedMs: s.totalPausedMs + pausedMs,
        pauseStartTime: null,
        lastTokenAt: s.lastTokenAt + pausedMs,
      };
    }),
    setMode: (mode) => set((s) => {
      const enteringThinking = mode === 'thinking' && s.mode !== 'thinking';
      const leavingThinking = mode !== 'thinking' && s.mode === 'thinking';
      const thinkingSummary = enteringThinking
        ? null
        : leavingThinking && s.thinkStartTime !== null
          ? {
              durationMs: Math.max(0, s.time - s.thinkStartTime),
              visibleUntil: s.time + THINKING_SUMMARY_MIN_VISIBLE_MS,
            }
          : s.thinkingSummary;
      return {
        mode,
        thinkStartTime: enteringThinking
          ? s.time
          : mode === 'thinking'
            ? s.thinkStartTime
            : null,
        thinkingSummary,
        label: mode === 'tool-use' || mode === 'tool-input' ? s.label : '',
      };
    }),
    setThinkingEffort: (effort) => set({ thinkingEffort: effort?.trim() || null }),
    setHasActiveTools: (hasActiveTools) => set((s) => {
      if (s.hasActiveTools === hasActiveTools) return s;
      return {
        hasActiveTools,
        // 工具执行时间不计入“无输出等待”；开始和结束都从当前时刻重新计时。
        lastTokenAt: s.pauseStartTime ?? Date.now(),
        stalled: false,
      };
    }),
    setLabel: (label) => set({ label }),
    setReducedMotion: (enabled) => set({ reducedMotion: enabled }),
    setVerbose: (enabled) => set({ verbose: enabled }),
    setContext: (context) => set({ context: normalizeSpinnerContext(context) }),
    setTeammateTokens: (tokens) => set({
      teammateTokens: Number.isFinite(tokens) ? Math.max(0, Math.floor(tokens)) : 0,
    }),
    tick: () => set((s) => {
      if (!s.active) return s;
      const now = Date.now();
      const effectiveNow = s.pauseStartTime ?? now;
      const time = spinnerElapsedTime(
        now,
        s.loadingStartTime,
        s.totalPausedMs,
        s.pauseStartTime,
      );
      const lastTokenAt = s.hasActiveTools ? effectiveNow : s.lastTokenAt;
      const quietMs = effectiveNow - lastTokenAt;
      const targetIntensity = s.hasActiveTools || quietMs <= STALL_MS
        ? 0
        : Math.min(1, (quietMs - STALL_MS) / STALL_RAMP_MS);
      const stalledIntensity = s.stalledIntensity + (targetIntensity - s.stalledIntensity) * 0.1;
      const displayedTokens = advanceSpinnerTokenCounter(s.displayedTokens, s.responseLength);
      const thinkingSummary = s.thinkingSummary && time >= s.thinkingSummary.visibleUntil
        ? null
        : s.thinkingSummary;
      return {
        time,
        lastTokenAt,
        stalled: !s.hasActiveTools && quietMs > STALL_MS,
        stalledIntensity,
        displayedTokens,
        thinkingSummary,
      };
    }),
    onToken: (length = 0) => set((s) => {
      const growth = Number.isFinite(length) ? Math.max(0, length) : 0;
      if (growth === 0) return s;
      return {
        lastTokenAt: s.pauseStartTime ?? Date.now(),
        stalled: false,
        responseLength: s.responseLength + growth,
      };
    }),
  }));
}
