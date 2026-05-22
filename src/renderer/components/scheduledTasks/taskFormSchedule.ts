import type { Schedule } from '../../types/scheduledTask';

export type ScheduleMode = 'once' | 'interval' | 'daily' | 'weekly' | 'monthly' | 'cron';
export type IntervalUnit = 'minutes' | 'hours' | 'days';

export interface ScheduleFormState {
  mode: ScheduleMode;
  date: string;
  time: string;
  weekday: number;
  monthDay: number;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  cronExpression: string;
}

const UNIT_TO_MS: Record<IntervalUnit, number> = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

const DEFAULT_FORM_STATE: ScheduleFormState = {
  mode: 'once',
  date: '',
  time: '09:00',
  weekday: 1,
  monthDay: 1,
  intervalValue: 5,
  intervalUnit: 'minutes',
  cronExpression: '',
};

function parsePositiveInteger(value: string | number | undefined | null): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | number | undefined | null): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function parseCronInterval(expression: string): Pick<ScheduleFormState, 'intervalUnit' | 'intervalValue'> | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const minuteMatch = minute.match(/^\*\/(\d+)$/);
    const intervalValue = parsePositiveInteger(minuteMatch?.[1]);
    if (intervalValue != null) {
      return { intervalUnit: 'minutes', intervalValue };
    }
  }

  if (minute === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const hourMatch = hour.match(/^\*\/(\d+)$/);
    const intervalValue = parsePositiveInteger(hourMatch?.[1]);
    if (intervalValue != null) {
      return { intervalUnit: 'hours', intervalValue };
    }
  }

  return null;
}

export function parseScheduleToFormState(schedule: Schedule): ScheduleFormState {
  const defaults = { ...DEFAULT_FORM_STATE };

  if (schedule.type === 'at') {
    const dt = schedule.datetime ?? '';
    if (dt.includes('T')) {
      return { ...defaults, mode: 'once', date: dt.slice(0, 10), time: dt.slice(11, 16) };
    }
    return { ...defaults, mode: 'once', date: dt.slice(0, 10) };
  }

  if (schedule.type === 'interval') {
    return {
      ...defaults,
      mode: 'interval',
      intervalUnit: schedule.unit ?? 'minutes',
      intervalValue: parsePositiveInteger(schedule.value) ?? 5,
    };
  }

  if (schedule.type === 'cron' && schedule.expression) {
    const expression = schedule.expression.trim();
    const interval = parseCronInterval(expression);
    if (interval) {
      return { ...defaults, mode: 'interval', cronExpression: expression, ...interval };
    }

    const parts = expression.split(/\s+/);
    if (parts.length === 5) {
      const [minute, hour, dayOfMonth, , dayOfWeek] = parts;
      const minuteValue = parseNonNegativeInteger(minute);
      const hourValue = parseNonNegativeInteger(hour);
      const time = minuteValue != null && hourValue != null
        ? `${String(hourValue).padStart(2, '0')}:${String(minuteValue).padStart(2, '0')}`
        : defaults.time;

      if (minuteValue != null && hourValue != null && dayOfWeek !== '*' && dayOfMonth === '*') {
        return {
          ...defaults,
          mode: 'weekly',
          time,
          weekday: parsePositiveInteger(dayOfWeek) ?? 0,
          cronExpression: expression,
        };
      }
      if (minuteValue != null && hourValue != null && dayOfMonth !== '*' && dayOfWeek === '*') {
        return {
          ...defaults,
          mode: 'monthly',
          time,
          monthDay: parsePositiveInteger(dayOfMonth) ?? 1,
          cronExpression: expression,
        };
      }
      if (minuteValue != null && hourValue != null) {
        return { ...defaults, mode: 'daily', time, cronExpression: expression };
      }
    }

    return { ...defaults, mode: 'cron', cronExpression: expression };
  }

  return defaults;
}

export function buildScheduleFromFormState(state: ScheduleFormState): Schedule {
  const [hour, minute] = state.time.split(':').map(Number);

  switch (state.mode) {
    case 'once':
      return { type: 'at', datetime: `${state.date}T${state.time}` };
    case 'interval': {
      const intervalValue = parsePositiveInteger(state.intervalValue) ?? 1;
      const intervalUnit = state.intervalUnit;
      return {
        type: 'interval',
        intervalMs: intervalValue * UNIT_TO_MS[intervalUnit],
        unit: intervalUnit,
        value: intervalValue,
      };
    }
    case 'daily':
      return { type: 'cron', expression: `${minute} ${hour} * * *` };
    case 'weekly':
      return { type: 'cron', expression: `${minute} ${hour} * * ${state.weekday}` };
    case 'monthly':
      return { type: 'cron', expression: `${minute} ${hour} ${state.monthDay} * *` };
    case 'cron':
      return { type: 'cron', expression: state.cronExpression.trim() };
  }
}
