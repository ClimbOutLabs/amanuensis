import type { CalendarApiPort } from '@truefoundry/trueforge-core/core/calendar/CalendarApi';
import type { CalendarEvent } from '@truefoundry/trueforge-core/core/calendar/calendarWire';

import { googleCalendarSource } from '../../../../src/runtime/noticing/googleSources';

const NOW = new Date('2026-11-05T15:00:00.000Z');

describe('Google Calendar source', () => {
  const timed = (id: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id,
    summary: id,
    start: { dateTime: '2026-11-05T16:00:00.000Z' },
    end: { dateTime: '2026-11-05T17:00:00.000Z' },
    ...extra,
  });
  const me = { email: 'me@example.com', self: true };
  const stranger = { email: 'stranger@example.com' };

  function sourceOf(events: CalendarEvent[]) {
    const api: Pick<CalendarApiPort, 'listEvents'> = {
      listEvents: () => Promise.resolve({ events, nextPageToken: undefined }),
    };
    return googleCalendarSource({ api, timeZone: 'UTC' });
  }

  it('leaves out cancelled, declined and all-day events', async () => {
    const events = await sourceOf([
      timed('on', { organizer: me }),
      timed('cancelled', { status: 'cancelled', organizer: me }),
      timed('declined', { organizer: stranger, attendees: [{ ...me, responseStatus: 'declined' }] }),
      { id: 'all-day', start: { date: '2026-11-05' }, end: { date: '2026-11-06' } },
    ]).listEvents({ from: NOW, to: new Date('2026-11-06T15:00:00.000Z') });
    expect(events.map(item => item.id)).toEqual(['on']);
  });

  it('counts an event as the person’s own only when they organised or accepted it', async () => {
    const events = await sourceOf([
      timed('organised', { organizer: me, attendees: [{ ...stranger, responseStatus: 'needsAction' }] }),
      timed('accepted', { organizer: stranger, attendees: [{ ...me, responseStatus: 'accepted' }] }),
      timed('invite', { organizer: stranger, attendees: [{ ...me, responseStatus: 'needsAction' }] }),
      timed('maybe', { organizer: stranger, attendees: [{ ...me, responseStatus: 'tentative' }] }),
    ]).listEvents({ from: NOW, to: new Date('2026-11-06T15:00:00.000Z') });
    expect(events.map(item => [item.id, item.own])).toEqual([
      ['organised', true],
      ['accepted', true],
      ['invite', false],
      ['maybe', false],
    ]);
  });
});
