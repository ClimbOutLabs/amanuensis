import { useEffect, useMemo, useState, type FC, type ReactNode } from 'react';

import { useOptionalSentinelApi } from '../sentinel/SentinelApiContext.js';
import type { SentinelApprovalInfo } from '../sentinel/types.js';
import { useOptionalMemoryRecall, type MemoryTurnContext } from './MemoryRecallContext.js';

/**
 * The right rail's desk: what the assistant is holding for the person, read from stored state.
 * The Home half mirrors `GET /api/v1/today` exactly (the server owns the shape); the chat half
 * reads the per-turn memory-recall record, the chat's attachments and its held actions. Nothing
 * in this file asks the assistant anything, and no control here writes to memory: pulling a
 * fact out only records a per-chat exclusion on the server.
 */

export type RailTodayEvent = {
  /** Which day the event falls on; tomorrow's first event is only listed once today is over. */
  day: 'today' | 'tomorrow';
  start_at: string;
  end_at: string | null;
  title: string;
  location: string | null;
  all_day: boolean;
  source: 'google' | 'caldav';
  calendar_account_id: string;
};

export type RailTodayDueReminder = {
  reminder_id: string;
  title: string;
  due_at: string;
  session_id: string | null;
};

export type RailTodayNeedsOkItem = {
  held_action_id: string;
  title: string;
  origin: string;
  session_id: string;
};

export type RailToday = {
  calendar: RailTodayEvent[] | null;
  free_after: string | null;
  due: RailTodayDueReminder[];
  needs_ok: RailTodayNeedsOkItem[];
  /** True when more actions are waiting than the Needs your OK list shows. */
  needs_ok_more: boolean;
  carrying: number;
  as_of: string;
};

/** One thing attached to a chat, from the chat's own records. */
export type RailAttachment = {
  id: string;
  label: string;
  detail: string | null;
};

/** The host's reads and the one small write behind the desk. Implemented in the frontend. */
export type RailDeskApi = {
  /** The Home view's day, from `GET /api/v1/today`. */
  getToday: (input: { timeZone: string | undefined }) => Promise<RailToday>;
  /** Pulls one fact out of this chat's recall for the rest of the chat. Never edits memory. */
  excludeRecallFact: (input: { sessionId: string; factText: string }) => Promise<void>;
  /** The files this chat has taken in, from its stored records. */
  listAttachments: (input: { sessionId: string }) => Promise<RailAttachment[]>;
};

/** How often the Home desk re-reads the day while it is on screen. */
const TODAY_POLL_MS = 120_000;
/** How often the chat desk re-reads the chat's records while it is on screen. */
const CHAT_POLL_MS = 60_000;
/** A read older than this says when it was read, so a stale desk never looks fresh. */
const STALE_AFTER_MS = 10 * 60 * 1000;
/** Most memory facts the chat desk lists. */
const FACT_CAP = 6;

export type RailRecallFactSource = 'person' | 'read' | 'finding' | 'assistant';

export type RailRecallFact = {
  /** The fact in the plain words the recall record itself uses; also the exclusion key. */
  text: string;
  /** The day the fact is dated with, as the record gives it (`undated` when it gives none). */
  date: string;
  source: RailRecallFactSource;
  /** True for facts that came from something read or found: shown with a Check tag, never as settled. */
  needsCheck: boolean;
  /** Where the fact came from, in plain words, for the row's second line. */
  origin: string;
};

const READ_LABEL = 'from something read for the person';
const FINDING_LABEL = 'found earlier by the assistant';
const REPLY_LABEL = "the assistant's earlier reply";
const ITEM_LINE = /^\[([^\]]+)\] (.*)$/;
/** How long ago the day was, which newer records carry between the day and the label. */
const AGE_PART = /^(today|yesterday|\d+ (day|week|month|year)s? ago)$/;

/** One item line of a recall block, or undefined for the block's other lines (People, curated, stats). */
function parseBlockLine(line: string): RailRecallFact | undefined {
  const match = ITEM_LINE.exec(line.trim());
  if (match === null) {
    return undefined;
  }
  const head = match[1] ?? '';
  const text = (match[2] ?? '').trim();
  if (text === '' || head.startsWith('mental model') || head === 'profile' || head === 'reflection') {
    return undefined;
  }
  const [date = '', ...rest] = head.split(', ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) && date !== 'undated') {
    return undefined;
  }
  // The row shows the day itself, so the age is read past; older records have no age and no label for the person.
  const label = (AGE_PART.test(rest[0] ?? '') ? rest.slice(1) : rest).join(', ');
  const when = date === 'undated' ? '' : ` on ${date}`;
  if (label === READ_LABEL) {
    return { text, date, source: 'read', needsCheck: true, origin: `From something read for you${when}` };
  }
  if (label === FINDING_LABEL) {
    return { text, date, source: 'finding', needsCheck: true, origin: `Found earlier by the assistant${when}` };
  }
  if (label === REPLY_LABEL) {
    return { text, date, source: 'assistant', needsCheck: false, origin: `From an earlier reply${when}` };
  }
  return { text, date, source: 'person', needsCheck: false, origin: `You said this${when}` };
}

/**
 * The facts a chat's turns recalled, newest turn first, each fact once, capped. Reads only the
 * per-turn recall record: a fact the record does not carry is never invented here.
 */
export function parseRecallFacts(turns: readonly MemoryTurnContext[]): RailRecallFact[] {
  const seen = new Set<string>();
  const facts: RailRecallFact[] = [];
  for (const turn of [...turns].reverse()) {
    const block = turn.recall?.injectedBlock;
    if (block === undefined || block === null) {
      continue;
    }
    for (const line of block.split('\n')) {
      const fact = parseBlockLine(line);
      if (fact === undefined || seen.has(fact.text)) {
        continue;
      }
      seen.add(fact.text);
      facts.push(fact);
      if (facts.length >= FACT_CAP) {
        return facts;
      }
    }
  }
  return facts;
}

/** The person's own time zone, which sets both the server's day and the times shown. */
function personTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function formatClock(iso: string, timeZone: string | undefined): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(instant);
}

function formatDayTime(iso: string, timeZone: string | undefined): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    return iso;
  }
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(instant);
  return `${day} ${formatClock(iso, timeZone)}`;
}

/**
 * The Home day for the rail, re-read every two minutes and whenever `refreshSignal` changes
 * (the rail's own sign that a held action or reminder arrived). A failed read keeps the last
 * good day rather than blanking the desk.
 */
export function useRailToday(api: RailDeskApi | undefined, refreshSignal: string): RailToday | null {
  const [today, setToday] = useState<RailToday | null>(null);
  const timeZone = useMemo(personTimeZone, []);
  useEffect(() => {
    if (api === undefined) {
      return;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const data = await api.getToday({ timeZone });
        if (!cancelled) {
          setToday(data);
        }
      } catch {
        // The last good read stays; the next poll tries again.
      }
    };
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, TODAY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [api, timeZone, refreshSignal]);
  return today;
}

const DeskSection: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <section className="aman-runtime-rail__section aman-runtime-rail__desk" aria-label={title}>
    <h3 className="aman-runtime-rail__section-label">{title}</h3>
    {children}
  </section>
);

/** The Home desk: Today, Due, and Needs your OK, each shown only when its source exists. */
export const RailHomeDesk: FC<{
  today: RailToday;
  onOpenChat?: ((sessionId: string) => void) | undefined;
}> = ({ today, onOpenChat }) => {
  const timeZone = useMemo(personTimeZone, []);
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const stale = Date.now() - Date.parse(today.as_of) > STALE_AFTER_MS;
  const freeNow = today.free_after !== null && Date.parse(today.free_after) <= Date.parse(today.as_of) + 60_000;
  return (
    <>
      {today.calendar !== null && (
        <DeskSection title="Today">
          {today.calendar.length === 0 ? (
            <p className="aman-runtime-rail__desk-note">Nothing on the calendar.</p>
          ) : (
            <ul className="aman-runtime-rail__desk-list">
              {today.calendar.map(event => {
                const key = `${event.calendar_account_id}:${event.start_at}:${event.title}`;
                const open = openEvent === key;
                const clock = event.all_day
                  ? 'All day'
                  : event.end_at === null
                    ? formatClock(event.start_at, timeZone)
                    : `${formatClock(event.start_at, timeZone)} to ${formatClock(event.end_at, timeZone)}`;
                // Tomorrow's event names its day, so it can never read as one of today's.
                const when = event.day === 'tomorrow' ? `Tomorrow, ${clock}` : clock;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className="aman-runtime-rail__desk-row"
                      aria-expanded={open}
                      onClick={() => {
                        setOpenEvent(open ? null : key);
                      }}
                    >
                      <span className="aman-runtime-rail__desk-row-title">{event.title}</span>
                      <span className="aman-runtime-rail__desk-row-detail">{when}</span>
                    </button>
                    {open && (
                      <p className="aman-runtime-rail__desk-row-more">
                        {event.location !== null ? `${event.location}. ` : ''}
                        From {event.calendar_account_id}.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {today.free_after !== null && (
            <p className="aman-runtime-rail__desk-note">
              {freeNow ? 'Free for the rest of the day.' : `Free after ${formatClock(today.free_after, timeZone)}.`}
            </p>
          )}
          {stale && <p className="aman-runtime-rail__desk-stale">Read at {formatClock(today.as_of, timeZone)}.</p>}
        </DeskSection>
      )}

      {today.due.length > 0 && (
        <DeskSection title="Due">
          <ul className="aman-runtime-rail__desk-list">
            {today.due.map(reminder => {
              const reminderSessionId = reminder.session_id;
              return (
                <li key={reminder.reminder_id}>
                  {reminderSessionId !== null && onOpenChat !== undefined ? (
                    <button
                      type="button"
                      className="aman-runtime-rail__desk-row"
                      onClick={() => {
                        onOpenChat(reminderSessionId);
                      }}
                    >
                      <span className="aman-runtime-rail__desk-row-title">{reminder.title}</span>
                      <span className="aman-runtime-rail__desk-row-detail">
                        Due {formatDayTime(reminder.due_at, timeZone)}
                      </span>
                    </button>
                  ) : (
                    <div className="aman-runtime-rail__desk-row aman-runtime-rail__desk-row--static">
                      <span className="aman-runtime-rail__desk-row-title">{reminder.title}</span>
                      <span className="aman-runtime-rail__desk-row-detail">
                        Due {formatDayTime(reminder.due_at, timeZone)}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </DeskSection>
      )}

      {today.needs_ok.length > 0 && (
        <DeskSection title="Needs your OK">
          <ul className="aman-runtime-rail__desk-list">
            {today.needs_ok.map(item => (
              <li key={item.held_action_id}>
                {onOpenChat !== undefined ? (
                  <button
                    type="button"
                    className="aman-runtime-rail__desk-row"
                    onClick={() => {
                      onOpenChat(item.session_id);
                    }}
                  >
                    <span className="aman-runtime-rail__desk-row-title">{item.title}</span>
                    <span className="aman-runtime-rail__desk-row-detail">From {item.origin}</span>
                  </button>
                ) : (
                  <div className="aman-runtime-rail__desk-row aman-runtime-rail__desk-row--static">
                    <span className="aman-runtime-rail__desk-row-title">{item.title}</span>
                    <span className="aman-runtime-rail__desk-row-detail">From {item.origin}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {today.needs_ok_more && <p className="aman-runtime-rail__desk-note">More are waiting in your chats.</p>}
        </DeskSection>
      )}
    </>
  );
};

/** Held actions of one chat that are still waiting: held, unanswered, and not past their day to answer. */
function waitingHeldActions(context: {
  approvals: SentinelApprovalInfo[];
  answers?: Record<string, string> | undefined;
}): SentinelApprovalInfo[] {
  const now = Date.now();
  return context.approvals.filter(approval => {
    if (approval.held === undefined || context.answers?.[approval.toolCallId] !== undefined) {
      return false;
    }
    return approval.held.expiresAt === null || Date.parse(approval.held.expiresAt) > now;
  });
}

/** The chat desk: what the assistant is using in this chat, from the chat's own records. */
export const RailChatDesk: FC<{
  sessionId: string;
  deskApi: RailDeskApi | undefined;
  onOpenMemorySettings?: (() => void) | undefined;
}> = ({ sessionId, deskApi, onOpenMemorySettings }) => {
  const memoryApi = useOptionalMemoryRecall();
  const sentinelApi = useOptionalSentinelApi();
  const [turns, setTurns] = useState<MemoryTurnContext[]>([]);
  const [attachments, setAttachments] = useState<RailAttachment[]>([]);
  const [held, setHeld] = useState<SentinelApprovalInfo[]>([]);
  const [pulled, setPulled] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setTurns([]);
    setAttachments([]);
    setHeld([]);
    setPulled(new Set());
    let cancelled = false;
    const load = async (): Promise<void> => {
      if (memoryApi !== null) {
        try {
          const next = await memoryApi.listMemoryTurnContext(sessionId);
          if (!cancelled) {
            setTurns(next);
          }
        } catch {
          // The last good read stays.
        }
      }
      if (deskApi !== undefined) {
        try {
          const next = await deskApi.listAttachments({ sessionId });
          if (!cancelled) {
            setAttachments(next);
          }
        } catch {
          // The last good read stays.
        }
      }
      if (sentinelApi !== null) {
        try {
          const context = await sentinelApi.listSentinelSessionContext(sessionId);
          if (!cancelled) {
            setHeld(waitingHeldActions(context));
          }
        } catch {
          // The last good read stays.
        }
      }
    };
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, CHAT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionId, memoryApi, deskApi, sentinelApi]);

  const facts = useMemo(() => parseRecallFacts(turns).filter(fact => !pulled.has(fact.text)), [turns, pulled]);

  const pullOut = (fact: RailRecallFact): void => {
    setPulled(previous => new Set(previous).add(fact.text));
    if (deskApi === undefined) {
      return;
    }
    void deskApi.excludeRecallFact({ sessionId, factText: fact.text }).catch(() => {
      // The pull did not reach the server, so the fact goes back on the desk.
      setPulled(previous => {
        const next = new Set(previous);
        next.delete(fact.text);
        return next;
      });
    });
  };

  return (
    <>
      {facts.length > 0 && (
        <DeskSection title="Using">
          <p className="aman-runtime-rail__desk-note">
            From memory, for this chat. The × takes a fact out of this chat only; it stays in your memory.
          </p>
          <ul className="aman-runtime-rail__desk-list">
            {facts.map(fact => (
              <li key={fact.text} className="aman-runtime-rail__desk-fact">
                <div className="aman-runtime-rail__desk-fact-head">
                  <span className="aman-runtime-rail__desk-row-title">{fact.text}</span>
                  <button
                    type="button"
                    className="aman-runtime-rail__desk-pull"
                    aria-label={`Take this out of this chat: ${fact.text}`}
                    title="Not in this chat"
                    onClick={() => {
                      pullOut(fact);
                    }}
                  >
                    ×
                  </button>
                </div>
                <span className="aman-runtime-rail__desk-row-detail">
                  {fact.origin}
                  {fact.needsCheck && <span className="aman-runtime-rail__desk-check">Check</span>}
                </span>
                {onOpenMemorySettings !== undefined && (
                  <button type="button" className="aman-runtime-rail__desk-forget" onClick={onOpenMemorySettings}>
                    Forget everywhere
                  </button>
                )}
              </li>
            ))}
          </ul>
        </DeskSection>
      )}

      {attachments.length > 0 && (
        <DeskSection title="In this chat">
          <ul className="aman-runtime-rail__desk-list">
            {attachments.map(attachment => (
              <li key={attachment.id}>
                <div className="aman-runtime-rail__desk-row aman-runtime-rail__desk-row--static">
                  <span className="aman-runtime-rail__desk-row-title">{attachment.label}</span>
                  {attachment.detail !== null && (
                    <span className="aman-runtime-rail__desk-row-detail">{attachment.detail}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </DeskSection>
      )}

      {held.length > 0 && (
        <DeskSection title="Needs your OK">
          <ul className="aman-runtime-rail__desk-list">
            {held.map(approval => (
              <li key={approval.toolCallId}>
                <div className="aman-runtime-rail__desk-row aman-runtime-rail__desk-row--static">
                  <span className="aman-runtime-rail__desk-row-title">{approval.card.plain_what}</span>
                  <span className="aman-runtime-rail__desk-row-detail">Waiting in this chat</span>
                </div>
              </li>
            ))}
          </ul>
        </DeskSection>
      )}
    </>
  );
};
