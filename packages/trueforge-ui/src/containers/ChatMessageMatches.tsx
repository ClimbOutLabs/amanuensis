'use client';

import { useEffect, useState } from 'react';

import { auiButtonClass, sidebarQuietRadiusClassName } from '../atoms/lib/buttonClasses.js';
import { cn } from '../atoms/lib/cn.js';
import { formatRelativeShort } from '../atoms/lib/threadListMeta.js';
import {
  hasChatSearchPort,
  type OwnChatSearchHit,
} from '../plugins/trueforge-agent-server-adapter/catalogs/chatSearchCatalog.js';
import { useOptionalServer } from '../server/ServerContext.js';

/** How long typing must pause before the words inside chats are searched. */
const MESSAGE_SEARCH_DEBOUNCE_MS = 300;

export type OwnChatSearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'off' }
  | { status: 'done'; hits: OwnChatSearchHit[] }
  | { status: 'error'; message: string };

/**
 * Searches the words inside the person's own chats once typing pauses. A newer search cancels
 * the one still in flight, so a slow answer for old words never replaces the current one.
 */
export function useOwnChatSearch(query: string): OwnChatSearchState {
  const server = useOptionalServer();
  const catalog = server != null && hasChatSearchPort(server) ? server.chatSearch : null;
  const trimmed = query.trim();
  const [state, setState] = useState<OwnChatSearchState>({ status: 'idle' });

  useEffect(() => {
    if (catalog === null || trimmed.length === 0) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      catalog.searchOwnChats({ query: trimmed, signal: controller.signal }).then(
        result => {
          if (controller.signal.aborted) return;
          setState(result.searchEnabled ? { status: 'done', hits: result.hits } : { status: 'off' });
        },
        (caught: unknown) => {
          if (controller.signal.aborted) return;
          setState({
            status: 'error',
            message: caught instanceof Error ? caught.message : 'Searching your chats failed. Try again in a moment.',
          });
        },
      );
    }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [catalog, trimmed]);

  return state;
}

/**
 * The chats whose messages hold every searched word, under the chats whose titles matched.
 * A chat already listed by its title is not listed twice.
 */
export function ChatMessageMatches({
  query,
  titleMatchSessionIds,
  onOpen,
}: {
  query: string;
  titleMatchSessionIds: ReadonlySet<string>;
  onOpen: (sessionId: string) => void;
}) {
  const state = useOwnChatSearch(query);
  if (state.status === 'idle') return null;

  let body;
  if (state.status === 'loading') {
    body = <p className="px-2.5 py-1 text-xs text-text-secondary">Searching inside your chats…</p>;
  } else if (state.status === 'off') {
    body = (
      <p className="px-2.5 py-1 text-xs text-text-secondary">
        To search inside messages, turn on past-chat search in Settings, then Memory.
      </p>
    );
  } else if (state.status === 'error') {
    body = (
      <p role="alert" className="px-2.5 py-1 text-xs text-text-secondary">
        {state.message}
      </p>
    );
  } else {
    const hits = state.hits.filter(hit => !titleMatchSessionIds.has(hit.sessionId));
    body =
      hits.length === 0 ? (
        <p className="px-2.5 py-1 text-xs text-text-secondary">No other chats mention those words.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {hits.map(hit => (
            <li key={hit.sessionId} className="min-w-0">
              <button
                type="button"
                onClick={() => onOpen(hit.sessionId)}
                className={auiButtonClass({
                  variant: 'ghost',
                  className: cn(
                    '!justify-start h-auto w-full min-w-0 flex-col !items-start gap-0.5 border-0 px-2.5 py-1.5 text-left font-normal shadow-none',
                    sidebarQuietRadiusClassName,
                    'text-text-secondary hover:bg-ghost-button-hover hover:text-text-primary',
                  ),
                })}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{hit.title ?? 'New Chat'}</span>
                  <span className="shrink-0 text-xs text-text-muted">
                    {formatRelativeShort(new Date(hit.matchedAt))}
                  </span>
                </span>
                <span className="line-clamp-2 w-full text-xs whitespace-normal text-text-secondary">{hit.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      );
  }

  return (
    <section aria-label="Matches inside chats" className="mt-1 flex flex-col gap-0.5">
      <h3 className="m-0 px-2.5 pt-1 pb-0.5 text-xs font-normal text-text-secondary">In messages</h3>
      {body}
    </section>
  );
}
