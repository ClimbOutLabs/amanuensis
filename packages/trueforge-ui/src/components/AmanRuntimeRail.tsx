import { useCallback, useState, type FC, type ReactNode } from 'react';

import type { AmanAvatarActivity } from '../hooks/useAvatarActivity.js';
import { useHighlightedCard } from '../hooks/useRewardLedger.js';
import { useRuntimeConnectivity } from '../hooks/useRuntimeConnectivity.js';
import { Icon } from '../icons/Icon.js';
import { ACTIVITY_STATE_LABELS } from '../sentinel/activityVerbs.js';
import { OfflineIndicator } from '../sentinel/OfflineIndicator.js';
import { useOptionalSentinelApiState } from '../sentinel/SentinelApiContext.js';
import { AmanAvatarMotion, AVATAR_ALT, type AmanAvatarMotionSources } from './AmanAvatarMotion.js';
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
   * tool calls, memory ops), writing (visible response tokens streaming into chat), or error
   * (a surfaced failure, auto-cleared). Defaults to 'idle'. Connectivity is deliberately not
   * part of this: the rail's status dot owns reachability.
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
  /** Ids of the approvals waiting on the person in this chat, oldest first. Empty hides Needs you. */
  pendingApprovalIds?: readonly string[];
  /**
   * The receipt node, provided by the host (e.g. `SentinelAuditFeed` for the active session).
   * Omitted leaves the receipt out entirely.
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
  offline: 'Offline',
  degraded: 'Degraded',
};

/** The status line: the connection when it is not fine, otherwise what Aman is doing now. */
function statusLineLabel({
  status,
  activity,
}: {
  status: AmanRuntimeRailStatus;
  activity: AmanAvatarActivity;
}): string {
  if (status !== 'ready') return STATUS_LABELS[status];
  switch (activity) {
    case 'idle':
      return 'Ready';
    case 'thinking':
      return 'Working on it…';
    case 'writing':
      return 'Writing the answer…';
    case 'error':
      return 'Something went wrong';
  }
}

/** Enough of a commit SHA to compare against a branch or an image tag by eye. */
const SHORT_REF_LENGTH = 7;

/** Shortens a commit SHA; anything else (a tag, a branch) is already meant to be read whole. */
function shortenBuildRef(ref: string): string {
  return /^[0-9a-f]{12,}$/i.test(ref) ? ref.slice(0, SHORT_REF_LENGTH) : ref;
}

type BuildSummary = { label: string; title: string };

/**
 * The footer keeps one narrow line for this, so the label stays short and the tooltip carries
 * the full reference for a bug report. An unstamped build degrades to the version alone.
 * The word is "Release", not "Session": the number names the shipped build, not the chat.
 */
function summarizeBuild({ version, buildRef }: { version: string; buildRef: string | undefined }): BuildSummary {
  const ref = buildRef?.trim();
  if (ref === undefined || ref === '') {
    return { label: `Release ${version}`, title: `Release ${version}` };
  }
  return {
    label: `Release ${version} · ${shortenBuildRef(ref)}`,
    title: `Release ${version} · ${ref}`,
  };
}

type RuntimeRailContentProps = Omit<AmanRuntimeRailProps, 'personalizationApi'>;

const RuntimeRailContent: FC<RuntimeRailContentProps> = ({
  avatarSrc,
  avatarMotion,
  activity = 'idle',
  modelName = 'Not configured',
  personaName,
  status: statusOverride,
  version,
  buildRef,
  settingsHref,
  pendingApprovalIds = [],
  auditFeed,
}) => {
  const profile = useOptionalPersonalization()?.profile;
  const sentinel = useOptionalSentinelApiState();
  const settings = sentinel?.settings ?? null;
  const [collapsed, setCollapsed] = useState(readStoredRailCollapsed);
  // The host's explicit status always wins; otherwise the rail watches /healthz itself.
  const selfProbed = statusOverride === undefined;
  const connectivity = useRuntimeConnectivity({ enabled: selfProbed });
  const status = statusOverride ?? connectivity.status;
  const statusLabel = STATUS_LABELS[status];
  const statusLine = statusLineLabel({ status, activity });
  const trimmedVersion = version?.trim();
  const toggleLabel = collapsed ? 'Expand rail' : 'Collapse rail';
  // Collapsed, the dot is the only status left. Its words carry the connection state only; the
  // model name stays behind Details.
  const compactSummary = statusLabel;
  const trimmedPersonaName = personaName?.trim();
  const pendingCount = pendingApprovalIds.length;
  // Needs you is the rail's one gold card; the app's selection rule decides, not this component.
  const highlightedCard = useHighlightedCard({
    firstWaitingApprovalId: pendingApprovalIds[0] ?? null,
    nextAppointmentId: null,
  });
  const needsYouHighlighted = pendingCount > 0 && highlightedCard === pendingApprovalIds[0];

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

  const build =
    trimmedVersion === undefined || trimmedVersion === ''
      ? undefined
      : summarizeBuild({ version: trimmedVersion, buildRef });

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
          {collapsed ? null : <span className="aman-runtime-rail__button-label">Collapse</span>}
        </button>
      </div>

      {/* A dot alone, so the collapsed rail stays narrow; the label and tooltip carry the words. */}
      <div
        className="aman-runtime-rail__compact-status"
        data-status={status}
        role="img"
        aria-label={compactSummary}
        title={compactSummary}
      >
        <span className="aman-runtime-rail__status-dot" aria-hidden="true" />
      </div>

      {collapsed ? <OfflineIndicator compact /> : null}

      {collapsed ? null : (
        <>
          <OfflineIndicator />

          <section
            className="aui-ticket aui-ticket--punch aui-panda aman-runtime-rail__avatar-card"
            data-section="panda"
            aria-labelledby="aman-runtime-rail-title"
          >
            {avatarMotion ? (
              <AmanAvatarMotion activity={activity} sources={avatarMotion} className="aman-runtime-rail__avatar" />
            ) : avatarSrc ? (
              <img src={avatarSrc} alt={AVATAR_ALT} className="aman-runtime-rail__avatar" />
            ) : (
              <span className="aman-runtime-rail__avatar-fallback" role="img" aria-label={AVATAR_ALT}>
                A
              </span>
            )}
            <div className="aman-runtime-rail__identity aui-panda__caption">
              <h2 id="aman-runtime-rail-title">{profile?.assistant_name?.trim() || 'Amanuensis'}</h2>
              <p className="aui-panda__role">Your chief of staff</p>
            </div>
          </section>

          <div className="aman-runtime-rail__status" data-status={status} aria-live="polite">
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

          {pendingCount === 0 ? null : (
            <section
              className={
                needsYouHighlighted
                  ? 'aui-ticket aui-ticket--selected aman-runtime-rail__needs-you'
                  : 'aui-ticket aman-runtime-rail__needs-you'
              }
              data-section="needs-you"
              aria-labelledby="aman-runtime-rail-needs-label"
            >
              <h3 id="aman-runtime-rail-needs-label" className="aman-runtime-rail__section-label">
                Needs you · {pendingCount}
              </h3>
              <p className="aman-runtime-rail__needs-body">Answer {pendingCount === 1 ? 'it' : 'them'} in the chat.</p>
              <p className="aui-panda__role text-gold-ink">{ACTIVITY_STATE_LABELS.waiting}</p>
            </section>
          )}

          {settings === null ? null : (
            <section
              className="aman-runtime-rail__section"
              data-section="rules"
              aria-labelledby="aman-runtime-rail-rules-label"
            >
              <h3 id="aman-runtime-rail-rules-label" className="aman-runtime-rail__section-label">
                Your rules
              </h3>
              <ul className="aman-runtime-rail__rules">
                <li>{settings.search_without_asking ? 'Web searches run without asking' : 'Web searches ask first'}</li>
                <li>
                  {settings.sandbox_without_asking ? 'Sandbox code runs without asking' : 'Sandbox code asks first'}
                </li>
                <li>{settings.offline_mode ? 'Offline mode is on' : 'Offline mode is off'}</li>
              </ul>
              {settingsHref === undefined ? null : (
                <a className="aman-runtime-rail__link" href={settingsHref}>
                  Change in Settings
                </a>
              )}
            </section>
          )}

          {auditFeed === undefined ? null : (
            <section
              className="aman-runtime-rail__section"
              data-section="recent-actions"
              aria-labelledby="aman-runtime-rail-recent-actions-label"
            >
              <h3 id="aman-runtime-rail-recent-actions-label" className="aman-runtime-rail__section-label">
                Recent actions
              </h3>
              {auditFeed}
            </section>
          )}

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

          {/* Everything an ordinary user would not act on sits behind one closed disclosure. */}
          <details className="aman-runtime-rail__details">
            <summary className="aman-runtime-rail__details-summary">Details</summary>
            <dl className="aman-runtime-rail__details-list">
              <dt>Model</dt>
              <dd className="aman-runtime-rail__model" title={modelName}>
                {modelName}
              </dd>
              <dt>Connection check</dt>
              <dd>{selfProbed ? 'Run by this tab' : 'Reported by the app'}</dd>
              {selfProbed && connectivity.latencyMs != null && (
                <>
                  <dt>Round trip</dt>
                  <dd className="aman-runtime-rail__latency">{Math.round(connectivity.latencyMs)} ms</dd>
                </>
              )}
              {build === undefined ? null : (
                <>
                  <dt>Build reference</dt>
                  <dd className="aman-runtime-rail__details-ref">{buildRef?.trim() || 'Not stamped'}</dd>
                </>
              )}
            </dl>
          </details>

          {build === undefined ? null : (
            <p className="aman-runtime-rail__footer" title={build.title}>
              {build.label}
            </p>
          )}
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
