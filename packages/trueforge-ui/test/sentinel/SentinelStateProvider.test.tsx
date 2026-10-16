// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import { publishSentinelEvent } from '@/sentinel/sentinelEvents.js';
import { SentinelStateProvider, useOptionalSentinelState } from '@/sentinel/SentinelStateProvider.js';
import type { SentinelApi, SentinelSessionContext } from '@/sentinel/types.js';
import { RuntimeHarness } from '../containers/RuntimeHarness.js';

// Chat parts identify a tool call by the runtime's invocation key: source event id, NUL, server id.
const INVOCATION_KEY = 'evt-0\u0000call-9';

function ApprovalProbe({ toolCallId }: { toolCallId: string }) {
  const sentinel = useOptionalSentinelState();
  const approval = sentinel?.approvalFor(toolCallId);
  return <span data-testid="approval">{approval === undefined ? 'none' : approval.card.plain_what}</span>;
}

function renderProbe(toolCallId: string) {
  return render(
    <RuntimeHarness messages={[]}>
      <SentinelStateProvider>
        <ApprovalProbe toolCallId={toolCallId} />
      </SentinelStateProvider>
    </RuntimeHarness>,
  );
}

const CARD = {
  plain_what: 'Run code in the sandbox',
  plain_why: null,
  cannot_be_undone: null,
  why_asked_again: null,
  destination: null,
  recipient: null,
  amount: null,
  parsed_command: null,
  outbound_text: null,
  destination_host: null,
  outbound_truncated: false,
};

describe('SentinelStateProvider', () => {
  it('finds an approval filed under the server id when looked up by the invocation key', () => {
    renderProbe(INVOCATION_KEY);
    act(() => publishSentinelEvent({ toolCallId: 'call-9', tier: 3, card: CARD, eventId: null, threadId: null }));
    expect(screen.getByTestId('approval')).toHaveTextContent('Run code in the sandbox');
  });

  it('finds a Tier 2 approval filed under the server id when looked up by the invocation key', () => {
    renderProbe(INVOCATION_KEY);
    act(() =>
      publishSentinelEvent({
        toolCallId: 'call-9',
        tier: 2,
        card: { ...CARD, plain_what: 'Edit notes.md' },
        eventId: null,
        threadId: null,
      }),
    );
    expect(screen.getByTestId('approval')).toHaveTextContent('Edit notes.md');
  });

  it('still finds an approval looked up by the bare server id', () => {
    renderProbe('call-9');
    act(() => publishSentinelEvent({ toolCallId: 'call-9', tier: 3, card: CARD, eventId: null, threadId: null }));
    expect(screen.getByTestId('approval')).toHaveTextContent('Run code in the sandbox');
  });

  it('keeps a live card when the saved-history read finishes later without it', async () => {
    let finishHistory: (context: SentinelSessionContext) => void = () => {};
    const api: SentinelApi = {
      listAuditEntries: vi.fn(async () => []),
      getUserSettings: vi.fn(async () => ({ offline_mode: false, tier2_auto_allow: [], search_without_asking: true })),
      updateUserSettings: vi.fn(async () => ({
        offline_mode: false,
        tier2_auto_allow: [],
        search_without_asking: true,
      })),
      listSentinelSessionContext: vi.fn(
        () =>
          new Promise<SentinelSessionContext>(resolve => {
            finishHistory = resolve;
          }),
      ),
    };
    render(
      <RuntimeHarness messages={[]} threadId="local-1" remoteId="session-1">
        <SentinelApiProvider api={api}>
          <SentinelStateProvider>
            <ApprovalProbe toolCallId="call-9" />
          </SentinelStateProvider>
        </SentinelApiProvider>
      </RuntimeHarness>,
    );
    await waitFor(() => {
      expect(api.listSentinelSessionContext).toHaveBeenCalledWith('session-1');
    });

    act(() => publishSentinelEvent({ toolCallId: 'call-9', tier: 3, card: CARD, eventId: null, threadId: null }));
    expect(screen.getByTestId('approval')).toHaveTextContent('Run code in the sandbox');
    await act(async () => {
      finishHistory({ approvals: [] });
      await Promise.resolve();
    });

    expect(screen.getByTestId('approval')).toHaveTextContent('Run code in the sandbox');
  });

  it('fills in a card from saved history that the live stream never delivered', async () => {
    const api: SentinelApi = {
      listAuditEntries: vi.fn(async () => []),
      getUserSettings: vi.fn(async () => ({ offline_mode: false, tier2_auto_allow: [], search_without_asking: true })),
      updateUserSettings: vi.fn(async () => ({
        offline_mode: false,
        tier2_auto_allow: [],
        search_without_asking: true,
      })),
      listSentinelSessionContext: vi.fn(async () => ({
        approvals: [{ toolCallId: 'call-9', tier: 3 as const, card: CARD, eventId: null, threadId: null }],
      })),
    };
    render(
      <RuntimeHarness messages={[]} threadId="local-1" remoteId="session-1">
        <SentinelApiProvider api={api}>
          <SentinelStateProvider>
            <ApprovalProbe toolCallId="call-9" />
          </SentinelStateProvider>
        </SentinelApiProvider>
      </RuntimeHarness>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('approval')).toHaveTextContent('Run code in the sandbox');
    });
  });
});
