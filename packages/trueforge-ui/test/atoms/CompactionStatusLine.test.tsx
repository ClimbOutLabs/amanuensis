// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CompactionStatusLine, formatRelativeTime, formatTokenCount } from '@/atoms/CompactionStatusLine.js';
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

describe('formatTokenCount', () => {
  it('formats sub-thousand counts as-is', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(800)).toBe('800');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('formats thousands with one decimal', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
    expect(formatTokenCount(8200)).toBe('8.2k');
    expect(formatTokenCount(12500)).toBe('12.5k');
  });

  it('rounds hundreds of thousands', () => {
    expect(formatTokenCount(128000)).toBe('128k');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-27T12:00:00Z').getTime();

  it('says just now for sub-minute ages', () => {
    expect(formatRelativeTime('2026-09-27T11:59:30Z', now)).toBe('just now');
  });

  it('formats minutes', () => {
    expect(formatRelativeTime('2026-09-27T11:30:00Z', now)).toBe('30m ago');
  });

  it('formats hours', () => {
    expect(formatRelativeTime('2026-09-27T10:00:00Z', now)).toBe('2h ago');
  });

  it('formats days', () => {
    expect(formatRelativeTime('2026-09-25T12:00:00Z', now)).toBe('2d ago');
  });

  it('returns empty for unparseable input', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });
});

describe('CompactionStatusLine token labels', () => {
  it('labels live tokens as in-context when no limit is known', () => {
    stubStatus({ liveTokens: 77200 });
    render(<CompactionStatusLine />);
    expect(screen.getByText('77.2k tokens in context')).toBeDefined();
  });

  it('shows used-over-limit when the context limit is known', () => {
    stubStatus({ liveTokens: 77200, contextLimit: 256000 });
    render(<CompactionStatusLine />);
    expect(screen.getByText('77.2k / 256k tokens')).toBeDefined();
  });

  it('names the limit when only the limit is known', () => {
    stubStatus({ contextLimit: 256000 });
    render(<CompactionStatusLine />);
    expect(screen.getByText('256k token limit')).toBeDefined();
  });

  it('falls back to used-over-limit when output reservation is unknown', () => {
    stubStatus({ liveTokens: 77200, contextLimit: 256000, maxOutputTokens: null });
    render(<CompactionStatusLine />);
    expect(screen.getByText('77.2k / 256k tokens')).toBeDefined();
  });
});

describe('CompactionStatusLine token budget', () => {
  it('shows input, output, and free breakdown when all values are known', () => {
    stubStatus({ liveTokens: 77200, contextLimit: 131072, maxOutputTokens: 32768 });
    render(<CompactionStatusLine />);
    // 131072 - 77200 - 32768 - 512 (safety margin) = 20592 free
    expect(screen.getByText('77.2k / 131k input · 32.8k output · 20.6k free')).toBeDefined();
  });

  it('clamps free budget at zero when over budget', () => {
    stubStatus({ liveTokens: 120000, contextLimit: 131072, maxOutputTokens: 32768 });
    render(<CompactionStatusLine />);
    expect(screen.getByText('120k / 131k input · 32.8k output · 0 free')).toBeDefined();
  });

  it('renders a stacked bar with input and output segments', () => {
    stubStatus({ liveTokens: 65536, contextLimit: 131072, maxOutputTokens: 32768 });
    const { container } = render(<CompactionStatusLine />);
    const bar = container.querySelector('[role="img"]');
    expect(bar).not.toBeNull();
    const segments = bar?.querySelectorAll(':scope > div > div');
    expect(segments?.length).toBe(2);
    const inputSegment = segments?.[0];
    const outputSegment = segments?.[1];
    expect(inputSegment).not.toBeUndefined();
    expect(outputSegment).not.toBeUndefined();
    // input segment: 65536/131072 = 50%
    expect(inputSegment?.getAttribute('style')).toContain('width: 50%');
    // output segment: 32768/131072 = 25%
    expect(outputSegment?.getAttribute('style')).toContain('width: 25%');
  });

  it('omits the bar when output reservation is unknown', () => {
    stubStatus({ liveTokens: 77200, contextLimit: 131072, maxOutputTokens: null });
    const { container } = render(<CompactionStatusLine />);
    expect(container.querySelector('[role="img"]')).toBeNull();
  });
});

describe('CompactionStatusLine compaction outcomes', () => {
  // 30 minutes ago from test time, so the relative label is stable.
  const createdAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const baseCompaction = { createdAt };

  it('shows only the age for an applied compaction, without a saved-tokens number', () => {
    stubStatus({ lastCompaction: { ...baseCompaction, outcome: 'applied' } });
    render(<CompactionStatusLine />);
    // The saved number mixed a provider count with a text estimate; the line
    // now shows just the age.
    expect(screen.getByText('Compacted 30m ago')).toBeDefined();
    expect(screen.queryByText(/saved/)).toBeNull();
  });

  it('shows shortened history for a truncated fallback, not a failure', () => {
    stubStatus({ lastCompaction: { ...baseCompaction, outcome: 'truncated_fallback' } });
    render(<CompactionStatusLine />);
    expect(screen.getByText('Could not summarize the chat, so the oldest messages were dropped 30m ago')).toBeDefined();
    expect(screen.queryByText(/failed/i)).toBeNull();
  });

  it('shows a failure for skipped outcomes', () => {
    stubStatus({ lastCompaction: { ...baseCompaction, outcome: 'skipped_invalid' } });
    render(<CompactionStatusLine />);
    expect(screen.getByText('Could not summarize the earlier messages 30m ago')).toBeDefined();
  });

  it('hides the compaction part for a cancelled turn, which is not a failure', () => {
    stubStatus({
      liveTokens: 1000,
      contextLimit: 8000,
      lastCompaction: { ...baseCompaction, outcome: 'skipped_blocked' },
    });
    render(<CompactionStatusLine />);
    expect(screen.getByText('1.0k / 8.0k tokens')).toBeDefined();
    expect(screen.queryByText(/compaction|failed/i)).toBeNull();
  });

  it('renders nothing for a cancelled turn when no other status is known', () => {
    stubStatus({ lastCompaction: { ...baseCompaction, outcome: 'skipped_blocked' } });
    const { container } = render(<CompactionStatusLine />);
    expect(container.firstChild).toBeNull();
  });
});
