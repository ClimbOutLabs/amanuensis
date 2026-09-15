'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@/atoms/lib/cn.js';
import { Button } from '@/atoms/primitives/Button.js';
import { Switch } from '@/atoms/primitives/Switch.js';
import { useMCPAuth } from '@/hooks/useMcpAuth.js';
import { Icon } from '@/icons/Icon.js';
import { hasMemoryProviderCheck } from '@/server/connectorChecks.js';
import type { MemoryProviderUpdateRequest } from '@/server/memoryProviderTypes.js';
import {
  useCatalogServer,
  useOptionalRefreshServerCapabilities,
  useServerCapabilities,
} from '@/server/ServerContext.js';
import type { ConnectorBase } from '@/server/types.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';
import { useToasterOptional } from '../ToasterContainer.js';
import AddMcpServerForm, { type AddMcpServerDraft, type AddMcpServerPlaceholders } from './AddMcpServerForm.js';
import { readMemoryDefaults } from './memoryDefaultsCapability.js';
import {
  isMemoryProvider,
  MEMORY_PROVIDER_NOTES,
  MEMORY_PROVIDER_URL_ERROR,
  MEMORY_PROVIDER_URL_PATTERN,
  memoryProviderCreateRequest,
  memoryProviderUpdateRequest,
  readMemorySettings,
  type MemoryProviderConnector,
} from './memoryProvider.js';
import {
  readMemoryScreenStatus,
  readToolOutputScreenStatus,
  type MemoryScreenStatus,
} from './memoryScreenCapability.js';
import MemoryTuningForm, { draftFromSettings, settingsFromDraft, type MemoryTuningDraft } from './MemoryTuningForm.js';

/** Result of one live recall against the provider's REST API. */
type CheckStatus = { ok: boolean; message: string };
type ScreenStatus = { enabled: boolean; threshold?: number; timeoutMs?: number } | null;
type ScreenState = 'on' | 'off' | 'unavailable';

function screenStateOf(status: ScreenStatus): ScreenState {
  return status === null ? 'unavailable' : status.enabled ? 'on' : 'off';
}

function ScreenStatusCard(props: {
  headingId: string;
  title: string;
  description: string;
  status: ScreenStatus;
  enabledText: string;
  disabledText: string;
  unavailableText: string;
  envNames: readonly string[];
  extraNote?: string;
}) {
  const state = screenStateOf(props.status);
  return (
    <section aria-labelledby={props.headingId} className="rounded-xl border border-border bg-card-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-full border border-border bg-secondary-bg/40 px-2 py-0.5 text-xs font-medium',
                state === 'on' ? 'text-success-bg' : 'text-text-primary',
              )}
              role="status"
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  state === 'on' ? 'bg-success-bg' : state === 'off' ? 'bg-primary-button-bg' : 'bg-border',
                )}
              />
              {state === 'on' ? props.enabledText : state === 'off' ? props.disabledText : props.unavailableText}
            </span>
          </div>
          <h4 id={props.headingId} className="mt-2 text-sm font-medium text-text-primary">
            {props.title}
          </h4>
          <p className="mt-0.5 text-sm text-text-secondary">{props.description}</p>
        </div>
      </div>

      {state === 'on' ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-text-secondary">Threshold</dt>
          <dd className="text-text-primary">{props.status?.threshold ?? 'Default'}</dd>
          {props.status?.timeoutMs === undefined ? null : (
            <>
              <dt className="text-text-secondary">Timeout</dt>
              <dd className="text-text-primary">{props.status.timeoutMs} ms</dd>
            </>
          )}
        </dl>
      ) : state === 'unavailable' ? (
        <p className="mt-3 text-xs text-text-secondary">
          The server did not report this screen&apos;s status — it may be an older build, or the capabilities request
          has not finished. On or off cannot be confirmed here.
        </p>
      ) : null}

      <p className="mt-3 text-xs text-text-secondary">
        Configure with{' '}
        {props.envNames.map((name, index) => (
          <span key={name}>
            {index === 0 ? null : index === props.envNames.length - 1 ? ' and ' : ', '}
            <code>{name}</code>
          </span>
        ))}{' '}
        in the server&apos;s environment. The classifier URL and bearer token stay server-side and are never shown here.
        {props.extraNote === undefined ? null : ` ${props.extraNote}`}
      </p>
    </section>
  );
}

/**
 * The recall screen switch, shown under the active bank. Checked reflects the effective state
 * (the stored per-bank `screenEnabled` setting when this bank has one, else the server's
 * `MEMORY_SCREEN_ENABLED` default as `memoryScreen.enabled` already reports it) rather than only
 * the stored setting, so the switch never shows off when a server default is quietly running it,
 * or on when a server default is quietly leaving it off. Disabled, with the server's reason, when
 * `memoryScreen.configured` is false: with no classifier service, flipping the switch would do
 * nothing.
 */
function MemoryScreenToggle(props: {
  status: MemoryScreenStatus | null;
  checked: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { status, checked, busy, onToggle } = props;
  const configured = status?.configured ?? true;
  const reason = status?.reason;
  return (
    <div className="mt-4 flex items-start justify-between gap-4 border-t border-border pt-4">
      <div className="min-w-0">
        <label htmlFor="memory-screen-toggle" className="text-sm font-medium text-text-primary">
          Screen recalled memories with Prompt Guard
        </label>
        <p className="mt-0.5 text-xs text-text-secondary">
          Memories that came from tools, documents or email are checked for prompt injection before they reach the
          model. Your own stated memories are never withheld.
        </p>
        {!configured && reason !== undefined ? <p className="mt-1 text-xs text-text-secondary">{reason}</p> : null}
      </div>
      <Switch
        id="memory-screen-toggle"
        checked={checked}
        disabled={busy || !configured}
        onCheckedChange={onToggle}
        aria-label="Screen recalled memories with Prompt Guard"
      />
    </div>
  );
}

/**
 * Field hints for the bank editor. The URL one carries real weight: the shape is required, not
 * illustrative, so the example ends in a bank segment rather than the generic connector endpoint.
 */
const MEMORY_FIELD_PLACEHOLDERS: AddMcpServerPlaceholders = {
  name: 'personal-memory',
  description: 'Long-term memory for this assistant',
  url: 'https://hindsight.example.com:8449/mcp/personal',
};

/**
 * Memory settings: the one bank the host recalls from and retains to.
 *
 * The bank is stored as an ordinary MCP server row with `memory_provider: true`, but it is not a
 * connector in any sense a user acts on: it is never offered in a chat picker, the model never
 * chooses to call it, and it is not listed under Connectors. So it gets its own section, and this
 * section owns its whole lifecycle (point at a bank, edit it, test it, remove it) to make sure
 * removing it from the connectors list leaves no row a user can no longer reach.
 *
 * Memory is on when a bank is configured and off when none is. There is deliberately no third
 * state that keeps the row and clears the flag: the flag is the only thing marking the row as the
 * bank, so clearing it would hide the row from here and hand it back to the connector picker as an
 * ordinary attachable server, which is precisely what this section exists to prevent.
 */
const MemorySettings = () => {
  const { connectorCatalog } = useCatalogServer();
  const toaster = useToasterOptional();
  const { handleAuthorize, isOAuthLoading } = useMCPAuth();
  const capabilities = useServerCapabilities();
  const refreshCapabilities = useOptionalRefreshServerCapabilities();
  const memoryScreen = readMemoryScreenStatus(capabilities);
  const toolOutputScreen = readToolOutputScreenStatus(capabilities);
  const memoryDefaults = readMemoryDefaults(capabilities);

  const [provider, setProvider] = useState<MemoryProviderConnector | null>(null);
  /**
   * A bank that is saved but not yet the memory provider, held for as long as it takes to
   * authorize it. Only OAuth banks pass through here; see {@link handleSave}.
   */
  const [stagedBank, setStagedBank] = useState<ConnectorBase | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkStatus, setCheckStatus] = useState<CheckStatus | null>(null);
  const [checkInFlight, setCheckInFlight] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [tuning, setTuning] = useState<MemoryTuningDraft>(() => draftFromSettings(undefined));
  const [tuningError, setTuningError] = useState<string | null>(null);

  // The memory check lives on the Harness adapter, not on the runtime's generic connector port.
  // Read for it and hide the control when it is absent, exactly as ConnectorSettings does.
  const memoryProviderChecker = hasMemoryProviderCheck(connectorCatalog)
    ? (req: { id: string }) => connectorCatalog.checkMemoryProvider(req)
    : undefined;
  const canDelete = connectorCatalog.deleteConnector != null;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const listed = await connectorCatalog.listConnectors();
      setProvider((listed ?? []).find(isMemoryProvider) ?? null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load memory settings'));
    } finally {
      setLoading(false);
    }
  }, [connectorCatalog]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setTuning(draftFromSettings(provider === null ? undefined : readMemorySettings(provider)));
    setTuningError(null);
  }, [provider]);

  const handleSaveTuning = () => {
    if (provider === null) return;
    const parsed = settingsFromDraft(tuning);
    if (!parsed.ok) {
      setTuningError(parsed.error);
      return;
    }
    setTuningError(null);
    setCheckStatus(null);
    void runMutation(async () => {
      const base = memoryProviderUpdateRequest(provider, true);
      const { memorySettings: _previous, ...rest } = base;
      const request: MemoryProviderUpdateRequest = {
        ...rest,
        ...(parsed.settings === undefined ? {} : { memorySettings: parsed.settings }),
      };
      await connectorCatalog.updateConnector(request);
    }, setTuningError)
      .then(() => {
        toaster?.showSuccess({ title: 'Memory tuning saved' });
      })
      .catch(() => {});
  };

  /**
   * Writes the recall screen switch immediately, rather than batching it into "Save tuning": it
   * reads as an on/off control, not a tuning value to draft and confirm. Resupplies every other
   * stored setting via `memoryProviderUpdateRequest` so flipping this switch cannot clear them.
   */
  const handleToggleScreen = (next: boolean) => {
    if (provider === null) return;
    setCheckStatus(null);
    void runMutation(async () => {
      const base = memoryProviderUpdateRequest(provider, true);
      const request: MemoryProviderUpdateRequest = {
        ...base,
        memorySettings: { ...base.memorySettings, screen_enabled: next },
      };
      await connectorCatalog.updateConnector(request);
    })
      .then(() => {
        toaster?.showSuccess({ title: next ? 'Recall screening is on' : 'Recall screening is off' });
        refreshCapabilities?.();
      })
      .catch(() => {});
  };

  const runMutation = async (fn: () => Promise<void>, setMutationError: (message: string) => void = setError) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setMutationError(getErrorMessage(err, 'Request failed'));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  /** Seeds the editor from the saved row. The API key is never seeded; see AddMcpServerForm. */
  const editorDraft = useMemo<AddMcpServerDraft | undefined>(() => {
    if (provider === null) return undefined;
    return {
      name: provider.name,
      url: provider.url,
      description: provider.description,
      auth: provider.auth,
    };
  }, [provider]);

  const handleSave = async (draft: AddMcpServerDraft) => {
    if (!MEMORY_PROVIDER_URL_PATTERN.test(draft.url)) {
      setFormError(MEMORY_PROVIDER_URL_ERROR);
      throw new Error(MEMORY_PROVIDER_URL_ERROR);
    }
    setFormError(null);
    setCheckStatus(null);
    const existing = provider;

    // A new OAuth bank cannot be flagged by the same write that creates it. The server dials the
    // bank before it accepts the flag, and a brand-new OAuth row has no token to dial with, so a
    // flagged create is refused every time. It is saved unflagged first and becomes the memory
    // provider once it is authorized, which is what the staged panel below walks through. Every
    // other auth type keeps the single flagged create: the server validates it once, and a
    // failure leaves no half-configured row behind.
    if (existing === null && draft.auth.type === 'dcr') {
      await runMutation(async () => {
        setStagedBank(await connectorCatalog.createConnector({ ...draft }));
      }, setFormError);
      setEditorOpen(false);
      return;
    }

    // The server runs a live recall before it accepts the flag and rejects a bank it cannot
    // reach, naming the upstream reason. That reason is the whole value of the save, so it is
    // surfaced on the form rather than collapsed into the page banner.
    await runMutation(async () => {
      if (existing === null) {
        await connectorCatalog.createConnector(memoryProviderCreateRequest(draft));
      } else {
        await connectorCatalog.updateConnector({
          ...memoryProviderUpdateRequest(existing, true),
          url: draft.url,
          description: draft.description,
          auth: draft.auth,
        });
      }
    }, setFormError);
    setEditorOpen(false);
    setTimeout(() => {
      toaster?.showSuccess({ title: existing === null ? 'Memory is on' : `${draft.name} updated` });
    }, 0);
  };

  /** Signs in to a staged bank, then re-reads it so its authorization shows here. */
  const handleAuthorizeStaged = () => {
    if (stagedBank === null) return;
    const { id } = stagedBank;
    void handleAuthorize(id, isSuccess => {
      if (!isSuccess) return;
      void connectorCatalog
        .getConnector({ id })
        .then(setStagedBank)
        .catch((err: unknown) => {
          setError(getErrorMessage(err, 'Failed to re-read the bank after authorizing it'));
        });
    });
  };

  /** Sets the flag on an authorized staged bank. This is the write the server checks. */
  const handleEnableStaged = () => {
    if (stagedBank === null) return;
    setCheckStatus(null);
    void runMutation(async () => {
      await connectorCatalog.updateConnector(memoryProviderUpdateRequest(stagedBank, true));
      setStagedBank(null);
    })
      .then(() => {
        toaster?.showSuccess({ title: 'Memory is on' });
      })
      .catch(() => {});
  };

  /** Drops a staged bank rather than leaving the row behind as an ordinary connector. */
  const handleDiscardStaged = () => {
    if (stagedBank === null || !canDelete) return;
    const confirmed = window.confirm(
      `Discard ${stagedBank.name}? It is saved but memory is not using it, and its connection details are deleted from Aman.`,
    );
    if (!confirmed) return;
    void runMutation(async () => {
      await connectorCatalog.deleteConnector?.({ id: stagedBank.id });
      setStagedBank(null);
    }).catch(() => {});
  };

  const handleCheck = () => {
    if (memoryProviderChecker === undefined || provider === null) return;
    setCheckInFlight(true);
    setCheckStatus(null);
    void memoryProviderChecker({ id: provider.id })
      .then(result => {
        setCheckStatus({
          ok: result.ok,
          message: result.ok ? 'Recall reached this bank. Memory is working.' : result.reason,
        });
      })
      .catch((err: unknown) => {
        setCheckStatus({ ok: false, message: getErrorMessage(err, 'Memory check failed') });
      })
      .finally(() => {
        setCheckInFlight(false);
      });
  };

  /**
   * Removes the row outright, which is how memory is turned off. This section is the only place
   * the row can be reached now that it is not in the connectors list, so it has to be possible
   * here or the row would be stranded.
   */
  const handleDelete = () => {
    if (provider === null || !canDelete) return;
    const confirmed = window.confirm(
      `Remove ${provider.name} entirely? Memory turns off and its connection details are deleted from Aman. Memories already stored in the bank itself are not touched.`,
    );
    if (!confirmed) return;
    setCheckStatus(null);
    void runMutation(async () => {
      await connectorCatalog.deleteConnector?.({ id: provider.id });
    })
      .then(() => {
        toaster?.showSuccess({ title: `${provider.name} removed` });
      })
      .catch(() => {});
  };

  const active = provider !== null;
  /** The saved-but-not-yet-authorized bank, when there is one and no bank is live yet. */
  const staged = active ? null : stagedBank;
  const bankName = provider?.name ?? staged?.name ?? 'No memory bank configured';
  const bankUrl = provider?.url ?? staged?.url ?? 'Aman remembers nothing between chats until you connect one.';
  /**
   * What the switch shows as on/off: this bank's own `screen_enabled` when it set one, else the
   * server's already-defaulted effective state, so the switch never disagrees with what is
   * actually happening on recall.
   */
  const screenSetting = provider === null ? undefined : readMemorySettings(provider)?.screen_enabled;
  const screenChecked = screenSetting ?? memoryScreen?.enabled ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pb-1">
      <header>
        <h3 className="text-base font-semibold text-text-primary">Memory</h3>
        <p className="mt-1 text-sm text-text-secondary">
          Point Aman at a long-term memory bank. It then recalls what is relevant before every reply and saves every
          finished exchange on its own.
        </p>
      </header>

      {error ? (
        <p className="rounded-xl border border-border bg-secondary-bg/30 p-3 text-sm text-failure-bg" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="py-8 text-center text-sm text-text-secondary">Loading…</p>
      ) : (
        <section aria-labelledby="memory-status-heading" className="rounded-xl border border-border bg-card-bg p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border border-border bg-secondary-bg/40 px-2 py-0.5 text-xs font-medium',
                    active ? 'text-success-bg' : 'text-text-primary',
                  )}
                >
                  <span className={cn('h-1.5 w-1.5 rounded-full', active ? 'bg-success-bg' : 'bg-primary-button-bg')} />
                  {active ? 'Memory is on' : 'Memory is off'}
                </span>
              </div>
              <h4 id="memory-status-heading" className="mt-2 truncate text-sm font-medium text-text-primary">
                {bankName}
              </h4>
              <p className="mt-0.5 break-all text-sm text-text-secondary">{bankUrl}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {active && memoryProviderChecker !== undefined ? (
                <Button
                  variant="secondary"
                  size="small"
                  type="button"
                  disabled={busy || checkInFlight}
                  onClick={handleCheck}
                >
                  Test connection
                </Button>
              ) : null}
              {staged !== null ? (
                <>
                  <Button
                    variant={staged.authenticated ? 'ghost' : 'primary'}
                    size="small"
                    type="button"
                    disabled={busy || isOAuthLoading || staged.authenticated}
                    onClick={handleAuthorizeStaged}
                  >
                    {staged.authenticated ? 'Signed in' : 'Sign in'}
                  </Button>
                  <Button
                    variant={staged.authenticated ? 'primary' : 'ghost'}
                    size="small"
                    type="button"
                    disabled={busy || !staged.authenticated}
                    onClick={handleEnableStaged}
                  >
                    Turn memory on
                  </Button>
                  {canDelete ? (
                    <Button
                      variant="ghost"
                      size="small"
                      type="button"
                      disabled={busy}
                      aria-label={`Discard the ${staged.name} memory bank`}
                      onClick={handleDiscardStaged}
                    >
                      Discard
                    </Button>
                  ) : null}
                </>
              ) : (
                <Button
                  variant={active ? 'ghost' : 'primary'}
                  size="small"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setFormError(null);
                    setEditorOpen(true);
                  }}
                >
                  {active ? (
                    <>
                      <Icon name="wrench" className="size-3" />
                      Edit
                    </>
                  ) : (
                    'Connect a memory bank'
                  )}
                </Button>
              )}
              {active && canDelete ? (
                <Button
                  variant="ghost"
                  size="small"
                  type="button"
                  disabled={busy}
                  aria-label={`Remove the ${provider.name} memory bank`}
                  onClick={handleDelete}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </div>

          {staged !== null ? (
            <p className="mt-3 text-xs text-text-secondary">
              {staged.name} is saved, but memory is not using it yet. Sign in to the bank, then turn memory on: Aman
              checks it can actually recall from the bank before it starts, and that check needs the sign-in first.
            </p>
          ) : null}

          {active && !canDelete ? (
            <p className="mt-3 text-xs text-text-secondary">
              Memory is turned off by removing the bank, and this host does not support removing one.
            </p>
          ) : null}

          {checkStatus ? (
            <p className={cn('mt-3 text-xs', checkStatus.ok ? 'text-success-bg' : 'text-failure-bg')} role="status">
              {checkStatus.message}
            </p>
          ) : null}

          {active ? (
            <MemoryScreenToggle
              status={memoryScreen}
              checked={screenChecked}
              busy={busy}
              onToggle={handleToggleScreen}
            />
          ) : null}

          {active ? (
            <MemoryTuningForm
              draft={tuning}
              busy={busy}
              error={tuningError}
              defaults={memoryDefaults}
              onChange={next => {
                setTuning(next);
                setTuningError(null);
              }}
              onSave={handleSaveTuning}
            />
          ) : null}
        </section>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <ScreenStatusCard
          headingId="memory-screen-heading"
          title="Recall screen"
          description="Classifies what memory recall is about to inject into the model's context, before it reaches the model — so a note the host retained on its own cannot hijack an unrelated chat."
          status={memoryScreen}
          enabledText="Recall screening is on"
          disabledText="Recall screening is off"
          unavailableText="Recall screening status unavailable"
          envNames={['MEMORY_SCREEN_URL', 'MEMORY_SCREEN_AUTH_TOKEN', 'MEMORY_SCREEN_THRESHOLD']}
          extraNote="On/off is the switch above (defaulting to MEMORY_SCREEN_ENABLED when the bank has not set it), but it also needs the classifier sidecar deployed and reachable at MEMORY_SCREEN_URL. Set MEMORY_SCREEN_AUTH_TOKEN when the sidecar requires bearer auth."
        />

        <ScreenStatusCard
          headingId="tool-output-screen-heading"
          title="Live tool-output screen"
          description="Classifies open-world tool results before they are handed back to the model in the same turn. Suspicious output stays visible in the audit trail but is withheld from model context."
          status={toolOutputScreen}
          enabledText="Tool-output screening is on"
          disabledText="Tool-output screening is off"
          unavailableText="Tool-output screening status unavailable"
          envNames={[
            'TOOL_OUTPUT_SCREEN_ENABLED',
            'TOOL_OUTPUT_SCREEN_TIMEOUT_MS',
            'MEMORY_SCREEN_URL',
            'MEMORY_SCREEN_AUTH_TOKEN',
          ]}
          extraNote="It reuses MEMORY_SCREEN_THRESHOLD and MEMORY_SCREEN_AUTH_TOKEN from the recall screen configuration."
        />
      </div>

      <section
        aria-labelledby="memory-notes-heading"
        className="rounded-xl border border-border bg-secondary-bg/30 p-3"
      >
        <h5 id="memory-notes-heading" className="text-sm font-medium text-text-primary">
          How memory works
        </h5>
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-text-secondary">
          {MEMORY_PROVIDER_NOTES.map(note => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>

      <AddMcpServerForm
        open={editorOpen}
        onOpenChange={setEditorOpen}
        onSubmit={handleSave}
        busy={busy}
        error={formError}
        title={active ? 'Edit memory bank' : 'Connect a memory bank'}
        description="Aman recalls from and saves to this bank on its own. The URL must name exactly one bank, ending in /mcp/<bank>."
        submitLabel={active ? 'Save' : 'Connect'}
        initialDraft={editorDraft}
        lockName={active}
        placeholders={MEMORY_FIELD_PLACEHOLDERS}
      />
    </div>
  );
};

export default MemorySettings;
