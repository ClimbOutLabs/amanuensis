import { validateManifest } from '../../../src/runtime/cron';
import {
  CronExpressionSchema,
  InvalidCronError,
  ScheduleManifestSchema,
  TimezoneSchema,
} from '../../../src/schemas/schedule';

const WEEKDAY_1PM = { cron: '0 13 * * 1-5', run_at: null, status: 'active' as const, timezone: 'America/New_York' };

describe('CronExpressionSchema', () => {
  it('rejects a non-5-field cron', () => {
    expect(CronExpressionSchema.safeParse('0 13 * *').success).toBe(false);
    expect(CronExpressionSchema.safeParse('not a cron').success).toBe(false);
  });

  it('accepts a 5-field cron', () => {
    expect(CronExpressionSchema.safeParse('0 0 * * *').success).toBe(true);
  });
});

describe('TimezoneSchema', () => {
  it('rejects a non-IANA timezone', () => {
    expect(TimezoneSchema.safeParse('UTC+5:30').success).toBe(false);
    expect(TimezoneSchema.safeParse('Not/A_Zone').success).toBe(false);
  });

  it('accepts a valid IANA timezone', () => {
    expect(TimezoneSchema.safeParse('America/New_York').success).toBe(true);
  });
});

describe('validateManifest', () => {
  it('accepts the minimum interval', () => {
    expect(() => {
      validateManifest({ cron: '0 * * * *', run_at: null, status: 'active', timezone: 'UTC' });
    }).not.toThrow();
  });

  it('accepts a daily schedule', () => {
    expect(() => {
      validateManifest(WEEKDAY_1PM);
    }).not.toThrow();
  });

  it('accepts a yearly cron', () => {
    expect(() => {
      validateManifest(
        { cron: '0 0 1 1 *', run_at: null, status: 'active', timezone: 'UTC' },
        new Date('2026-08-27T12:00:00.000Z'),
      );
    }).not.toThrow();
  });

  it('rejects a cron tighter than one hour', () => {
    expect(() => {
      validateManifest({ cron: '*/5 * * * *', run_at: null, status: 'active', timezone: 'UTC' });
    }).toThrow(InvalidCronError);
  });

  it('rejects a back-dated cron with no upcoming trigger time', () => {
    expect(() => {
      validateManifest({ cron: '0 0 30 2 *', run_at: null, status: 'active', timezone: 'UTC' });
    }).toThrow(InvalidCronError);
  });
});

describe('one-time schedule', () => {
  const NOW = new Date('2026-10-26T12:00:00.000Z');
  const once = (run_at: string, status: 'active' | 'paused' | 'done' = 'active') => ({
    cron: null,
    run_at,
    status,
    timezone: 'UTC',
  });

  it('accepts a time in the future, and does not apply the hourly minimum', () => {
    expect(() => {
      validateManifest(once('2026-10-26T12:10:00+00:00'), NOW);
    }).not.toThrow();
  });

  it('refuses a time in the past with a plain message', () => {
    expect(() => {
      validateManifest(once('2026-10-26T07:00:00-04:00'), NOW);
    }).toThrow('That time has already passed. Pick a time in the future and try again.');
  });

  it('lets a finished one keep its old time', () => {
    expect(() => {
      validateManifest(once('2026-10-01T07:00:00-04:00', 'done'), NOW);
    }).not.toThrow();
  });

  it('needs exactly one of cron and run_at', () => {
    const base = { task: 'Take the medicine', timezone: 'UTC' };
    expect(ScheduleManifestSchema.safeParse({ ...base }).success).toBe(false);
    expect(
      ScheduleManifestSchema.safeParse({ ...base, cron: '0 9 * * *', run_at: '2026-10-26T18:00:00-04:00' }).success,
    ).toBe(false);
    expect(ScheduleManifestSchema.safeParse({ ...base, run_at: '2026-10-26T18:00:00' }).success).toBe(false);
    expect(ScheduleManifestSchema.parse({ ...base, run_at: '2026-10-26T18:00:00-04:00' })).toMatchObject({
      cron: null,
      kind: 'task',
      status: 'active',
    });
  });

  it('reads a manifest saved before one-time schedules existed', () => {
    expect(
      ScheduleManifestSchema.parse({ task: 'Daily', cron: '0 9 * * *', timezone: 'UTC', status: 'active' }),
    ).toEqual({
      task: 'Daily',
      cron: '0 9 * * *',
      run_at: null,
      timezone: 'UTC',
      status: 'active',
      kind: 'task',
    });
  });
});
