import { useTrueFoundryAgentSpec, useTrueFoundryUpdateAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { formatDisplayVersion, formatDisplayVersionFull } from '@truefoundry/trueforge-core/core/displayVersion';
import { useCallback, useState, type FC, type ReactNode } from 'react';

import type { AmanAvatarActivity } from '../hooks/useAvatarActivity.js';
import { useRuntimeConnectivity } from '../hooks/useRuntimeConnectivity.js';
import { Icon } from '../icons/Icon.js';
import { OfflineIndicator } from '../sentinel/OfflineIndicator.js';
import { AmanAvatarMotion, type AmanAvatarMotionSources } from './AmanAvatarMotion.js';
import type { MemoryBankStatus } from './AmanSetupContext.js';
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
  /** Who the browser is signed in as. Without it the account row is left out. */
  userName?: string | undefined;
  /** The persona or agent answering right now, when the host tracks one. */
  personaName?: string | undefined;
  /** Host-provided status wins; when omitted the rail probes `/healthz` itself. */
  status?: AmanRuntimeRailStatus;
  /** Source reference the server's build was stamped with; absent on an unstamped build. */
  buildRef?: string | undefined;
  /**
   * The memory bank, null when memory is off, undefined when unknown. Unknown leaves the row out
   * rather than claiming a state the host could not confirm.
   */
  memoryBank?: MemoryBankStatus | null | undefined;
  /** Where "set up" points when memory is off; omitted renders plain text. */
  settingsHref?: string | undefined;
  /** @deprecated Wrap the rail and chat shell in `PersonalizationProvider` instead. */
  personalizationApi?: PersonalizationApi;
  /**
   * Live permissions audit feed node, provided by the host (e.g. `SentinelAuditFeed`
   * for the active session). Renders as a "Permissions" section; omitted leaves the
   * section out entirely.
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

type BuildSummary = { label: string; title: string };

/**
 * The footer keeps one narrow line for this, so the label stays short and the tooltip carries
 * the full reference for a bug report. The version is the shared display constant, never the
 * server's package version; an unstamped build reads as a dev build.
 * The word is "Release", not "Session": the number names the shipped build, not the chat.
 */
function summarizeBuild({ buildRef }: { buildRef: string | undefined }): BuildSummary {
  return {
    label: `Release ${formatDisplayVersion(buildRef)}`,
    title: `Release ${formatDisplayVersionFull(buildRef)}`,
  };
}

type RuntimeRailContentProps = Omit<AmanRuntimeRailProps, 'personalizationApi'>;

/**
 * Memory recall toggle: reads the current recallEnabled flag from the agent spec
 * and provides a switch to toggle it.
 */
const MemoryRecallToggle: FC<{ memoryBank: MemoryBankStatus | null | undefined }> = ({ memoryBank }) => {
  const { agentSpec } = useTrueFoundryAgentSpec();
  const updateAgentSpec = useTrueFoundryUpdateAgentSpec();

  const recallEnabled = agentSpec?.config?.memory?.recallEnabled ?? true;
  const isConfigured = !!memoryBank?.connected;

  const handleToggle = useCallback(() => {
    if (!updateAgentSpec) return;
    updateAgentSpec({
      config: {
        ...(agentSpec?.config ?? {}),
        memory: {
          ...(agentSpec?.config?.memory ?? {}),
          recallEnabled: !recallEnabled,
        },
      },
    });
  }, [updateAgentSpec, agentSpec, recallEnabled]);

  if (!isConfigured) {
    return null;
  }

  return (
    <label className="aman-runtime-rail__switch">
      <input type="checkbox" checked={recallEnabled} onChange={handleToggle} aria-label="Toggle memory recall" />
      <span>{recallEnabled ? 'On' : 'Off'}</span>
    </label>
  );
};

const RuntimeRailContent: FC<RuntimeRailContentProps> = ({
  avatarSrc,
  avatarMotion,
  activity = 'idle',
  modelName = 'Not configured',
  userName,
  personaName,
  status: statusOverride,
  buildRef,
  memoryBank,
  settingsHref,
  auditFeed,
}) => {
  const profile = useOptionalPersonalization()?.profile;
  const [collapsed, setCollapsed] = useState(readStoredRailCollapsed);
  // The host's explicit status always wins; otherwise the rail watches /healthz itself.
  const selfProbed = statusOverride === undefined;
  const connectivity = useRuntimeConnectivity({ enabled: selfProbed });
  const status = statusOverride ?? connectivity.status;
  const statusLabel = STATUS_LABELS[status];
  const toggleLabel = collapsed ? 'Expand rail' : 'Collapse rail';
  // Collapsed, and at phone width where the full status row is hidden, this one string is the
  // only place the connection state and the active model stay readable.
  const compactSummary = `${statusLabel} · ${modelName}`;
  const trimmedUserName = userName?.trim();
  const trimmedPersonaName = personaName?.trim();

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

  const build = summarizeBuild({ buildRef });

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

      {collapsed ? null : (
        <>
          <OfflineIndicator />

          <div className="aman-runtime-rail__avatar-card">
            {avatarMotion ? (
              <AmanAvatarMotion activity={activity} sources={avatarMotion} className="aman-runtime-rail__avatar" />
            ) : avatarSrc ? (
              <img src={avatarSrc} alt="Amanuensis avatar" className="aman-runtime-rail__avatar" />
            ) : (
              <span className="aman-runtime-rail__avatar-fallback" role="img" aria-label="Amanuensis avatar">
                A
              </span>
            )}
          </div>

          <div className="aman-runtime-rail__identity">
            <h2 id="aman-runtime-rail-title">{profile?.assistant_name?.trim() || 'Amanuensis'}</h2>
            <p>A personal assistant with a little character.</p>
          </div>

          {trimmedUserName === undefined || trimmedUserName === '' ? null : (
            <section
              className="aman-runtime-rail__section"
              data-section="account"
              aria-labelledby="aman-runtime-rail-account-label"
            >
              <h3 id="aman-runtime-rail-account-label" className="aman-runtime-rail__section-label">
                Signed in
              </h3>
              <div className="aman-runtime-rail__section-value" title={trimmedUserName}>
                {trimmedUserName}
              </div>
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

          <section
            className="aman-runtime-rail__section"
            data-section="model"
            aria-labelledby="aman-runtime-rail-model-label"
          >
            <h3 id="aman-runtime-rail-model-label" className="aman-runtime-rail__section-label">
              Model
            </h3>
            <div className="aman-runtime-rail__section-value" title={modelName}>
              {modelName}
            </div>
            <div className="aman-runtime-rail__status" data-status={status}>
              <span className="aman-runtime-rail__status-dot" aria-hidden="true" />
              <span>{statusLabel}</span>
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
          </section>

          {memoryBank === undefined ? null : (
            <section
              className="aman-runtime-rail__section"
              data-section="memory"
              aria-labelledby="aman-runtime-rail-memory-label"
            >
              <h3 id="aman-runtime-rail-memory-label" className="aman-runtime-rail__section-label">
                Memory
              </h3>
              {memoryBank === null ? (
                <div className="aman-runtime-rail__section-value">
                  Off
                  {settingsHref === undefined ? null : (
                    <>
                      {' · '}
                      <a href={settingsHref}>set up</a>
                    </>
                  )}
                </div>
              ) : memoryBank.connected ? (
                <>
                  <div className="aman-runtime-rail__section-value" title={memoryBank.name}>
                    {memoryBank.name} · on
                  </div>
                  <MemoryRecallToggle memoryBank={memoryBank} />
                </>
              ) : (
                <div className="aman-runtime-rail__section-value" title={memoryBank.name}>
                  {memoryBank.name} · needs sign-in
                  {settingsHref === undefined ? null : (
                    <>
                      {' · '}
                      <a href={settingsHref}>sign in</a>
                    </>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Everything an ordinary user would not act on sits behind one closed disclosure. */}
          {auditFeed === undefined ? null : (
            <section
              className="aman-runtime-rail__section"
              data-section="permissions"
              aria-labelledby="aman-runtime-rail-permissions-label"
            >
              <h3 id="aman-runtime-rail-permissions-label" className="aman-runtime-rail__section-label">
                Permissions
              </h3>
              {auditFeed}
            </section>
          )}

          <details className="aman-runtime-rail__details">
            <summary className="aman-runtime-rail__details-summary">Details</summary>
            <dl className="aman-runtime-rail__details-list">
              <dt>Connection check</dt>
              <dd>{selfProbed ? 'Run by this tab' : 'Reported by the app'}</dd>
              {selfProbed && connectivity.latencyMs != null && (
                <>
                  <dt>Round trip</dt>
                  <dd className="aman-runtime-rail__latency">{Math.round(connectivity.latencyMs)} ms</dd>
                </>
              )}
              <dt>Build reference</dt>
              <dd className="aman-runtime-rail__details-ref">{buildRef?.trim() || 'Not stamped'}</dd>
            </dl>
          </details>

          <p className="aman-runtime-rail__footer" title={build.title}>
            {build.label}
          </p>
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
