/**
 * 调度规则归一化：把模型产出的"友好形态" JSON 映射为 DSH Host-wide Schedule 的真实契约。
 *
 * 真实契约（dsh-schedule 0.2.2，ScheduleTiming）：
 *   after  { kind:'after',  after_seconds }
 *   at     { kind:'at',     at: string | { date, time, time_zone } }
 *   every  { kind:'every',  every_seconds }
 *   daily  { kind:'daily',  daily:  { time:'HH:mm:ss', time_zone } }
 *   weekly { kind:'weekly', weekly: { time:'HH:mm:ss', time_zone, weekdays:number[] } }
 *   cron   { kind:'cron',   cron:   { expression, time_zone } }
 *   rrule  { kind:'rrule',  rrule: string }
 *
 * 模型通常给出 { kind:'daily', time:'09:00' } 这类扁平形态——直接透传会让 Host 拒绝建单，
 * 故此处做归一化（真实形态亦被接受）。
 */
import type { ScheduleCreateRequest } from '@deepseek-ai/dsh-schedule';

type Timing = ScheduleCreateRequest['timing'];

/** 调度参数不可用（机器可读错误）。 */
export class ScheduleTimingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleTimingError';
  }
}

const WEEKDAY_NAMES: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
};

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** 默认时区：宿主本地时区（IANA 名）。 */
export function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 归一化本地时钟为 HH:mm:ss（容忍 H:mm 与缺秒）。 */
export function normalizeClock(input: string): string {
  const trimmed = input.trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(trimmed);
  if (!match) throw new ScheduleTimingError(`时间格式无效（应为 HH:mm 或 HH:mm:ss）：${input}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? '0');
  if (hour > 23 || minute > 59 || second > 59) throw new ScheduleTimingError(`时间超出范围：${input}`);
  const fraction = match[4] ? `.${match[4]}` : '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}${fraction}`;
}

/** 归一化星期集合（1-7 或英文名）。 */
export function normalizeWeekdays(input: unknown): number[] {
  if (!Array.isArray(input) || input.length === 0) throw new ScheduleTimingError('weekly 需要 weekdays（1-7 或英文缩写）');
  const days = new Set<number>();
  for (const item of input) {
    if (typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= 7) {
      days.add(item);
      continue;
    }
    if (typeof item === 'string') {
      const mapped = WEEKDAY_NAMES[item.trim().toLowerCase()];
      if (mapped !== undefined) {
        days.add(mapped);
        continue;
      }
    }
    throw new ScheduleTimingError(`weekdays 含无效项：${String(item)}（应为 1-7 或英文缩写）`);
  }
  return [...days].sort((left, right) => left - right);
}

/**
 * 归一化调度参数。
 * @param input - 模型给出的友好形态或真实契约形态
 * @returns 真实 ScheduleTiming
 */
export function normalizeScheduleTiming(input: unknown): Timing {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ScheduleTimingError('timing 必须是对象');
  }
  const record = input as Record<string, unknown>;
  const kind = (readString(record, ['kind', 'type']) ?? '').toLowerCase();
  const zone = readString(record, ['time_zone', 'timezone', 'zone', 'tz']) ?? defaultTimeZone();

  if (kind === 'daily') {
    const nested = record['daily'];
    const nestedRecord = typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : undefined;
    const time = normalizeClock(
      readString(record, ['time', 'daily_time', 'timeOfDay', 'at_time'])
      ?? (nestedRecord ? readString(nestedRecord, ['time']) ?? '' : ''),
    );
    const timeZone = readString(record, ['time_zone', 'timezone', 'zone', 'tz'])
      ?? (nestedRecord ? readString(nestedRecord, ['time_zone', 'timezone']) : undefined)
      ?? zone;
    return { kind: 'daily', daily: { time, time_zone: timeZone } };
  }

  if (kind === 'weekly') {
    const nested = record['weekly'];
    const nestedRecord = typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : undefined;
    const time = normalizeClock(
      readString(record, ['time', 'weekly_time', 'timeOfDay'])
      ?? (nestedRecord ? readString(nestedRecord, ['time']) ?? '' : ''),
    );
    const weekdays = normalizeWeekdays(record['weekdays'] ?? record['days'] ?? record['weekday'] ?? nestedRecord?.['weekdays']);
    const timeZone = readString(record, ['time_zone', 'timezone', 'zone', 'tz'])
      ?? (nestedRecord ? readString(nestedRecord, ['time_zone', 'timezone']) : undefined)
      ?? zone;
    return { kind: 'weekly', weekly: { time, time_zone: timeZone, weekdays } };
  }

  if (kind === 'every') {
    const seconds = readNumber(record, ['every_seconds', 'everySeconds', 'seconds', 'interval_seconds'])
      ?? (readNumber(record, ['minutes', 'interval_minutes', 'every_minutes']) !== undefined
        ? (readNumber(record, ['minutes', 'interval_minutes', 'every_minutes']) as number) * 60
        : undefined);
    if (seconds === undefined) throw new ScheduleTimingError('every 需要 every_seconds（或 minutes）');
    return { kind: 'every', every_seconds: Math.round(seconds) };
  }

  if (kind === 'after') {
    const seconds = readNumber(record, ['after_seconds', 'afterSeconds', 'seconds', 'delay_seconds'])
      ?? (readNumber(record, ['minutes', 'delay_minutes']) !== undefined
        ? (readNumber(record, ['minutes', 'delay_minutes']) as number) * 60
        : undefined);
    if (seconds === undefined) throw new ScheduleTimingError('after 需要 after_seconds（或 minutes）');
    return { kind: 'after', after_seconds: Math.round(seconds) };
  }

  if (kind === 'at') {
    const at = record['at'];
    if (typeof at === 'string' && at.trim() !== '') return { kind: 'at', at: at.trim() };
    if (typeof at === 'object' && at !== null) {
      const atRecord = at as Record<string, unknown>;
      const date = readString(atRecord, ['date']);
      const time = readString(atRecord, ['time']);
      if (date !== undefined && time !== undefined) {
        return {
          kind: 'at',
          at: { date, time: normalizeClock(time), time_zone: readString(atRecord, ['time_zone', 'timezone']) ?? zone },
        };
      }
    }
    const fallbackDate = readString(record, ['date']);
    const fallbackTime = readString(record, ['time', 'at_time']);
    if (fallbackDate !== undefined && fallbackTime !== undefined) {
      return { kind: 'at', at: { date: fallbackDate, time: normalizeClock(fallbackTime), time_zone: zone } };
    }
    throw new ScheduleTimingError('at 需要 at（ISO 时刻）或 date+time');
  }

  if (kind === 'cron') {
    const nested = record['cron'];
    const expression = typeof nested === 'string'
      ? nested.trim()
      : readString(record, ['expression', 'cron_expression']) ?? (typeof nested === 'object' && nested !== null ? readString(nested as Record<string, unknown>, ['expression']) : undefined);
    if (expression === undefined || expression === '') throw new ScheduleTimingError('cron 需要 expression（五段式）');
    const timeZone = readString(record, ['time_zone', 'timezone', 'zone', 'tz'])
      ?? (typeof nested === 'object' && nested !== null ? readString(nested as Record<string, unknown>, ['time_zone', 'timezone']) : undefined)
      ?? zone;
    return { kind: 'cron', cron: { expression, time_zone: timeZone } };
  }

  if (kind === 'rrule') {
    const rrule = readString(record, ['rrule', 'rule']) ?? (typeof record['rrule'] === 'string' ? record['rrule'] : undefined);
    if (rrule === undefined) throw new ScheduleTimingError('rrule 需要 rrule 字符串');
    return { kind: 'rrule', rrule };
  }

  throw new ScheduleTimingError(`不支持的调度类型：${kind === '' ? '(缺失 kind)' : kind}（支持 after/at/every/daily/weekly/cron/rrule）`);
}
