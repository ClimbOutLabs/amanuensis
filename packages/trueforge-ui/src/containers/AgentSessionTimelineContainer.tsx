'use client';

import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { convertTurnsToThreadMessages } from '@truefoundry/assistant-ui-runtime';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { useServer } from '../server/ServerContext.js';
import type { AgentChatServer, SessionEventItem } from '../server/types.js';
import type { SlotOverrides } from '../theme/SlotsProvider.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { buildSessionMetrics, type SessionMetricBarDatum } from '../utils/buildSessionMetrics.js';
import { buildSessionTimelineSegments } from '../utils/buildSessionTimelineSegments.js';
import { createCachedListEventsBridge } from '../utils/cachedListEventsBridge.js';
import { getTurnInputSummary, parseTimestamp } from '../utils/sessionTimelineEvents.js';
import { buildSessionTurnViews, type SessionTurnView } from '../utils/sessionTurnViews.js';
import { buildTimeBreakdown } from '../utils/timeBreakdown.js';
import { AssistantMessageContainer } from './AssistantMessageContainer.js';
import { ReadOnlySessionTurnRuntime } from './ReadOnlySessionTurnRuntime.js';
import { UserMessageContainer } from './UserMessageContainer.js';

const READ_ONLY_SLOT_OVERRIDES: SlotOverrides = {
  UserMessageActionBar: () => <></>,
  MessageActionBar: () => <></>,
};

type TurnCreatedEvent = Extract<SessionEventItem['event'], { type: 'turn.created' }>;
type UserMessageInput = Extract<NonNullable<TurnCreatedEvent['input']>[number], { type: 'user.message' }>;

function turnIdFromMessage(message: ThreadMessageLike): string {
  const messageId = message.id ?? '';
  // The stable message id identifies the opening backend turn. Metadata can
  // point at the latest continuation turn for artifact ownership.
  return message.role === 'user' ? messageId.replace(/-user$/, '') : messageId.replace(/-assistant$/, '');
}

function buildProjectionEvents(items: SessionEventItem[], turns: SessionTurnView[]): SessionEventItem[] {
  // The chat projection folds continuation inputs into the previous response.
  // Add a display-only user boundary so Agent Details keeps each backend turn separate.
  const continuationSummaries = new Map(
    turns.flatMap(turn => {
      const input = turn.created.input ?? [];
      return input.some(item => item.type === 'user.message') ? [] : [[turn.turnId, getTurnInputSummary(turn)]];
    }),
  );

  return items.map(item => {
    if (item.event.type !== 'turn.created') return item;
    const summary = continuationSummaries.get(item.turnId);
    if (summary === undefined) return item;
    const displayInput: UserMessageInput = { type: 'user.message', content: summary };
    return {
      ...item,
      event: {
        ...item.event,
        input: [...(item.event.input ?? []), displayInput],
      },
    };
  });
}

function appendTerminalText(content: ThreadMessageLike['content'], text: string): ThreadMessageLike['content'] {
  const terminalPart: { type: 'text'; text: string } = { type: 'text', text };
  return typeof content === 'string' ? [{ type: 'text', text: content }, terminalPart] : [...content, terminalPart];
}

/** What a stopped turn says, in plain words: that it stopped, and why when the reason is known. */
function stoppedTurnText(reason: string): string {
  switch (reason) {
    case 'client-cancelled':
      return 'Stopped. You pressed Cancel.';
    case 'cancelled-for-next-turn':
      return 'Stopped. A new message started the next reply.';
    case 'server-execution-timeout':
      return 'Stopped. This reply ran past its time limit.';
    case 'abandoned':
      return 'Stopped. The app restarted while this reply was running.';
    default:
      return 'Stopped.';
  }
}

function applyTerminalState(messages: ThreadMessageLike[], turn: SessionTurnView): ThreadMessageLike[] {
  const state = turn.done?.state;
  if (state?.status !== 'error' && state?.status !== 'cancelled') return messages;

  // failures need an assistant row so the terminal state is visible.
  const assistantIndex = messages.findIndex(message => message.role === 'assistant');
  const assistant = assistantIndex < 0 ? undefined : messages[assistantIndex];
  const terminal: ThreadMessageLike =
    state.status === 'error'
      ? {
          ...(assistant ?? {
            id: `${turn.turnId}-assistant`,
            role: 'assistant',
            content: [],
            createdAt: new Date(turn.done?.createdAt ?? turn.created.createdAt),
            metadata: { custom: { turnId: turn.turnId } },
          }),
          status: { type: 'incomplete', reason: 'error', error: state.message },
        }
      : {
          ...(assistant ?? {
            id: `${turn.turnId}-assistant`,
            role: 'assistant',
            content: [],
            createdAt: new Date(turn.done?.createdAt ?? turn.created.createdAt),
            metadata: { custom: { turnId: turn.turnId } },
          }),
          content: appendTerminalText(assistant?.content ?? [], stoppedTurnText(state.reason)),
          status: { type: 'incomplete', reason: 'cancelled' },
        };

  if (assistantIndex < 0) return [...messages, terminal];
  return messages.map((message, index) => (index === assistantIndex ? terminal : message));
}

function messagesForTurn(messages: ThreadMessageLike[], turn: SessionTurnView): ThreadMessageLike[] {
  const matched = messages.filter(message => turnIdFromMessage(message) === turn.turnId);
  return applyTerminalState(matched, turn);
}

export type AgentSessionTimelineContainerProps = {
  sessionId: string;
  events: SessionEventItem[];
  /**
   * Timestamp markers for `aman.memory.recall` events.
   * The timeline uses these to attribute recall duration correctly:
   * the model bar starts when the lookup finishes, not when the turn started.
   * Provided via a separate path because `SessionEventItem` (external server
   * contract) has no shape for passthrough recall events.
   */
  recallTimestamps?: { turnId: string; timestamp: string }[];
  listMetrics?: {
    totalTurns: number;
    totalCostInUsd?: number;
    totalDurationMs: number;
  };
};

export function AgentSessionTimelineContainer({
  sessionId,
  events,
  recallTimestamps,
  listMetrics,
}: AgentSessionTimelineContainerProps) {
  const server = useServer();
  const AgentSessionTurnHeader = useSlot('AgentSessionTurnHeader');
  const AgentSessionEventTimeline = useSlot('AgentSessionEventTimeline');
  const ActivityFeed = useSlot('ActivityFeed');
  const AgentSessionMetricsStrip = useSlot('AgentSessionMetricsStrip');
  const MessageListSkeleton = useSlot('MessageListSkeleton');
  const ThreadViewportShell = useSlot('ThreadViewportShell');

  const [messages, setMessages] = useState<ThreadMessageLike[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const sectionRefs = useRef(new Map<number, HTMLElement>());

  const turnViews = useMemo(() => buildSessionTurnViews(events, recallTimestamps), [events, recallTimestamps]);
  const projectionEvents = useMemo(() => buildProjectionEvents(events, turnViews), [events, turnViews]);
  const timelineSegments = useMemo(() => buildSessionTimelineSegments(turnViews), [turnViews]);
  const originMs = useMemo(() => parseTimestamp(turnViews[0]?.created.createdAt) ?? 0, [turnViews]);
  const [eventView, setEventView] = useState<'activity' | 'timeline'>('activity');
  const eventViews: Array<'activity' | 'timeline'> = ['activity', 'timeline'];
  const sessionMetrics = useMemo(
    () => buildSessionMetrics({ turns: turnViews, segments: timelineSegments, listMetrics }),
    [listMetrics, timelineSegments, turnViews],
  );
  const turnTimeBreakdowns = useMemo(() => {
    const byTurnIndex = new Map<number, SessionMetricBarDatum[]>();
    for (const turn of turnViews) {
      const turnIndex = turn.turnNumber - 1;
      byTurnIndex.set(
        turnIndex,
        buildTimeBreakdown({
          segments: timelineSegments.filter(segment => segment.turnIndex === turnIndex),
          wallTimeMs: turn.durationMs ?? 0,
        }),
      );
    }
    return byTurnIndex;
  }, [timelineSegments, turnViews]);

  const handleSelectTurn = useCallback((index: number) => {
    sectionRefs.current.get(index)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setMessages(undefined);
    setLoadFailed(false);

    const bridge = createCachedListEventsBridge(projectionEvents, { allAtOnce: true });
    // Events already include every turn.created / turn.done, so skip listTurns.
    const chatServer: AgentChatServer = {
      ...server,
      listEvents: req => bridge.listEvents(req),
      listTurns: async () => ({ data: [] }),
    };

    void convertTurnsToThreadMessages(chatServer, sessionId)
      .then(result => {
        if (!cancelled) setMessages(result.messages);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [projectionEvents, server, sessionId]);

  if (loadFailed) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-text-secondary">
        Session messages could not be loaded.
      </div>
    );
  }

  if (messages === undefined) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
        <MessageListSkeleton />
      </div>
    );
  }

  if (messages.length === 0 && turnViews.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-text-secondary">
        This session has no messages yet.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border">
        <AgentSessionMetricsStrip metrics={sessionMetrics} />
        {timelineSegments.length > 0 && (
          <>
            <div
              role="tablist"
              aria-label="Session events view"
              className="flex items-center gap-1 border-b border-border px-3 py-1.5"
            >
              {eventViews.map(view => {
                const isSelected = eventView === view;
                return (
                  <button
                    key={view}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => setEventView(view)}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs font-medium',
                      isSelected
                        ? 'border-border text-text-primary'
                        : 'border-transparent text-text-secondary hover:text-text-primary',
                    )}
                  >
                    {view === 'activity' ? 'Activity' : 'Timeline'}
                  </button>
                );
              })}
            </div>
            <Suspense fallback={null}>
              {eventView === 'activity' ? (
                <ActivityFeed segments={timelineSegments} originMs={originMs} />
              ) : (
                <AgentSessionEventTimeline
                  turns={turnViews}
                  segments={timelineSegments}
                  onSelectTurn={handleSelectTurn}
                />
              )}
            </Suspense>
          </>
        )}
      </div>
      <ThreadViewportShell className="flex-1 pb-4">
        <div className="flex flex-col gap-4">
          {turnViews.map(turn => (
            <SessionTurnSection
              key={turn.turnId}
              turn={turn}
              timeBreakdown={turnTimeBreakdowns.get(turn.turnNumber - 1)}
              messages={messagesForTurn(messages, turn)}
              AgentSessionTurnHeader={AgentSessionTurnHeader}
              onMount={node => {
                if (node == null) sectionRefs.current.delete(turn.turnNumber - 1);
                else sectionRefs.current.set(turn.turnNumber - 1, node);
              }}
            />
          ))}
        </div>
      </ThreadViewportShell>
    </div>
  );
}

function SessionTurnSection({
  turn,
  timeBreakdown,
  messages,
  AgentSessionTurnHeader,
  onMount,
}: {
  turn: SessionTurnView;
  timeBreakdown?: SessionMetricBarDatum[];
  messages: ThreadMessageLike[];
  AgentSessionTurnHeader: ComponentType<{
    turnNumber: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    durationMs?: number;
    timeBreakdown?: SessionMetricBarDatum[];
    totalCostInUsd?: number;
  }>;
  onMount: (node: HTMLElement | null) => void;
}) {
  if (!turn.showHeader && messages.length === 0) {
    return null;
  }

  return (
    <section ref={onMount} id={`session-turn-${turn.turnNumber}`} className="flex flex-col gap-2">
      {turn.showHeader ? (
        <AgentSessionTurnHeader
          turnNumber={turn.turnNumber}
          totalTokens={turn.totalTokens}
          inputTokens={turn.inputTokens}
          outputTokens={turn.outputTokens}
          cachedTokens={turn.cachedTokens}
          durationMs={turn.durationMs}
          timeBreakdown={timeBreakdown}
          totalCostInUsd={turn.totalCostInUsd}
        />
      ) : null}
      {messages.length > 0 ? (
        <ReadOnlySessionTurnRuntime slotOverrides={READ_ONLY_SLOT_OVERRIDES} messages={messages}>
          <ThreadPrimitive.Root asChild>
            <div className="aui-root aui-thread-root flex w-full flex-col">
              <ThreadPrimitive.Messages>
                {({ message }) => (message.role === 'user' ? <UserMessageContainer /> : <AssistantMessageContainer />)}
              </ThreadPrimitive.Messages>
            </div>
          </ThreadPrimitive.Root>
        </ReadOnlySessionTurnRuntime>
      ) : null}
    </section>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    AgentSessionTimelineContainer: typeof AgentSessionTimelineContainer;
  }
}
