import { useCallback, useState, type FC, type ReactNode } from 'react';

import { WORKING_ON_IT_LABEL } from '../atoms/ComposerShell.js';
import type { AmanAvatarActivity } from '../hooks/useAvatarActivity.js';
import { useRuntimeConnectivity } from '../hooks/useRuntimeConnectivity.js';
import { Icon } from '../icons/Icon.js';
import { OfflineIndicator } from '../sentinel/OfflineIndicator.js';
import { useOptionalSentinelApiState } from '../sentinel/SentinelApiContext.js';
import { ACTIVITY_STATE_DOT_CLASSES } from '../sentinel/activityVerbs.js';
import { WAITING_FOR_YOU_LABEL, type SentinelUserSettings } from '../sentinel/types.js';
import { assistantDisplayName } from '../utils/assistantName.js';
import { AmanAvatarMotion, avatarAltText, type AmanAvatarMotionSources } from './AmanAvatarMotion.js';
import {
  PersonalizationProvider,
  useOptionalPersonalization,
  type PersonalizationApi,
} from './PersonalizationContext.js';
import { RailChatDesk, RailHomeDesk, useRailToday, type RailDeskApi } from './RailDesk.js';

export type AmanRuntimeRailStatus = 'ready' | 'connecting' | 'offline' | 'degraded';

export type AmanRuntimeRailProps = {
  avatarSrc?: string;
  /**
   * Motion clips for the living avatar, keyed by what the agent is doing. When provided (and
   * the user has not asked for reduced motion) the avatar plays the clip for `activity`;
   * otherwise the static `avatarSrc` image is used exactly as before.
   */
  avatarMotion?: AmanAvatarMotionSources;
  /**
   * What the assistant is doing right now: idle, thinking (any non-streaming work: reasoning,
   * tool calls, memory ops), writing (visible response tokens streaming into chat), waiting
   * (the turn is parked on the person), or error (a surfaced failure, auto-cleared). Defaults
   * to 'idle'. Connectivity is deliberately not part of this: the rail's status dot owns
   * reachability.
   */
  activity?: AmanAvatarActivity;
  modelName?: string;
  /** The persona or agent answering right now, when the host tracks one. */
  personaName?: string | undefined;
  /** Host-provided status wins; when omitted the rail probes `/healthz` itself. */
  status?: AmanRuntimeRailStatus;
  /** Package version of the server answering. Without it the release line is left out. */
  version?: string | undefined;
  /** Source reference the server's build was stamped with; absent on an unstamped build. */
  buildRef?: string | undefined;
  /** @deprecated Wrap the rail and chat shell in `PersonalizationProvider` instead. */
  personalizationApi?: PersonalizationApi;
  /**
   * The open chat is private. The rail then says nothing about what the assistant is doing in it;
   * a connection problem still shows, since it says what to do next.
   */
  privateChat?: boolean;
  /**
   * Ids of the approvals waiting on the person in this chat. Any id puts the panda in its waiting
   * state, and puts a live Waiting for you line above the history in the Activity row.
   */
  pendingApprovalIds?: readonly string[];
  /**
   * The receipt node, provided by the host (e.g. `SentinelAuditFeed` for the active session).
   * It is the body of the Activity row.
   */
  auditFeed?: ReactNode;
  /**
   * The host's way to open Settings at the Audit section. The rail renders outside the shell
   * tree, so it cannot open Settings itself: the Audits link shows only when the host hands
   * this over, and clicking it calls it.
   */
  onOpenAudits?: () => void;
  /**
   * The address of the live browser page while the assistant has a web page open in this chat, so
   * the person can watch it and take a step themselves. Left out when there is no page open.
   */
  liveBrowserHref?: string | undefined;
  /**
   * The chat the person is looking at, or undefined on Home. The desk follows it: Home shows
   * the day, a chat shows what the assistant is using in that chat.
   */
  sessionId?: string | undefined;
  /**
   * The desk's reads (and its one small write, the per-chat recall exclusion). Without it the
   * rail shows no desk sections at all.
   */
  deskApi?: RailDeskApi;
  /**
   * The host's way to open a chat by id, for desk rows that point at one (a reminder's chat,
   * a held action's chat). Rows that need it render as plain rows without it.
   */
  onOpenChat?: (sessionId: string) => void;
  /**
   * The host's way to open the memory editing path, for a fact's "Forget everywhere". The rail
   * itself never edits memory, so the control shows only when the host hands this over.
   */
  onOpenMemorySettings?: () => void;
};

/** Same `aui-` prefixed style as the left rail's `aui-history-collapsed` preference. */
const RAIL_COLLAPSED_STORAGE_KEY = 'aui-runtime-rail-collapsed';

/** Returns the stored preference, or `false` when nothing usable is stored (default: expanded). */
function readStoredRailCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(RAIL_COLLAPSED_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch {
    /* ignore */
  }
  return false;
}

const STATUS_LABELS: Record<AmanRuntimeRailStatus, string> = {
  ready: 'Ready',
  connecting: 'Connecting',
  offline: 'Offline. Check your connection.',
  degraded: 'Connection is slow',
};

/**
 * The status line: the connection when it is not fine, then the wait on the person, Ready, or a
 * failure. While a reply runs it says nothing: the composer and the reply already say so on screen.
 */
function statusLineLabel({
  status,
  activity,
  waitingOnPerson,
}: {
  status: AmanRuntimeRailStatus;
  activity: AmanAvatarActivity;
  waitingOnPerson: boolean;
}): string | null {
  if (status !== 'ready') return STATUS_LABELS[status];
  if (waitingOnPerson) return WAITING_FOR_YOU_LABEL;
  switch (activity) {
    case 'idle':
      return 'Ready';
    case 'thinking':
    case 'writing':
      return null;
    case 'waiting':
      return WAITING_FOR_YOU_LABEL;
    case 'error':
      return 'Something went wrong. Send your message again.';
  }
}

type StatusTone = 'ready' | 'busy' | 'warning' | 'error';

/** The dot's colour: gold while working or waiting, green when ready, red on a failure. */
function statusToneOf({
  status,
  activity,
  waitingOnPerson,
}: {
  status: AmanRuntimeRailStatus;
  activity: AmanAvatarActivity;
  waitingOnPerson: boolean;
}): StatusTone {
  if (status === 'offline') return 'error';
  if (status !== 'ready') return 'warning';
  if (activity === 'error') return 'error';
  if (waitingOnPerson || activity === 'waiting' || activity === 'thinking' || activity === 'writing') return 'busy';
  return 'ready';
}

type RuntimeRailContentProps = Omit<AmanRuntimeRailProps, 'personalizationApi'>;

/** One folded row of the panel: a label with its chevron on the left, closed by default. */
const FoldedRow: FC<{ section: string; title: string; children: ReactNode }> = ({ section, title, children }) => (
  <details className="aman-runtime-rail__details" data-section={section}>
    <summary className="aman-runtime-rail__details-summary">
      <Icon name="chevron-right" size={12} className="aman-runtime-rail__fold-chevron" aria-hidden="true" />
      <span>{title}</span>
    </summary>
    <div className="aman-runtime-rail__details-body">{children}</div>
  </details>
);

/** The Rules fold's sentences, one per rule; none until the settings have loaded. */
function ruleSentences({
  settings,
  assistant,
}: {
  settings: SentinelUserSettings | null;
  assistant: string;
}): string[] {
  if (settings === null) return [];
  return [
    settings.search_without_asking ? 'Web searches run without asking' : 'Web searches ask first',
    settings.sandbox_without_asking
      ? `Read-only commands and ${assistant}'s own code in the workspace run without asking. Other commands ask first.`
      : 'Read-only commands in the workspace run without asking. Other commands ask first.',
    settings.offline_mode ? 'Offline mode is on' : 'Offline mode is off',
  ];
}

const RuntimeRailContent: FC<RuntimeRailContentProps> = ({
  avatarSrc,
  avatarMotion,
  activity = 'idle',
  personaName,
  status: statusOverride,
  pendingApprovalIds = [],
  privateChat = false,
  auditFeed,
  onOpenAudits,
  sessionId,
  deskApi,
  onOpenChat,
  onOpenMemorySettings,
  liveBrowserHref,
}) => {
  const profile = useOptionalPersonalization()?.profile;
  const assistantName = assistantDisplayName(profile?.assistant_name);
  const sentinel = useOptionalSentinelApiState();
  const settings = sentinel?.settings ?? null;
  const rules = ruleSentences({ settings, assistant: assistantName });
  const [collapsed, setCollapsed] = useState(readStoredRailCollapsed);
  // The host's explicit status always wins; otherwise the rail watches /healthz itself.
  const selfProbed = statusOverride === undefined;
  const connectivity = useRuntimeConnectivity({ enabled: selfProbed });
  const status = statusOverride ?? connectivity.status;
  const waitingOnPerson = pendingApprovalIds.length > 0;
  const statusLine = privateChat && status === 'ready' ? null : statusLineLabel({ status, activity, waitingOnPerson });
  // The desk's Home read. A change in the waiting approvals is the rail's own sign that the
  // day changed, so it doubles as the read's refresh signal beside the two-minute poll.
  const today = useRailToday(sessionId === undefined ? deskApi : undefined, pendingApprovalIds.join(','));
  // Folded, the poster's tooltip is all that is left, so it still says a reply is running.
  const compactLabel = statusLine ?? WORKING_ON_IT_LABEL;
  const tone = statusToneOf({ status, activity, waitingOnPerson });
  // A pending approval holds the panda in its waiting state, unless a failure takes the pose.
  const avatarActivity: AmanAvatarActivity = waitingOnPerson && activity !== 'error' ? 'waiting' : activity;
  const toggleLabel = collapsed ? 'Show panel' : 'Hide panel';
  const trimmedPersonaName = personaName?.trim();
  const posterSrc = avatarMotion?.poster ?? avatarSrc;
  const toggleCollapsed = useCallback(() => {
    setCollapsed(previous => {
      const next = !previous;
      try {
        window.localStorage.setItem(RAIL_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return (
    <aside
      className={collapsed ? 'aman-runtime-rail aman-runtime-rail--collapsed' : 'aman-runtime-rail'}
      aria-label="Amanuensis runtime status"
    >
      <div className="aman-runtime-rail__toolbar">
        <button
          type="button"
          className="aman-runtime-rail__collapse-toggle"
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={toggleCollapsed}
        >
          <Icon name={collapsed ? 'chevron-left' : 'chevron-right'} size={14} aria-hidden="true" />
        </button>
      </div>

      {collapsed ? (
        <>
          {/* The poster frame, with the status dot on its corner. The words are the tooltip. */}
          <div
            className="aman-runtime-rail__compact-status"
            data-tone={tone}
            role="img"
            aria-label={compactLabel}
            title={compactLabel}
          >
            {posterSrc === undefined ? null : (
              <img src={posterSrc} alt="" className="aman-runtime-rail__compact-poster" />
            )}
            <span className="aman-runtime-rail__status-dot" aria-hidden="true" />
          </div>
          <OfflineIndicator compact />
        </>
      ) : (
        <>
          <OfflineIndicator />

          <section
            className="aman-runtime-rail__avatar-card"
            data-section="panda"
            aria-labelledby="aman-runtime-rail-title"
          >
            {/* The frame is the picture's only box: rounded corners, no border, and nothing drawn over it. */}
            <div className="aman-runtime-rail__avatar">
              {avatarMotion ? (
                <AmanAvatarMotion
                  activity={avatarActivity}
                  sources={avatarMotion}
                  alt={avatarAltText(assistantName)}
                  className="aman-runtime-rail__picture"
                />
              ) : avatarSrc ? (
                <img src={avatarSrc} alt={avatarAltText(assistantName)} className="aman-runtime-rail__picture" />
              ) : (
                <span
                  className="aman-runtime-rail__avatar-fallback"
                  role="img"
                  aria-label={avatarAltText(assistantName)}
                >
                  {assistantName.slice(0, 1)}
                </span>
              )}
            </div>
            <div className="aman-runtime-rail__identity">
              <h2 id="aman-runtime-rail-title">{assistantName}</h2>
              <p className="aui-panda__role">Chief of staff</p>
            </div>
          </section>

          <div className="aman-runtime-rail__status" data-tone={tone} aria-live="polite">
            {statusLine === null ? null : (
              <>
                <span className="aman-runtime-rail__status-dot" aria-hidden="true" />
                <span>{statusLine}</span>
              </>
            )}
            {selfProbed && (status === 'offline' || status === 'degraded') && (
              <button
                type="button"
                className="aman-runtime-rail__retry"
                onClick={connectivity.retry}
                aria-label="Retry connectivity probe"
                title="Retry connectivity probe"
              >
                Retry
              </button>
            )}
          </div>

          {trimmedPersonaName === undefined || trimmedPersonaName === '' ? null : (
            <section
              className="aman-runtime-rail__section"
              data-section="persona"
              aria-labelledby="aman-runtime-rail-persona-label"
            >
              <h3 id="aman-runtime-rail-persona-label" className="aman-runtime-rail__section-label">
                Answering
              </h3>
              <div className="aman-runtime-rail__section-value" title={trimmedPersonaName}>
                {trimmedPersonaName}
              </div>
            </section>
          )}

          {/* A live page the person can jump to, opened beside the chat so the chat stays put. */}
          {liveBrowserHref === undefined ? null : (
            <section className="aman-runtime-rail__section" data-section="live-browser">
              <a
                className="aman-runtime-rail__live-browser"
                href={liveBrowserHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="aman-runtime-rail__live-dot" aria-hidden="true" />
                <span className="aman-runtime-rail__live-text">
                  <span className="aman-runtime-rail__live-title">Watch Live or Take Control</span>
                  <span className="aman-runtime-rail__live-detail">
                    {assistantName} has a page open. Watch it or take a step yourself.
                  </span>
                </span>
                <Icon name="external-link" size={16} className="aman-runtime-rail__live-open" aria-hidden="true" />
              </a>
            </section>
          )}

          {sessionId === undefined && deskApi !== undefined && today !== null ? (
            <RailHomeDesk today={today} onOpenChat={onOpenChat} />
          ) : null}

          {/* A private chat's desk stays shut: what the assistant is using in it is exactly
              what the rail must not describe for a chat that keeps nothing. */}
          {sessionId !== undefined && deskApi !== undefined && !privateChat ? (
            <RailChatDesk sessionId={sessionId} deskApi={deskApi} onOpenMemorySettings={onOpenMemorySettings} />
          ) : null}

          <FoldedRow section="activity" title="Activity">
            {/* The wait line comes straight from the chat, not the receipt: a carded action is
            written to the history only after it is answered, so while it waits the history
            holds nothing about it, and this line is the sign of it here. */}
            {waitingOnPerson && (
              <p className="aman-runtime-rail__waiting">
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-full ${ACTIVITY_STATE_DOT_CLASSES.waiting}`}
                />
                {WAITING_FOR_YOU_LABEL}
              </p>
            )}
            {auditFeed ?? <p className="aman-runtime-rail__row-text">Nothing has happened in this chat yet.</p>}
            {onOpenAudits !== undefined && (
              <button
                type="button"
                className="justify-self-start text-left text-xs text-text-secondary hover:underline underline-offset-1 mt-2"
                onClick={onOpenAudits}
              >
                Audits
              </button>
            )}
          </FoldedRow>

          <FoldedRow section="rules" title="Rules">
            {rules.length === 0 ? (
              <p className="aman-runtime-rail__row-text">No rules to show yet.</p>
            ) : (
              <ul className="aman-runtime-rail__rules">
                {rules.map(rule => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            )}
          </FoldedRow>
        </>
      )}
    </aside>
  );
};

/** A quiet desktop companion rail; hosts provide the avatar and live model label. */
export const AmanRuntimeRail: FC<AmanRuntimeRailProps> = ({ personalizationApi, ...props }) => {
  if (personalizationApi) {
    return (
      <PersonalizationProvider api={personalizationApi}>
        <RuntimeRailContent {...props} />
      </PersonalizationProvider>
    );
  }
  return <RuntimeRailContent {...props} />;
};
