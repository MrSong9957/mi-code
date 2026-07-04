// 帧调度器：合并多源 flush 请求，idle 自动停摆省 CPU
//
// 物理本质：红绿灯调度员。
// 多个写屏源（按键、流式 token、spinner tick、状态变化）都来敲门 requestFrame()，
// 调度员不立刻开门——而是攒着，每隔 intervalMs 开一次门，把攒的这一批一次性放行（合并成一帧）。
// 连续若干个 interval 没人敲门，调度员下班（stop setInterval）省 CPU；
// 下次有人敲门再重新上班。
//
// 解决的核心问题（C1 节流冲突）：
// mi-code 没有 React 的批处理，流式 delta / 按键 / spinner tick 是独立的 flush 源。
// 若各画各的会交叉写屏闪烁。FrameScheduler 把它们统一到一个节拍：
// 所有源只调 requestFrame()（标记脏），真正的 flushFn 只在每个 interval 调一次。

export interface FrameSchedulerOptions {
  /** 连续多少个 interval 无 requestFrame 后自动 stop（省 CPU）。默认 3。 */
  idleStopIntervals?: number;
}

const DEFAULT_INTERVAL_MS = 80;
const DEFAULT_IDLE_STOP = 3;

export class FrameScheduler {
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private idleStopIntervals: number;
  private idleCount = 0;
  private flushFn: () => void;

  constructor(flushFn: () => void, intervalMs: number = DEFAULT_INTERVAL_MS, opts?: FrameSchedulerOptions) {
    this.flushFn = flushFn;
    // intervalMs <= 0 视为非法，回退默认值（避免除零 / 立即触发风暴）
    this.intervalMs = intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
    this.idleStopIntervals = opts?.idleStopIntervals ?? DEFAULT_IDLE_STOP;
  }

  /** 标记脏（请求下一帧刷新）。若调度器空闲则启动 tick 循环。 */
  requestFrame(): void {
    this.dirty = true;
    this.idleCount = 0;
    if (this.timer === null) {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }
  }

  /** 立即强制 flush（绕过调度）。用于 enter/exit/resize 必须立即可见的场景。
   *  调用后清脏标记，避免下一 interval 重复 flush。 */
  flushNow(): void {
    this.dirty = false;
    this.idleCount = 0;
    this.flushFn();
  }

  /** 停止调度器（清 setInterval）。幂等。 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.dirty = false;
    this.idleCount = 0;
  }

  /** 调度器是否在运行（有活跃的 setInterval）。 */
  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** 单次 tick：脏则 flush，否则累积 idle 计数，达阈值则 stop。 */
  private tick(): void {
    if (this.dirty) {
      this.dirty = false;
      this.idleCount = 0;
      this.flushFn();
    } else {
      this.idleCount++;
      if (this.idleCount >= this.idleStopIntervals) {
        this.stop();
      }
    }
  }
}
