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
    guests_line: '',
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

describe('CalendarEventDetails guest line', () => {
  it('renders the line the review supplied, word for word, for the Google producer', () => {
    render(
      <CalendarEventDetails
        event={event({ attendees: ['lin@example.com'], guests_line: 'Google will email every guest about this.' })}
      />,
    );
    expect(screen.getByText('Google will email every guest about this.')).toBeTruthy();
  });

  it('renders a guest line from a service that exists nowhere in the product, with no Google wording', () => {
    const { container } = render(
      <CalendarEventDetails
        event={event({
          attendees: ['lin@example.com'],
          guests_line: 'Moonmail will email every guest about this.',
        })}
      />,
    );
    expect(screen.getByText('Moonmail will email every guest about this.')).toBeTruthy();
    expect(container.textContent).not.toContain('Google');
  });

  it('shows no guest line when the event has no guests', () => {
    const { container } = render(<CalendarEventDetails event={event()} />);
    expect(container.querySelector('[data-role="calendar-guests-emailed"]')).toBeNull();
  });
});
