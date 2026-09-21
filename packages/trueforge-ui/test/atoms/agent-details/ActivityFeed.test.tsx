// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ActivityFeed } from '@/atoms/agent-details/ActivityFeed.js';
import type { SessionEventTimelineSegment, SessionEventType } from '@/utils/sessionEventTimeline.js';

let nextId = 0;
function makeSegment(
  partial: Partial<SessionEventTimelineSegment> & { type: SessionEventType },
): SessionEventTimelineSegment {
  nextId += 1;
  return {
    id: `seg-${nextId}`,
    title: '',
    description: '',
    startMs: 0,
    endMs: 0,
    turnIndex: 0,
    threadId: 'main',
    ...partial,
  };
}

function webSearch(startMs: number): SessionEventTimelineSegment {
  return makeSegment({ type: 'tool_call', description: 'tavily_search', startMs, endMs: startMs + 1_000 });
}

describe('ActivityFeed', () => {
  it('renders tool calls in plain language without leaking tool names', () => {
    render(<ActivityFeed segments={[webSearch(0)]} originMs={1_000_000} />);

    expect(screen.getByText('Searched the web')).toBeInTheDocument();
    expect(screen.queryByText('tavily_search')).not.toBeInTheDocument();
  });

  it('collapses and expands the item list from the header toggle', () => {
    render(<ActivityFeed segments={[webSearch(0)]} originMs={1_000_000} />);

    const toggle = screen.getByRole('button', { name: 'Activity' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Searched the web')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Searched the web')).toBeInTheDocument();
  });

  it('starts collapsed when defaultExpanded is false', () => {
    render(<ActivityFeed segments={[webSearch(0)]} originMs={1_000_000} defaultExpanded={false} />);

    expect(screen.getByRole('button', { name: 'Activity' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Searched the web')).not.toBeInTheDocument();
  });

  it('renders nothing when no segment produces an activity item', () => {
    const { container } = render(
      <ActivityFeed segments={[makeSegment({ type: 'model', startMs: 0, endMs: 1_000 })]} originMs={1_000_000} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
