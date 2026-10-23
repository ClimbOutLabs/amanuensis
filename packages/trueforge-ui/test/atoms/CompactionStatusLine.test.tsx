// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CompactionStatusLine } from '@/atoms/CompactionStatusLine.js';
import { useCompactionStatus } from '@/hooks/useCompactionStatus.js';

vi.mock('@/hooks/useCompactionStatus.js', () => ({
  useCompactionStatus: vi.fn(),
}));

const mockedStatus = vi.mocked(useCompactionStatus);

function stubStatus(overrides: Partial<ReturnType<typeof useCompactionStatus>>): void {
  mockedStatus.mockReturnValue({
    contextLimit: null,
    liveTokens: null,
    maxOutputTokens: null,
    lastCompaction: null,
    loading: false,
    ...overrides,
  });
}

describe('CompactionStatusLine', () => {
  it('stays hidden while the chat is at or under 80% of its context', () => {
    stubStatus({ contextLimit: 100_000, liveTokens: 80_000 });
    const { container } = render(<CompactionStatusLine />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows one short line once the chat is over 80% of its context', () => {
    stubStatus({ contextLimit: 100_000, liveTokens: 85_400 });
    render(<CompactionStatusLine />);

    expect(screen.getByText('This chat is 85% full.')).toBeInTheDocument();
  });

  it('stays hidden while the status loads or when the limit is unknown', () => {
    stubStatus({ contextLimit: 100_000, liveTokens: 95_000, loading: true });
    const { container, rerender } = render(<CompactionStatusLine />);
    expect(container).toBeEmptyDOMElement();

    stubStatus({ contextLimit: null, liveTokens: 95_000 });
    rerender(<CompactionStatusLine />);
    expect(container).toBeEmptyDOMElement();
  });
});
