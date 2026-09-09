import { describe, it, expect } from 'vitest';
import { filterEvents, groupByDay, groupByMonth } from '../src/core/aggregate.js';
import { UsageEvent } from '../src/core/model.js';

function ev(ts: string, agent: UsageEvent['agent'] = 'zcode', input = 1000): UsageEvent {
  return {
    ts, agent, sessionId: 's', projectDir: '/p', model: 'm',
    inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  };
}

describe('时区一致性', () => {
  const TZ = 'Asia/Shanghai'; // UTC+8

  it('filterEvents 与 groupByDay 对同一边界事件的归属一致', () => {
    // 本地 2026-06-01 02:00（= UTC 2026-05-31 18:00）：本地日=6-01，UTC 日=5-31
    const events = [ev('2026-05-31T18:00:00.000Z')];

    // 按 6 月过滤：tz 口径应包含（本地已是 6/1），UTC 口径会漏
    const june = filterEvents(events, { since: '2026-06-01', until: '2026-06-30', tz: TZ });
    expect(june).toHaveLength(1);

    // 逐日分组与过滤口径一致：该事件属于本地 6/1
    const days = groupByDay(events, TZ);
    expect(days).toHaveLength(1);
    expect(days[0].key).toBe('2026-06-01');
  });

  it('UTC 时区下同一事件归属 UTC 日期', () => {
    const events = [ev('2026-05-31T18:00:00.000Z')];
    const days = groupByDay(events, 'UTC');
    expect(days[0].key).toBe('2026-05-31');
    const june = filterEvents(events, { since: '2026-06-01', until: '2026-06-30', tz: 'UTC' });
    expect(june).toHaveLength(0);
  });

  it('月底边界：本地 7/1 凌晨的事件不进 6 月', () => {
    // 本地 2026-07-01 07:00（= UTC 6/30 23:00）
    const events = [ev('2026-06-30T23:00:00.000Z')];
    expect(groupByMonth(events, TZ)[0].key).toBe('2026-07');
    expect(filterEvents(events, { since: '2026-06-01', until: '2026-06-30', tz: TZ })).toHaveLength(0);
  });

  it('agent 与 project 过滤仍生效', () => {
    const events = [
      ev('2026-06-01T00:00:00.000Z', 'claude'),
      { ...ev('2026-06-01T00:00:00.000Z', 'zcode'), projectDir: '/other' },
    ];
    expect(filterEvents(events, { agent: ['claude'], tz: 'UTC' })).toHaveLength(1);
    expect(filterEvents(events, { project: 'other', tz: 'UTC' })).toHaveLength(1);
  });
});
