import winston from 'winston';

import {
  CALENDAR_WATCH_INTERVAL_MS,
  MAIL_WATCH_INTERVAL_MS,
  noticingLoops,
} from '../../../src/controller/noticingLoops';

describe('noticingLoops', () => {
  it('runs mail every 10 minutes and the calendar every 30, passing the watcher name', async () => {
    const run = jest.fn().mockResolvedValue({ owners: 1, raised: 0 });
    const loops = noticingLoops({ logger: winston.createLogger({ silent: true }), run });
    const byName = new Map(loops.map(loop => [loop.name, loop]));
    expect(byName.get('noticing-mail')?.intervalMs).toBe(MAIL_WATCH_INTERVAL_MS);
    expect(MAIL_WATCH_INTERVAL_MS).toBe(600_000);
    expect(byName.get('noticing-calendar')?.intervalMs).toBe(CALENDAR_WATCH_INTERVAL_MS);
    expect(CALENDAR_WATCH_INTERVAL_MS).toBe(1_800_000);
    await byName.get('noticing-calendar')?.tick(new AbortController().signal);
    expect(run).toHaveBeenCalledWith('calendar');
  });
});
