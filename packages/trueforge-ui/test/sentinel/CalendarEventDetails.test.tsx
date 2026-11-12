// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CalendarEventDetails } from '@/sentinel/CalendarEventDetails.js';
import type { SentinelApprovalCalendarEvent } from '@/sentinel/types.js';

function event(overrides: Partial<SentinelApprovalCalendarEvent> = {}): SentinelApprovalCalendarEvent {
  return {
    action: 'create',
    calendar: 'ada@example.com',
    title: 'Dentist',
    when: 'Friday at 9',
    time_zone: 'UTC',
    duration: '1 hour',
    location: '',
    description: '',
    attendees: [],
    guests_emailed: false,
    one_of_repeating: false,
    before: null,
    ...overrides,
  };
}

describe('CalendarEventDetails warnings', () => {
  it('says when the same event was already created a few minutes ago', () => {
    render(<CalendarEventDetails event={event({ already_created: true })} />);
    expect(screen.getByText('You already have this event.')).toBeTruthy();
  });

  it('says when the event runs over several days', () => {
    render(<CalendarEventDetails event={event({ span_days: 3 })} />);
    expect(screen.getByText('This event runs over 3 days.')).toBeTruthy();
  });

  it('shows no warning for an ordinary event or an older card', () => {
    const { rerender } = render(<CalendarEventDetails event={event({ already_created: false, span_days: 1 })} />);
    expect(screen.queryByText(/already have this event/)).toBeNull();
    expect(screen.queryByText(/runs over/)).toBeNull();
    rerender(<CalendarEventDetails event={event()} />);
    expect(screen.queryByText(/runs over/)).toBeNull();
  });
});
