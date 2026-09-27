'use client';

import { useCallback, useEffect, useState } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import { Switch } from '@/atoms/primitives/Switch.js';
import {
  type DataFlowConnection,
  type DataFlowManifest,
  type PrivacyCatalog,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/privacyCatalog.js';
import { useOptionalServer } from '@/server/ServerContext.js';
import { useToasterOptional } from '../ToasterContainer.js';

/**
 * Structural check: the trueforge adapter attaches a `privacy` port next to
 * the runtime's `AgentUIServer` surface; other servers don't carry it.
 * Read-only shape probe, so a foreign server simply reports "not supported".
 */
function hasPrivacyPort(server: object): server is { privacy: PrivacyCatalog } {
  const port: unknown = Reflect.get(server, 'privacy');
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'getOfflineMode') === 'function' &&
    typeof Reflect.get(port, 'setOfflineMode') === 'function' &&
    typeof Reflect.get(port, 'getDataFlowManifest') === 'function' &&
    typeof Reflect.get(port, 'downloadExport') === 'function'
  );
}

function usePrivacyPort(): PrivacyCatalog | null {
  const server = useOptionalServer();
  if (server === null || server === undefined) return null;
  return hasPrivacyPort(server) ? server.privacy : null;
}

interface OfflineModeState {
  supported: boolean;
  enabled: boolean | null;
  saving: boolean;
  error: string | null;
  setEnabled(enabled: boolean): Promise<void>;
}

function useOfflineMode(): OfflineModeState {
  const privacy = usePrivacyPort();
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (privacy === null) return;
    let cancelled = false;
    privacy
      .getOfflineMode()
      .then(state => {
        if (!cancelled) setEnabledState(state.enabled);
      })
      .catch(() => {
        if (!cancelled) setEnabledState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [privacy]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (privacy === null) return;
      const previous = enabled;
      setEnabledState(next);
      setSaving(true);
      setError(null);
      try {
        const confirmed = await privacy.setOfflineMode(next);
        setEnabledState(confirmed.enabled);
      } catch (err) {
        setEnabledState(previous);
        setError(err instanceof Error ? err.message : 'Could not change offline mode');
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [privacy, enabled],
  );

  return { supported: privacy !== null, enabled, saving, error, setEnabled };
}

function StatusPill(props: { on: boolean | null }) {
  const label = props.on === null ? 'Unknown' : props.on ? 'On' : 'Off';
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-full border border-border bg-secondary-bg/40 px-2 py-0.5 text-xs font-medium',
        props.on === true ? 'text-success-bg' : 'text-text-primary',
      )}
      role="status"
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', props.on === true ? 'bg-success-bg' : 'bg-border')} />
      {label}
    </span>
  );
}

function OfflineModeCard() {
  const offline = useOfflineMode();
  const toaster = useToasterOptional();
  if (!offline.supported) return null;

  const checked = offline.enabled ?? false;
  return (
    <section
      aria-labelledby="offline-mode-heading"
      className="rounded-xl border border-border bg-card-bg p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <StatusPill on={offline.enabled} />
          <h4 id="offline-mode-heading" className="mt-2 text-sm font-medium text-text-primary">
            Offline mode
          </h4>
          <p className="mt-0.5 text-sm text-text-secondary">
            Stops the server from reaching the internet. Your assistant keeps working with local
            models and memory. Any fetch call the server makes that is not to this machine or your
            local network is refused with a clear error, including model APIs, OAuth, remote tools,
            and downloads. Downloads that run inside sandboxes, such as git skill updates, are outside
            this boundary: remove those skills to stop their network access.
          </p>
        </div>
        <Switch
          id="offline-mode-toggle"
          checked={checked}
          disabled={offline.saving || offline.enabled === null}
          onCheckedChange={next => {
            void offline
              .setEnabled(next)
              .then(() =>
                toaster?.showSuccess({
                  title: next ? 'Offline mode is on' : 'Offline mode is off',
                }),
              )
              .catch(() => {
                toaster?.showError('Could not change offline mode');
              });
          }}
          aria-label="Offline mode"
        />
      </div>
      {offline.error === null ? null : (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {offline.error}
        </p>
      )}
    </section>
  );
}

function ExportCard() {
  const privacy = usePrivacyPort();
  const toaster = useToasterOptional();
  const [downloading, setDownloading] = useState(false);
  if (privacy === null) return null;

  return (
    <section aria-labelledby="export-heading" className="rounded-xl border border-border bg-card-bg p-4">
      <h4 id="export-heading" className="text-sm font-medium text-text-primary">
        Download all my data
      </h4>
      <p className="mt-0.5 text-sm text-text-secondary">
        One click, one zip: all your chats, your memory files (MEMORY.md plus daily logs), settings,
        personas, and schedules. Credential-shaped values are redacted; your memory files ship
        exactly as you wrote them.
      </p>
      <button
        type="button"
        className={cn(auiButtonClass({ variant: 'primary' }), 'mt-3')}
        disabled={downloading}
        onClick={() => {
          setDownloading(true);
          void privacy
            .downloadExport()
            .then(() => toaster?.showSuccess({ title: 'Your export is downloading' }))
            .catch(() => toaster?.showError('The export download failed'))
            .finally(() => setDownloading(false));
        }}
      >
        {downloading ? 'Preparing…' : 'Download all my data'}
      </button>
    </section>
  );
}

const NOT_COLLECTED: { title: string; detail: string }[] = [
  {
    title: 'Usage analytics',
    detail:
      'No event tracking, no page views, no feature counters. Nothing phones home about how you use the product.',
  },
  {
    title: 'Crash reports',
    detail:
      'No automatic crash reporting. Errors stay in your own server logs, on your own machine.',
  },
  {
    title: 'Conversation content',
    detail:
      'Your chats never leave this box except to the model provider you configured, for the turn you asked for.',
  },
  {
    title: 'Telemetry SDKs',
    detail:
      'No PostHog, Mixpanel, Amplitude, Sentry, or similar anywhere in the dependency tree.',
  },
];

const PROOF_LINKS: { label: string; href: string }[] = [
  {
    label: 'The complete list of network calls (privacy/dataFlow.ts)',
    href: 'https://github.com/ClimbOutLabs/amanuensis/blob/main/packages/trueforge/src/privacy/dataFlow.ts',
  },
  {
    label: 'The offline-mode network guard (privacy/offlineGuard.ts)',
    href: 'https://github.com/ClimbOutLabs/amanuensis/blob/main/packages/trueforge/src/privacy/offlineGuard.ts',
  },
  {
    label: 'The export endpoint with secret scrubbing (apis/privacy.ts)',
    href: 'https://github.com/ClimbOutLabs/amanuensis/blob/main/packages/trueforge/src/apis/privacy.ts',
  },
];

function ZeroTelemetryCard() {
  return (
    <section
      aria-labelledby="zero-telemetry-heading"
      className="rounded-xl border border-border bg-card-bg p-4"
    >
      <h4 id="zero-telemetry-heading" className="text-sm font-medium text-text-primary">
        We collect nothing
      </h4>
      <p className="mt-0.5 text-sm text-text-secondary">
        There is no telemetry code in this product. Search the codebase for analytics or tracking
        vendors yourself: the only network calls the system can make are the ones listed in the
        data-flow section below, each tied to a feature you configured. (OpenTelemetry appears only
        for in-process context propagation inside the server, never for sending data to a vendor.)
      </p>
      <ul className="mt-3 space-y-2">
        {NOT_COLLECTED.map(item => (
          <li key={item.title} className="flex gap-2 text-sm">
            <span aria-hidden="true" className="mt-0.5 shrink-0 text-text-tertiary">
              •
            </span>
            <span>
              <span className="font-medium text-text-primary">{item.title}.</span>{' '}
              <span className="text-text-secondary">{item.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs font-medium text-text-primary">Verify it yourself</p>
      <ul className="mt-1 space-y-1">
        {PROOF_LINKS.map(link => (
          <li key={link.href}>
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-text-secondary underline underline-offset-2 hover:text-text-primary"
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DataFlowCard(props: { manifest: DataFlowManifest | null; error: string | null }) {
  const { manifest, error } = props;
  return (
    <section aria-labelledby="data-flow-heading" className="rounded-xl border border-border bg-card-bg p-4">
      <h4 id="data-flow-heading" className="text-sm font-medium text-text-primary">
        Where your data can go
      </h4>
      <p className="mt-0.5 text-sm text-text-secondary">
        Every external connection this system can make, in plain language: what is sent, where, why,
        and how to turn it off.
      </p>
      {error !== null ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : manifest === null ? (
        <p className="mt-2 text-xs text-text-secondary">Loading…</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {manifest.connections.map(connection => (
            <DataFlowRow key={connection.id} connection={connection} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DataFlowRow(props: { connection: DataFlowConnection }) {
  const { connection } = props;
  return (
    <li className="rounded-lg border border-border bg-secondary-bg/30 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-text-primary">{connection.category}</p>
        <p className="shrink-0 text-xs text-text-tertiary">{connection.id}</p>
      </div>
      <dl className="mt-2 space-y-1.5 text-xs">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 font-medium text-text-secondary">Destination</dt>
          <dd className="text-text-primary">{connection.destination}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 font-medium text-text-secondary">Data sent</dt>
          <dd className="text-text-primary">{connection.dataSent}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 font-medium text-text-secondary">Why</dt>
          <dd className="text-text-primary">{connection.purpose}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 font-medium text-text-secondary">Disable</dt>
          <dd className="text-text-primary">{connection.howToDisable}</dd>
        </div>
      </dl>
    </li>
  );
}

const PrivacySettings = () => {
  const privacy = usePrivacyPort();
  const [manifest, setManifest] = useState<DataFlowManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);

  useEffect(() => {
    if (privacy === null) return;
    let cancelled = false;
    privacy
      .getDataFlowManifest()
      .then(result => {
        if (!cancelled) setManifest(result);
      })
      .catch(() => {
        if (!cancelled) setManifestError('Could not load the data-flow manifest from the server.');
      });
    return () => {
      cancelled = true;
    };
  }, [privacy]);

  if (privacy === null) {
    return (
      <p className="py-8 text-center text-sm text-text-secondary">
        The connected server does not support the privacy controls.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <OfflineModeCard />
      <ExportCard />
      <ZeroTelemetryCard />
      <DataFlowCard manifest={manifest} error={manifestError} />
    </div>
  );
};

export default PrivacySettings;
