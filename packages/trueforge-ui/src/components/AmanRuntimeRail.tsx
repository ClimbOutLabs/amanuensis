import { useTrueFoundryAgentSpec, useTrueFoundryUpdateAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useCallback, type FC } from 'react';

import { MascotAnimator } from '../atoms/MascotAnimator.js';
import type { MemoryBankStatus } from './AmanSetupContext.js';
import {
  PersonalizationProvider,
  useOptionalPersonalization,
  type PersonalizationApi,
} from './PersonalizationContext.js';

export type AmanRuntimeRailStatus = 'ready' | 'connecting' | 'offline';

export type AmanRuntimeRailProps = {
  avatarSrc?: string;
  modelName?: string;
  status?: AmanRuntimeRailStatus;
  /** Package version of the server answering. Without it the build row is left out. */
  version?: string | undefined;
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
};

const STATUS_LABELS: Record<AmanRuntimeRailStatus, string> = {
  ready: 'Ready',
  connecting: 'Connecting',
  offline: 'Offline',
};

/** Enough of a commit SHA to compare against a branch or an image tag by eye. */
const SHORT_REF_LENGTH = 7;

/** Shortens a commit SHA; anything else (a tag, a branch) is already meant to be read whole. */
function shortenBuildRef(ref: string): string {
  return /^[0-9a-f]{12,}$/i.test(ref) ? ref.slice(0, SHORT_REF_LENGTH) : ref;
}

type BuildSummary = { label: string; title: string };

/**
 * The rail has one narrow line for this, so the label stays short and the tooltip carries
 * the full reference for a bug report. An unstamped build degrades to the version alone.
 */
function summarizeBuild({ version, buildRef }: { version: string; buildRef: string | undefined }): BuildSummary {
  const ref = buildRef?.trim();
  if (ref === undefined || ref === '') {
    return { label: version, title: version };
  }
  return { label: `${version} · ${shortenBuildRef(ref)}`, title: `${version} · ${ref}` };
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
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <input
        type="checkbox"
        checked={recallEnabled}
        onChange={handleToggle}
        aria-label="Toggle memory recall"
        style={{ cursor: 'pointer' }}
      />
      <span>{recallEnabled ? 'On' : 'Off'}</span>
    </div>
  );
};

const RuntimeRailContent: FC<RuntimeRailContentProps> = ({
  avatarSrc,
  modelName = 'Not configured',
  status = 'ready',
  version,
  buildRef,
  memoryBank,
  settingsHref,
}) => {
  const profile = useOptionalPersonalization()?.profile;
  const statusLabel = STATUS_LABELS[status];
  const trimmedVersion = version?.trim();
  const build =
    trimmedVersion === undefined || trimmedVersion === ''
      ? undefined
      : summarizeBuild({ version: trimmedVersion, buildRef });

  return (
    <aside className="aman-runtime-rail" aria-label="Amanuensis runtime status">
      <div className="aman-runtime-rail__avatar-card">
        {avatarSrc ? (
          <MascotAnimator src={avatarSrc} alt="Amanuensis avatar" className="aman-runtime-rail__avatar" />
        ) : (
          <div className="aman-runtime-rail__avatar-fallback" role="img" aria-label="Amanuensis avatar">
            A
          </div>
        )}
      </div>

      <div className="aman-runtime-rail__status" data-status={status}>
        <span className="aman-runtime-rail__status-dot" aria-hidden="true" />
        <span>{statusLabel}</span>
      </div>

      <section className="aman-runtime-rail__identity" aria-labelledby="aman-runtime-rail-title">
        <h2 id="aman-runtime-rail-title">{profile?.assistant_name?.trim() || 'Amanuensis'}</h2>
        <p>A personal assistant with a little character.</p>
      </section>

      <dl className="aman-runtime-rail__details">
        {build === undefined ? null : (
          <div>
            <dt>Build</dt>
            <dd title={build.title}>{build.label}</dd>
          </div>
        )}
        <div>
          <dt>Model</dt>
          <dd title={modelName}>{modelName}</dd>
        </div>
        {memoryBank === undefined ? null : (
          <div>
            <dt>Memory</dt>
            {memoryBank === null ? (
              <dd>
                Off
                {settingsHref === undefined ? null : (
                  <>
                    {' · '}
                    <a href={settingsHref}>set up</a>
                  </>
                )}
              </dd>
            ) : memoryBank.connected ? (
              <dd title={memoryBank.name}>
                {memoryBank.name} · on
                <MemoryRecallToggle memoryBank={memoryBank} />
              </dd>
            ) : (
              <dd title={memoryBank.name}>
                {memoryBank.name} · needs sign-in
                {settingsHref === undefined ? null : (
                  <>
                    {' · '}
                    <a href={settingsHref}>sign in</a>
                  </>
                )}
              </dd>
            )}
          </div>
        )}
      </dl>
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
