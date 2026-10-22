import path from 'node:path';

import type { EventWriteRequest } from '@truefoundry/trueforge-core/core/calendar/eventWrite';

import { buildEvalSources } from '../../../src/eval/fixtures';

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'evals', 'fixtures');

const NEW_EVENT: EventWriteRequest = {
  calendar_id: 'primary',
  event_id: null,
  etag: null,
  send_updates: 'none',
  body: {
    summary: 'Budget Review',
    start: { date: null, dateTime: '2026-11-09T10:00:00', timeZone: 'Europe/Lisbon' },
    end: { date: null, dateTime: '2026-11-09T11:00:00', timeZone: 'Europe/Lisbon' },
    location: 'Quayside Road Office, 14 Quayside Road, Kelvinton',
    description: undefined,
    attendees: undefined,
  },
};

describe('EvalCalendarApi', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('The eval fixtures must not reach the network.');
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('lists the fixture events that overlap the range', async () => {
    const { calendar } = buildEvalSources(FIXTURE_DIR);

    const page = await calendar.listEvents({
      timeMin: '2026-11-17T00:00:00Z',
      timeMax: '2026-11-18T00:00:00Z',
      query: undefined,
      maxResults: 10,
      pageToken: undefined,
      timeZone: 'Europe/Lisbon',
    });

    expect(page.events.map(event => event.summary)).toEqual(['Office lease walk-through']);
  });

  it('keeps a created event in memory and changes it on a patch', async () => {
    const { calendar } = buildEvalSources(FIXTURE_DIR);

    const created = await calendar.insertEvent(NEW_EVENT);
    const patched = await calendar.patchEvent({
      ...NEW_EVENT,
      event_id: created.id,
      etag: created.etag ?? null,
      body: { ...NEW_EVENT.body, summary: 'Budget Review (moved)' },
    });
    const fetched = await calendar.getEvent({ eventId: created.id, timeZone: 'Europe/Lisbon' });

    expect(patched.summary).toBe('Budget Review (moved)');
    expect(fetched.summary).toBe('Budget Review (moved)');
  });

  it('answers the calendar time zone from the fixture and never reaches the network', async () => {
    const { calendar } = buildEvalSources(FIXTURE_DIR);

    await expect(calendar.calendarTimeZone()).resolves.toBe('Europe/Lisbon');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
