import { ChatMessageMatches } from '@/containers/ChatMessageMatches.js';
import type {
  ChatSearchCatalog,
  OwnChatSearchResult,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/chatSearchCatalog.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let server: { chatSearch: ChatSearchCatalog } | null = null;

vi.mock('@/server/ServerContext.js', () => ({
  useOptionalServer: () => server,
}));

function catalogAnswering(answer: (query: string) => Promise<OwnChatSearchResult>) {
  const searchOwnChats = vi.fn(({ query }: { query: string; signal?: AbortSignal }) => answer(query));
  server = {
    chatSearch: {
      getChatSearch: async () => ({ enabled: true }),
      setChatSearchEnabled: async enabled => ({ enabled }),
      searchOwnChats,
    },
  };
  return searchOwnChats;
}

const HIT_TRIP = {
  sessionId: 'chat-trip',
  title: 'Weekend plans',
  snippet: 'the ferry to the island leaves at nine',
  matchedAt: '2026-10-01T10:00:00.000Z',
};
const HIT_TITLED = {
  sessionId: 'chat-ferry',
  title: 'Ferry times',
  snippet: 'the ferry runs hourly',
  matchedAt: '2026-10-02T10:00:00.000Z',
};

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

describe('ChatMessageMatches', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    server = null;
  });

  it('lists chats whose messages match, with a snippet, and skips chats already matched by title', async () => {
    catalogAnswering(async () => ({ searchEnabled: true, hits: [HIT_TITLED, HIT_TRIP] }));
    const onOpen = vi.fn();
    render(<ChatMessageMatches query="ferry" titleMatchSessionIds={new Set(['chat-ferry'])} onOpen={onOpen} />);
    await settle();

    expect(screen.getByText('Weekend plans')).toBeInTheDocument();
    expect(screen.getByText('the ferry to the island leaves at nine')).toBeInTheDocument();
    expect(screen.queryByText('Ferry times')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Weekend plans/ }));
    expect(onOpen).toHaveBeenCalledWith('chat-trip');
  });

  it('says where to turn the search on while it is off', async () => {
    catalogAnswering(async () => ({ searchEnabled: false, hits: [] }));
    render(<ChatMessageMatches query="ferry" titleMatchSessionIds={new Set()} onOpen={vi.fn()} />);
    await settle();

    expect(
      screen.getByText('To search inside messages, turn on past-chat search in Settings, then Memory.'),
    ).toBeInTheDocument();
  });

  it('waits for typing to pause, and drops the answer to words that were replaced', async () => {
    const pending = new Map<string, (result: OwnChatSearchResult) => void>();
    const searchOwnChats = catalogAnswering(
      query =>
        new Promise(resolve => {
          pending.set(query, resolve);
        }),
    );
    const { rerender } = render(<ChatMessageMatches query="fer" titleMatchSessionIds={new Set()} onOpen={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    rerender(<ChatMessageMatches query="ferry" titleMatchSessionIds={new Set()} onOpen={vi.fn()} />);
    await settle();
    expect(searchOwnChats).toHaveBeenCalledTimes(1);
    expect(searchOwnChats).toHaveBeenCalledWith(expect.objectContaining({ query: 'ferry' }));

    rerender(<ChatMessageMatches query="island" titleMatchSessionIds={new Set()} onOpen={vi.fn()} />);
    await settle();
    await act(async () => {
      pending.get('ferry')?.({ searchEnabled: true, hits: [HIT_TITLED] });
      pending.get('island')?.({ searchEnabled: true, hits: [HIT_TRIP] });
      await Promise.resolve();
    });

    expect(screen.getByText('Weekend plans')).toBeInTheDocument();
    expect(screen.queryByText('Ferry times')).not.toBeInTheDocument();
  });

  it('shows the error in plain words when the search fails', async () => {
    catalogAnswering(async () => {
      throw new Error('Searching your chats failed. Try again in a moment.');
    });
    render(<ChatMessageMatches query="ferry" titleMatchSessionIds={new Set()} onOpen={vi.fn()} />);
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Searching your chats failed. Try again in a moment.');
  });
});
