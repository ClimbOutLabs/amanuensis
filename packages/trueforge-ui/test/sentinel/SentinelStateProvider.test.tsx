// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { publishSentinelEvent } from '@/sentinel/sentinelEvents.js';
import { SentinelStateProvider, useOptionalSentinelState } from '@/sentinel/SentinelStateProvider.js';
import { RuntimeHarness } from '../containers/RuntimeHarness.js';

// Chat parts identify a tool call by the runtime's invocation key: source event id, NUL, server id.
const INVOCATION_KEY = 'evt-0\u0000call-9';

function ApprovalProbe({ toolCallId }: { toolCallId: string }) {
  const sentinel = useOptionalSentinelState();
  const approval = sentinel?.approvalFor(toolCallId);
  const notice = sentinel?.noticeFor(toolCallId);
  return (
    <div>
      <span data-testid="approval">{approval === undefined ? 'none' : approval.card.plain_what}</span>
      <span data-testid="notice">{notice === undefined ? 'none' : notice.message}</span>
    </div>
  );
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
};

describe('SentinelStateProvider', () => {
  it('finds an approval filed under the server id when looked up by the invocation key', () => {
    renderProbe(INVOCATION_KEY);
    act(() => publishSentinelEvent({ kind: 'approval', info: { toolCallId: 'call-9', tier: 3, card: CARD } }));
    expect(screen.getByTestId('approval')).toHaveTextContent('Run code in the sandbox');
  });

  it('finds a Tier 2 notice filed under the server id when looked up by the invocation key', () => {
    renderProbe(INVOCATION_KEY);
    act(() =>
      publishSentinelEvent({
        kind: 'notice',
        notice: {
          toolCallId: 'call-9',
          notice_id: 'notice-1',
          message: 'Edited a tracked file',
          kind: null,
          undoable: false,
          stoppable: false,
          tracked_files: [],
        },
      }),
    );
    expect(screen.getByTestId('notice')).toHaveTextContent('Edited a tracked file');
  });

  it('still finds an approval looked up by the bare server id', () => {
    renderProbe('call-9');
    act(() => publishSentinelEvent({ kind: 'approval', info: { toolCallId: 'call-9', tier: 3, card: CARD } }));
    expect(screen.getByTestId('approval')).toHaveTextContent('Run code in the sandbox');
  });
});
