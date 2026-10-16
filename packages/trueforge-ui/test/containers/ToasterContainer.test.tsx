import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toast } from '@/atoms/Toast.js';
import { ToasterProvider, useToaster, useToasterOptional } from '@/containers/ToasterContainer.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';

function Trigger({ errors }: { errors: unknown[] }) {
  const { showError } = useToaster();
  return (
    <button
      type="button"
      onClick={() => {
        for (const error of errors) showError(error);
      }}
    >
      boom
    </button>
  );
}

describe('ToasterProvider', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires a provider for useToaster while the optional hook returns null', () => {
    expect(() => renderHook(() => useToaster())).toThrow('useToaster must be used within ToasterProvider');

    const { result } = renderHook(() => useToasterOptional());
    expect(result.current).toBeNull();
  });

  it('stacks multiple error toasts', async () => {
    render(
      <SlotsProvider>
        <ToasterProvider>
          <Trigger errors={[new Error('first'), new Error('second')]} />
        </ToasterProvider>
      </SlotsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'boom' }));

    expect(await screen.findByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('dismisses one toast without removing the other', async () => {
    render(
      <SlotsProvider>
        <ToasterProvider>
          <Trigger errors={[new Error('keep-me'), new Error('drop-me')]} />
        </ToasterProvider>
      </SlotsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'boom' }));
    expect(await screen.findByText('drop-me')).toBeTruthy();

    const dropToast = screen.getByText('drop-me').closest("[role='alert']");
    expect(dropToast).toBeTruthy();
    const closeButton = dropToast?.querySelector('[aria-label="Close"]');
    if (closeButton === null || closeButton === undefined) {
      throw new Error('Expected close button');
    }
    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(screen.queryByText('drop-me')).toBeNull();
    });
    expect(screen.getByText('keep-me')).toBeTruthy();
  });

  it('formats HTTP-like status and response body details', async () => {
    const httpError = Object.assign(new Error('request failed'), {
      statusCode: 422,
      body: { detail: 'invalid agent' },
    });

    render(
      <SlotsProvider>
        <ToasterProvider>
          <Trigger errors={[httpError]} />
        </ToasterProvider>
      </SlotsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'boom' }));

    expect(await screen.findByText('Request failed (422)')).toBeInTheDocument();
    expect(screen.getByText(/"detail":"invalid agent"/)).toBeInTheDocument();
  });

  it('extracts nested error.message from HTTP body', async () => {
    const httpError = Object.assign(new Error('Status code: 409'), {
      statusCode: 409,
      body: { error: { message: 'Name taken' } },
    });

    render(
      <SlotsProvider>
        <ToasterProvider>
          <Trigger errors={[httpError]} />
        </ToasterProvider>
      </SlotsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'boom' }));

    expect(await screen.findByText('Request failed (409)')).toBeInTheDocument();
    expect(screen.getByText('Name taken')).toBeInTheDocument();
  });

  it('shows the expired-request copy, without ids, for a stale approval', async () => {
    const staleError = Object.assign(new Error('Status code: 409'), {
      statusCode: 409,
      body: {
        error: {
          message:
            'Approval continuation is stale: expected session tip 01m4eympt6a8mxhb8xwzk3nspf.w5oyun, current tip is 01m4npwt2kbapkxb4emesqc12y.3watv6',
          type: 'conflict',
          code: 'stale_approval_continuation',
        },
      },
    });

    render(
      <SlotsProvider>
        <ToasterProvider>
          <Trigger errors={[staleError]} />
        </ToasterProvider>
      </SlotsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'boom' }));

    expect(await screen.findByText('This request expired')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The chat moved on before this was answered. Nothing was approved or run. Ask again if you still want it.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Request failed/)).toBeNull();
    expect(screen.queryByText(/01m4/)).toBeNull();
  });

  it('tells the user the daily demo budget is used up, not that the request failed', async () => {
    const capError = Object.assign(new Error('Status code: 429'), {
      statusCode: 429,
      body: {
        error: {
          message: "Today's Token Factory token budget is used up. It resets at midnight UTC.",
          type: 'rate_limit',
          code: 'token_factory_daily_cap_reached',
        },
      },
    });

    render(
      <SlotsProvider>
        <ToasterProvider>
          <Trigger errors={[capError]} />
        </ToasterProvider>
      </SlotsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'boom' }));

    expect(await screen.findByText('Demo budget used up')).toBeInTheDocument();
    expect(screen.getByText("Today's demo budget is used up. It resets at midnight UTC.")).toBeInTheDocument();
    expect(screen.queryByText(/Request failed/)).toBeNull();
  });

  it('keeps showing the server message for other rate limits', async () => {
    const rateLimited = Object.assign(new Error('Status code: 429'), {
      statusCode: 429,
      body: { error: { message: 'Slow down', type: 'rate_limit', code: 'something_else' } },
    });

    render(
      <SlotsProvider>
        <ToasterProvider>
          <Trigger errors={[rateLimited]} />
        </ToasterProvider>
      </SlotsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'boom' }));

    expect(await screen.findByText('Request failed (429)')).toBeInTheDocument();
    expect(screen.getByText('Slow down')).toBeInTheDocument();
  });

  it('keeps only the five most recent errors visible', async () => {
    const errors = Array.from({ length: 6 }, (_, index) => new Error(`error-${index + 1}`));

    render(
      <SlotsProvider>
        <ToasterProvider>
          <Trigger errors={errors} />
        </ToasterProvider>
      </SlotsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'boom' }));

    expect(await screen.findAllByRole('alert')).toHaveLength(5);
    expect(screen.queryByText('error-1')).not.toBeInTheDocument();
    expect(screen.getByText('error-6')).toBeInTheDocument();
  });
});

describe('Toast copy', () => {
  it('copies title and description', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <SlotsProvider>
        <Toast title="Request failed" description="body detail" open onOpenChange={() => {}} />
      </SlotsProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });

    expect(writeText).toHaveBeenCalledWith('Request failed\nbody detail');
  });
});
