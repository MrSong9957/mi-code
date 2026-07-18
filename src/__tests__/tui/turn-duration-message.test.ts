import { describe, expect, it, vi } from 'vitest';
import {
  TURN_COMPLETION_VERBS,
  TurnDurationMessage,
  createTurnDurationMessage,
} from '../../tui/state/turn-duration-message.js';
import { formatSpinnerDuration } from '../../tui/state/spinner-store.js';

describe('turn duration message', () => {
  it('创建时固定一次完成动词、时长、前导空行和 dim 样式', () => {
    const random = vi.fn(() => 0.5);

    const message = createTurnDurationMessage({
      uuid: 'msg-7', durationMs: 9_000, prependBlankLine: true, random,
    });

    expect(TURN_COMPLETION_VERBS).toHaveLength(8);
    expect(random).toHaveBeenCalledTimes(1);
    expect(message).toMatchObject({
      uuid: 'msg-7', role: 'system', kind: 'turn-duration',
      verb: 'Cooked', durationMs: 9_000, finalized: true,
    });
    expect(message.lines).toEqual([
      { content: '', style: {}, indent: 0 },
      { content: '✻ Cooked for 9s', style: { dim: true }, indent: 0 },
    ]);
    expect(TurnDurationMessage(message.verb, message.durationMs))
      .toEqual(message.lines[1]);
    expect(random).toHaveBeenCalledTimes(1);
  });
});

describe('formatSpinnerDuration 边界值', () => {
  // 完成消息最终渲染的时长字符串完全由 formatSpinnerDuration 决定，
  // 边界值若回归会让完成消息显示成 '0s'、'1m 0s'、'1h' 等错误格式。
  it('0ms 钳位为 1s（Math.max(1, ...) 防御）', () => {
    expect(formatSpinnerDuration(0)).toBe('1s');
  });

  it('负值钳位为 1s（系统时间回退/异常输入防御）', () => {
    expect(formatSpinnerDuration(-500)).toBe('1s');
    expect(formatSpinnerDuration(-10_000)).toBe('1s');
  });

  it('整分钟输出无余秒（rest===0 分支，不输出 "1m 0s"）', () => {
    expect(formatSpinnerDuration(60_000)).toBe('1m');
    expect(formatSpinnerDuration(120_000)).toBe('2m');
  });

  it('小时级用分钟累计（不溢出为 "1h"）', () => {
    expect(formatSpinnerDuration(3_600_000)).toBe('60m');
    expect(formatSpinnerDuration(5_400_000)).toBe('90m');
  });
});

describe('createTurnDurationMessage 完成动词抽样分布', () => {
  // random 边界与全分布覆盖：防止有人把 Math.floor 改成 Math.round 导致
  // 'Worked'（最后一个 verb）永远命中不到，或长度改错导致越界返回 undefined。
  it('random=0 抽中首个 verb（左闭区间边界）', () => {
    const message = createTurnDurationMessage({
      uuid: 'm0', durationMs: 1_000, prependBlankLine: false, random: () => 0,
    });
    expect(message.verb).toBe(TURN_COMPLETION_VERBS[0]);
    expect(message.verb).toBe('Baked');
  });

  it('random 接近 1 抽中末个 verb（右开区间边界）', () => {
    const message = createTurnDurationMessage({
      uuid: 'm7', durationMs: 1_000, prependBlankLine: false, random: () => 0.9999,
    });
    expect(message.verb).toBe(TURN_COMPLETION_VERBS[TURN_COMPLETION_VERBS.length - 1]);
    expect(message.verb).toBe('Worked');
  });

  it.each(TURN_COMPLETION_VERBS.map((verb, index) => ({ verb, index })))(
    '每个 verb 都能被命中（verb=$verb, index=$index）',
    ({ index }) => {
      // 8 个 verb 把 [0,1) 等分为 8 段，每段长度 1/8 = 0.125。
      // index=0 → [0, 0.125)；index=7 → [0.875, 1)。
      // 取每段中点稳定命中（避开边界精度问题）。
      const mid = (index + 0.5) / TURN_COMPLETION_VERBS.length;
      const message = createTurnDurationMessage({
        uuid: `m-${index}`, durationMs: 1_000,
        prependBlankLine: false, random: () => mid,
      });
      expect(message.verb).toBe(TURN_COMPLETION_VERBS[index]);
    },
  );

  it('抽样结果嵌入完成行文本与样式', () => {
    const message = createTurnDurationMessage({
      uuid: 'm-text', durationMs: 3_600_000,
      prependBlankLine: false, random: () => 0,
    });
    // 抽中 'Baked'，时长走小时级 '60m' 分支——两个边界一起验证。
    expect(message.lines[0]).toEqual({
      content: '✻ Baked for 60m', style: { dim: true }, indent: 0,
    });
  });
});
