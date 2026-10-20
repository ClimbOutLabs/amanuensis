/**
 * What a calendar read puts in front of the model: a removed event is named with the same
 * plain words the write path uses, so the two never drift apart.
 */
import { getEventResult } from '../../../src/core/calendar/results';

const CONTEXT = { account: 'test account', zone: 'America/New_York' };

describe('getEventResult', () => {
  it("says a cancelled event was already removed, in the write path's words", () => {
    const result = getEventResult({
      context: CONTEXT,
      event: {
        id: 'evt-1',
        status: 'cancelled',
        summary: 'Dentist',
        start: { dateTime: '2026-10-27T14:30:00-04:00' },
        end: { dateTime: '2026-10-27T15:00:00-04:00' },
      },
    });
    expect(result.note).toBe('That event was already removed.');
  });

  it('adds no such note for a live event', () => {
    const result = getEventResult({
      context: CONTEXT,
      event: {
        id: 'evt-1',
        status: 'confirmed',
        summary: 'Dentist',
        start: { dateTime: '2026-10-27T14:30:00-04:00' },
        end: { dateTime: '2026-10-27T15:00:00-04:00' },
      },
    });
    expect(result.note).toBeUndefined();
  });
});
