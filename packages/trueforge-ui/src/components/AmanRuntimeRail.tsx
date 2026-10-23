import { useCallback, useState, type FC, type ReactNode } from 'react';

import { WORKING_ON_IT_LABEL } from '../atoms/ComposerShell.js';
import type { AmanAvatarActivity } from '../hooks/useAvatarActivity.js';
import { useContextCompactionActive } from '../hooks/useContextCompactionActive.js';
import { useRuntimeConnectivity } from '../hooks/useRuntimeConnectivity.js';
import { Icon } from '../icons/Icon.js';
import { OfflineIndicator } from '../sentinel/OfflineIndicator.js';
import { useOptionalSentinelApiState } from '../sentinel/SentinelApiContext.js';
import { WAITING_FOR_YOU_LABEL } from '../sentinel/types.js';
import { assistantDisplayName } from '../utils/assistantName.js';
import { AmanAvatarMotion, avatarAltText, type AmanAvatarMotionSources } from './AmanAvatarMotion.js';
import {
  PersonalizationProvider,
  useOptionalPersonalization,
  type PersonalizationApi,
} from './PersonalizationContext.js';

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
  /** Where the "Change in Settings" link points; omitted hides the link. */
  settingsHref?: string | undefined;
  /** @deprecated Wrap the rail and chat shell in `PersonalizationProvider` instead. */
  personalizationApi?: PersonalizationApi;
  /** The chat the person is looking at, so the status line can say when its history is being shortened. */
  sessionId?: string | undefined;
  /** Ids of the approvals waiting on the person in this chat. Any id puts the panda in its waiting state. */
  pendingApprovalIds?: readonly string[];
  /**
   * The receipt node, provided by the host (e.g. `SentinelAuditFeed` for the active session).
   * It is the body of the Activity row.
   */
  auditFeed?: ReactNode;
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
 * The status line: the connection when it is not fine, then the wait on the person, otherwise
 * what the assistant is doing now.
 */
function statusLineLabel({
  status,
  activity,
  waitingOnPerson,
  compacting,
}: {
  status: AmanRuntimeRailStatus;
  activity: AmanAvatarActivity;
  waitingOnPerson: boolean;
  compacting: boolean;
}): string {
  if (status !== 'ready') return STATUS_LABELS[status];
  if (waitingOnPerson) return WAITING_FOR_YOU_LABEL;
  if (compacting && activity === 'thinking') return 'Tidying up the conversation';
  switch (activity) {
    case 'idle':
      return 'Ready';
    case 'thinking':
      return WORKING_ON_IT_LABEL;
    case 'writing':
      return 'Writing the answer';
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

const RuntimeRailContent: FC<RuntimeRailContentProps> = ({
  avatarSrc,
  avatarMotion,
  activity = 'idle',
  personaName,
  status: statusOverride,
  settingsHref,
  sessionId,
  pendingApprovalIds = [],
  auditFeed,
}) => {
  const profile = useOptionalPersonalization()?.profile;
  const assistantName = assistantDisplayName(profile?.assistant_name);
  const sentinel = useOptionalSentinelApiState();
  const settings = sentinel?.settings ?? null;
  const [collapsed, setCollapsed] = useState(readStoredRailCollapsed);
  // The host's explicit status always wins; otherwise the rail watches /healthz itself.
  const selfProbed = statusOverride === undefined;
  const connectivity = useRuntimeConnectivity({ enabled: selfProbed });
  const status = statusOverride ?? connectivity.status;
  const waitingOnPerson = pendingApprovalIds.length > 0;
  const compacting = useContextCompactionActive(sessionId);
  const statusLine = statusLineLabel({ status, activity, waitingOnPerson, compacting });
  const tone = statusToneOf({ status, activity, waitingOnPerson });
  // A pending approval holds the panda in its waiting state, unless a failure takes the pose.
  const avatarActivity: AmanAvatarActivity = waitingOnPerson && activity !== 'error' ? 'waiting' : activity;
  const toggleLabel = collapsed ? 'Expand rail' : 'Collapse rail';
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
            aria-label={statusLine}
            title={statusLine}
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
            {/* The frame is the picture's only box: rounded corners, no border, and the fade
                sits inside it so nothing can leave the rounded edge. */}
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
              <div className="aman-runtime-rail__fade" aria-hidden="true" />
            </div>
            <div className="aman-runtime-rail__identity">
              <h2 id="aman-runtime-rail-title">{assistantName}</h2>
              <p className="aui-panda__role">Chief of staff</p>
            </div>
          </section>

          <div className="aman-runtime-rail__status" data-tone={tone} aria-live="polite">
            <span className="aman-runtime-rail__status-dot" aria-hidden="true" />
            <span>{statusLine}</span>
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

          <FoldedRow section="rules" title="Rules">
            {settings === null ? null : (
              <ul className="aman-runtime-rail__rules">
                <li>{settings.search_without_asking ? 'Web searches run without asking' : 'Web searches ask first'}</li>
                <li>
                  {settings.sandbox_without_asking ? 'Sandbox code runs without asking' : 'Sandbox code asks first'}
                </li>
                <li>{settings.offline_mode ? 'Offline mode is on' : 'Offline mode is off'}</li>
              </ul>
            )}
            {settingsHref === undefined ? null : (
              <a className="aman-runtime-rail__link" href={settingsHref}>
                Change in Settings
              </a>
            )}
          </FoldedRow>

          <FoldedRow section="memory" title="Memory">
            <p className="aman-runtime-rail__row-text">What {assistantName} remembers is in Settings.</p>
            {settingsHref === undefined ? null : (
              <a className="aman-runtime-rail__link" href={settingsHref}>
                Open Settings
              </a>
            )}
          </FoldedRow>

          <FoldedRow section="activity" title="Activity">
            {auditFeed ?? <p className="aman-runtime-rail__row-text">Nothing has happened in this chat yet.</p>}
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
