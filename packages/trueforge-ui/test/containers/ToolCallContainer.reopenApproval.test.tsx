// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { HOLD_SAY, searchHoldCardText } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import { clearSentinelEventSubscribers, publishSentinelEvent } from '@/sentinel/sentinelEvents.js';
import { SentinelStateProvider } from '@/sentinel/SentinelStateProvider.js';
import {
  extractSentinelFromEvent,
  extractSentinelSessionContext,
  type SentinelApi,
  type SentinelSessionContext,
} from '@/sentinel/types.js';
import { RuntimeHarness } from './RuntimeHarness.js';

const { respondToApproval } = vi.hoisted(() => ({ respondToApproval: vi.fn() }));

vi.mock('@truefoundry/assistant-ui-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@truefoundry/assistant-ui-runtime')>();
  return {
    ...actual,
    useTrueFoundryRespondToToolApproval: () => respondToApproval,
    useTrueFoundryApprovals: () => ({
      pending: [{ approvalId: 'call-search', threadId: 'main' }],
      respond: respondToApproval,
    }),
  };
});

type HeldSearch = { name: string; say: string; can_chat_allow: boolean; can_always_allow: boolean };

// The flags the server sends for each kind of held search (see approvalGrant.ts in trueforge-core).
const HELD_SEARCHES: HeldSearch[] = [
  {
    name: 'a search held because searches are set to ask',
    say: HOLD_SAY.search_setting,
    can_chat_allow: false,
    can_always_allow: false,
  },
  {
    name: 'a search held after the chat read private text',
    say: HOLD_SAY.private_read,
    can_chat_allow: true,
    can_always_allow: false,
  },
  {
    name: 'a search held because it carries a key',
    say: HOLD_SAY.secret,
    can_chat_allow: false,
    can_always_allow: false,
  },
];

/** The `tool.approval_required` event as the server sends and stores it. */
function approvalEvent(search: HeldSearch): Record<string, unknown> {
  return {
    type: 'tool.approval_required',
    id: 'evt-approval',
    thread_id: 'main',
    tool_calls: [
      {
        id: 'call-search',
        source_event_id: 'evt-model',
        tier: 3,
        tier3_card: {
          plain_what: searchHoldCardText({ summary: 'oslo weather', say: search.say }),
          destination: 'search',
          outbound_text: 'query: "oslo weather"',
        },
        can_chat_allow: search.can_chat_allow,
        can_always_allow: search.can_always_allow,
      },
    ],
  };
}

/** The pending part the runtime builds: it declares a chat allow only where the server offers one. */
function pendingSearch(search: HeldSearch): ThreadMessageLike {
  return {
    role: 'assistant',
    status: { type: 'requires-action', reason: 'tool-calls' },
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call-search',
        toolName: 'web_search',
        args: { query: 'oslo weather' },
        interrupt: { type: 'human', payload: {} },
        approval: {
          id: 'call-search',
          approved: undefined,
          options: [
            { id: 'allow-once', kind: 'allow-once' },
            ...(search.can_chat_allow ? [{ id: 'allow-chat', kind: 'allow-always' }] : []),
            { id: 'deny', kind: 'reject-once', confirm: {} },
          ],
        },
      },
    ],
  };
}

function sentinelApi(readSavedCards: () => Promise<SentinelSessionContext>): SentinelApi {
  const settings = {
    offline_mode: false,
    tier2_auto_allow: [],
    search_without_asking: false,
    maps_without_asking: false,
    sandbox_without_asking: true,
  };
  return {
    listAuditEntries: vi.fn(async () => []),
    listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
    getUserSettings: vi.fn(async () => settings),
    updateUserSettings: vi.fn(async () => settings),
    listSentinelSessionContext: vi.fn(readSavedCards),
    listBriefItemCompletions: vi.fn(async () => []),
    markBriefItemDone: vi.fn(async () => undefined),
    unmarkBriefItemDone: vi.fn(async () => undefined),
  };
}

function renderChat(search: HeldSearch, api: SentinelApi) {
  return render(
    <RuntimeHarness messages={[pendingSearch(search)]} threadId="local-1" remoteId="session-1">
      <SentinelApiProvider api={api}>
        <SentinelStateProvider>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </SentinelStateProvider>
      </SentinelApiProvider>
    </RuntimeHarness>,
  );
}

/** What a person can press on the waiting card. */
function shownChoices(): (string | null)[] {
  const ticket = document.querySelector('[data-role="approval-ticket"]');
  if (ticket === null) throw new Error('No approval ticket on screen');
  return [...ticket.querySelectorAll('button')].map(button => button.textContent);
}

/** The live chat: the saved read finds nothing yet, and the card arrives on the stream. */
async function liveChoices(search: HeldSearch): Promise<(string | null)[]> {
  const view = renderChat(
    search,
    sentinelApi(async () => ({ approvals: [] })),
  );
  await waitFor(() => expect(document.querySelector('[data-role="approval-loading"]')).toBeNull());
  act(() => {
    for (const info of extractSentinelFromEvent(approvalEvent(search))) publishSentinelEvent(info);
  });
  const choices = shownChoices();
  view.unmount();
  clearSentinelEventSubscribers();
  return choices;
}

afterEach(() => {
  clearSentinelEventSubscribers();
  respondToApproval.mockClear();
});

describe('a reopened chat with one held search', () => {
  for (const search of HELD_SEARCHES) {
    describe(search.name, () => {
      it('shows no stand-in card while its saved card is read, then the same card and choices as the live chat', async () => {
        const live = await liveChoices(search);

        let finishRead: (context: SentinelSessionContext) => void = () => {};
        renderChat(
          search,
          sentinelApi(
            () =>
              new Promise(resolve => {
                finishRead = resolve;
              }),
          ),
        );
        expect(document.querySelector('[data-role="approval-loading"]')).not.toBeNull();
        expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /allow|approve|deny|not now/i })).not.toBeInTheDocument();

        await act(async () => {
          finishRead(extractSentinelSessionContext([approvalEvent(search)]));
          await Promise.resolve();
        });

        expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
        expect(shownChoices()).toEqual(live);
      });

      it('offers a chat-wide choice only when the server allows one, and never an always choice', async () => {
        const live = await liveChoices(search);
        expect(live.includes('Allow searches in this chat')).toBe(search.can_chat_allow);
        expect(live).not.toContain('Approve for this chat');
        expect(live).not.toContain('Always allow this tool');
        expect(live.slice(0, 3)).toEqual(['Allow it', 'Change it', 'Not now']);
      });
    });
  }

  it('falls back to the plain card when the saved cards cannot be read', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderChat(
      HELD_SEARCHES[0] ?? { name: '', say: '', can_chat_allow: false, can_always_allow: false },
      sentinelApi(async () => {
        throw new Error('offline');
      }),
    );
    await waitFor(() => expect(screen.getByRole('radiogroup')).toBeInTheDocument());
    expect(document.querySelector('[data-role="approval-loading"]')).toBeNull();
    consoleError.mockRestore();
  });
});
