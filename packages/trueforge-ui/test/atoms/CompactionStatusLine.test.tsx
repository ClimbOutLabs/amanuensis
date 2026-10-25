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
  it('says how much of the model memory the chat uses, small and in the muted colour', () => {
    stubStatus({ contextLimit: 128_000, liveTokens: 12_500 });
    render(<CompactionStatusLine />);

    const line = screen.getByText("This chat uses 10% of the model's memory (13K of 128K tokens).");
    expect(line).toHaveAttribute('data-slot', 'aui_compaction-status');
    expect(line).toHaveClass('text-text-muted', 'text-[0.75rem]', 'font-normal');
    expect(line).toHaveAttribute('title', expect.stringContaining("model's memory"));
  });

  it('shows the line however little the chat uses', () => {
    stubStatus({ contextLimit: 200_000, liveTokens: 900 });
    render(<CompactionStatusLine />);

    expect(screen.getByText("This chat uses 0% of the model's memory (900 of 200K tokens).")).toBeInTheDocument();
  });

  it('gives the size alone when the model limit is unknown', () => {
    stubStatus({ liveTokens: 4_000 });
    render(<CompactionStatusLine />);

    expect(screen.getByText("This chat uses 4K tokens of the model's memory.")).toBeInTheDocument();
  });

  it('adds when older messages were last shortened', () => {
    stubStatus({
      contextLimit: 100_000,
      liveTokens: 50_000,
      lastCompaction: { outcome: 'applied', createdAt: new Date().toISOString() },
    });
    render(<CompactionStatusLine />);

    expect(
      screen.getByText(/50% of the model's memory .* Older messages were shortened just now\./),
    ).toBeInTheDocument();
  });

  it('stays hidden while the status loads or before the chat has a size', () => {
    stubStatus({ contextLimit: 100_000, liveTokens: 95_000, loading: true });
    const { container, rerender } = render(<CompactionStatusLine />);
    expect(container).toBeEmptyDOMElement();

    stubStatus({ contextLimit: 100_000 });
    rerender(<CompactionStatusLine />);
    expect(container).toBeEmptyDOMElement();
  });
});
