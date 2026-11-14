import { describe, expect, it } from 'vitest';
import { defaultTimeZone, normalizeClock, normalizeScheduleTiming, normalizeWeekdays, ScheduleTimingError } from '../../src/protocols/schedule-timing.js';

describe('调度规则归一化（模型友好形态 → Host 真实契约）', () => {
  it('daily 友好形态 → 嵌套契约（补秒、补时区）', () => {
    const timing = normalizeScheduleTiming({ kind: 'daily', time: '09:00' });
    expect(timing).toEqual({ kind: 'daily', daily: { time: '09:00:00', time_zone: defaultTimeZone() } });
  });

  it('daily 真实形态透传（保留显式时区）', () => {
    const timing = normalizeScheduleTiming({ kind: 'daily', daily: { time: '08:30:00', time_zone: 'Asia/Shanghai' } });
    expect(timing).toEqual({ kind: 'daily', daily: { time: '08:30:00', time_zone: 'Asia/Shanghai' } });
  });

  it('every：minutes 折算秒、every_seconds 直用', () => {
    expect(normalizeScheduleTiming({ kind: 'every', minutes: 30 })).toEqual({ kind: 'every', every_seconds: 1800 });
    expect(normalizeScheduleTiming({ kind: 'every', every_seconds: 600 })).toEqual({ kind: 'every', every_seconds: 600 });
  });

  it('after：seconds / after_seconds', () => {
    expect(normalizeScheduleTiming({ kind: 'after', seconds: 90 })).toEqual({ kind: 'after', after_seconds: 90 });
  });

  it('weekly：英文星期名归一为 1-7 并排序去重', () => {
    const timing = normalizeScheduleTiming({ kind: 'weekly', time: '9:00', weekdays: ['fri', 'mon', 'mon'] });
    expect(timing).toEqual({ kind: 'weekly', weekly: { time: '09:00:00', time_zone: defaultTimeZone(), weekdays: [1, 5] } });
  });

  it('cron：expression + 时区', () => {
    const timing = normalizeScheduleTiming({ kind: 'cron', expression: '0 9 * * *', time_zone: 'UTC' });
    expect(timing).toEqual({ kind: 'cron', cron: { expression: '0 9 * * *', time_zone: 'UTC' } });
  });

  it('at：ISO 字符串与 date+time 两形态', () => {
    expect(normalizeScheduleTiming({ kind: 'at', at: '2026-12-01T09:00:00Z' })).toEqual({ kind: 'at', at: '2026-12-01T09:00:00Z' });
    const timing = normalizeScheduleTiming({ kind: 'at', date: '2026-12-01', time: '09:00' });
    expect(timing).toEqual({ kind: 'at', at: { date: '2026-12-01', time: '09:00:00', time_zone: defaultTimeZone() } });
  });

  it('rrule 字符串透传', () => {
    expect(normalizeScheduleTiming({ kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9' })).toEqual({ kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9' });
  });

  it('非法输入抛出可读错误', () => {
    expect(() => normalizeScheduleTiming({ kind: 'daily', time: '25:00' })).toThrow(ScheduleTimingError);
    expect(() => normalizeScheduleTiming({ kind: 'weekly', time: '09:00', weekdays: [9] })).toThrow(ScheduleTimingError);
    expect(() => normalizeScheduleTiming({ kind: 'yearly' })).toThrow(ScheduleTimingError);
    expect(() => normalizeScheduleTiming({ time: '09:00' })).toThrow(ScheduleTimingError);
    expect(() => normalizeScheduleTiming('daily')).toThrow(ScheduleTimingError);
  });

  it('时钟与星期辅助函数', () => {
    expect(normalizeClock('9:00')).toBe('09:00:00');
    expect(normalizeClock('23:59:59')).toBe('23:59:59');
    expect(() => normalizeClock('abc')).toThrow(ScheduleTimingError);
    expect(normalizeWeekdays([7, 1, 1])).toEqual([1, 7]);
    expect(normalizeWeekdays(['sunday'])).toEqual([7]);
  });
});
