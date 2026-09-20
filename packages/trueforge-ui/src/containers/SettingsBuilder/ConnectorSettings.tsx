'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useTrueFoundryAgentSpec, useTrueFoundryUpdateAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { cn } from '@/atoms/lib/cn.js';
import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CatalogLogo } from '@/atoms/primitives/CatalogLogo.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import SearchInput from '@/atoms/primitives/SearchInput.js';
import { Icon } from '@/icons/Icon.js';
import { hasConnectorConnectionTest, type ConnectorConnectionFailureKind } from '@/server/connectorChecks.js';
import { useCatalogServer } from '@/server/ServerContext.js';
import { shellIsMutable, useShellMode } from '@/server/ShellModeContext.js';
import type { AgentSpec, ConnectorAuth, ConnectorBase, ConnectorCatalogEntry } from '@/server/types.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';
import { useToasterOptional } from '../ToasterContainer.js';
import AddMcpServerForm, { type AddMcpServerDraft } from './AddMcpServerForm.js';
import { AUTH_TYPE_LABELS } from './authTypeLabels.js';
import ConnectorDetails from './ConnectorDetails.js';
import { isMemoryProvider, memoryProviderUpdateRequest, withRemediation } from './memoryProvider.js';

type ConnectorListItem =
  { connector: ConnectorBase; isConfigured: true } | { connector: ConnectorCatalogEntry; isConfigured: false };

/** Inline result of one connection test against a single connector's MCP endpoint. */
type ConnectorCheckStatus = { ok: boolean; message: string };

/**
 * What a connection test found. The tool count is the signal that the endpoint really answered
 * and had something to offer; the tools themselves are listed on the connector's own page.
 */
function connectionTestSuccessMessage(toolCount: number): string {
  if (toolCount === 0) {
    return 'Connected, but this connector exposes no tools.';
  }
  return `Connected. ${String(toolCount)} ${toolCount === 1 ? 'tool' : 'tools'} available.`;
}

/**
 * Always what the endpoint said, never a generic failure line. A rejected credential and an
 * endpoint that cannot be reached are fixed in different places, so each carries its own next step.
 */
function connectionTestFailureMessage(result: { kind: ConnectorConnectionFailureKind; message: string }): string {
  if (result.kind === 'auth_required') {
    return withRemediation({ message: result.message, remediation: 'Reconnect it or replace its key.' });
  }
  if (result.kind === 'unreachable') {
    return withRemediation({
      message: result.message,
      remediation: 'Check the URL and that the endpoint is reachable.',
    });
  }
  return result.message;
}

type ConnectorsState = {
  ordered: ConnectorListItem[];
  authStatusById: Map<string, boolean>;
};

function mountMatchesConnector({ mount, connector }: { mount: object; connector: ConnectorBase }): boolean {
  const id = Reflect.get(mount, 'id');
  const name = Reflect.get(mount, 'name');
  return id === connector.id || name === connector.name;
}

function isConnectorEnabled({
  spec,
  connector,
}: {
  spec: AgentSpec | null | undefined;
  connector: ConnectorBase;
}): boolean {
  return spec?.mcpServers?.some(mount => mountMatchesConnector({ mount, connector })) ?? false;
}

function withConnectorEnabled({
  spec,
  connector,
  enabled,
}: {
  spec: AgentSpec;
  connector: ConnectorBase;
  enabled: boolean;
}): AgentSpec {
  const current = spec.mcpServers ?? [];
  const exists = current.some(mount => mountMatchesConnector({ mount, connector }));
  const mcpServers = enabled
    ? exists
      ? current
      : [...current, { id: connector.id, name: connector.name }]
    : current.filter(mount => !mountMatchesConnector({ mount, connector }));

  return mcpServers === current ? spec : { ...spec, mcpServers };
}

const ConnectorSettings = () => {
  const { connectorCatalog } = useCatalogServer();
  const { agentSpec } = useTrueFoundryAgentSpec();
  const updateAgentSpec = useTrueFoundryUpdateAgentSpec();
  const { mode, pendingSessionId } = useShellMode();
  const isThreadRunning = useThreadIsRunning();
  const toaster = useToasterOptional();

  const [query, setQuery] = useState('');
  const [connectors, setConnectors] = useState<ConnectorsState>({
    ordered: [],
    authStatusById: new Map(),
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Keyed by connector id so a result always lands on (and stays on) the connector it belongs to,
  // and testing one connector never clobbers, or gets clobbered by, another's last-known result.
  const [checkStatusById, setCheckStatusById] = useState<Map<string, ConnectorCheckStatus>>(new Map());
  // A set, not a single id: one in-flight test must never read as "nothing in flight" for a
  // different connector, or its button re-enables early and a second test can be fired for it
  // while the first is still outstanding.
  const [checkInFlightIds, setCheckInFlightIds] = useState<ReadonlySet<string>>(new Set());
  // Bumped every time a connector's test result would go stale for a reason other than a newer
  // test result arriving: the credential changing (key replace, disconnect, OAuth reconnect) or
  // the connector being deleted outright. A response is only applied if its generation still
  // matches when it resolves, so a test that was in flight when one of those happened can never
  // write a result for the credentials (or connector) it was actually run against.
  const checkGenerationById = useRef<Map<string, number>>(new Map());

  const [catalog, setCatalog] = useState<ConnectorCatalogEntry[]>([]);
  const [addMcpServerFormOpen, setAddMcpServerFormOpen] = useState(false);
  const [editingConnector, setEditingConnector] = useState<ConnectorBase | null>(null);
  const [connectorAwaitingKey, setConnectorAwaitingKey] = useState<ConnectorCatalogEntry | null>(null);
  const [selectedConnector, setSelectedConnector] = useState<ConnectorBase | null>(null);
  const [apiKey, setApiKey] = useState('');
  // A native window.confirm() blocks the JS event loop until dismissed, which reads as a frozen
  // tab; an in-app dialog keeps the renderer responsive the whole time.
  const [connectorPendingDelete, setConnectorPendingDelete] = useState<ConnectorBase | null>(null);

  const connectorIconMap = useMemo(() => {
    return (catalog ?? []).reduce(
      (acc, entry) => {
        acc[entry.name] = entry.logo ?? '';
        return acc;
      },
      {} as Record<string, string>,
    );
  }, [catalog]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listed, available] = await Promise.all([
        connectorCatalog.listConnectors(),
        connectorCatalog.getConnectorCatalog(),
      ]);
      setCatalog(available);
      const configured = listed ?? [];
      const seenIds = new Set(configured.map(connector => connector.id));
      const ordered: ConnectorListItem[] = [
        ...configured.map<ConnectorListItem>(connector => ({ connector, isConfigured: true })),
        ...available
          .filter(connector => !seenIds.has(connector.id))
          .map<ConnectorListItem>(connector => ({ connector, isConfigured: false })),
      ];
      setConnectors({
        ordered,
        authStatusById: new Map(
          ordered.map(item => [item.connector.id, item.isConfigured ? item.connector.authenticated : false]),
        ),
      });
      setSelectedConnector(current => (current ? (listed.find(item => item.id === current.id) ?? null) : null));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load connectors'));
    } finally {
      setLoading(false);
    }
  }, [connectorCatalog]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const normalizedQuery = query.trim().toLowerCase();

  const matchingConnectors = useMemo(() => {
    if (!normalizedQuery) return connectors.ordered;
    return connectors.ordered.filter(({ connector }) => {
      return (
        connector.name.toLowerCase().includes(normalizedQuery) ||
        (connector.description?.toLowerCase().includes(normalizedQuery) ?? false) ||
        connector.url.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [connectors.ordered, normalizedQuery]);

  const matchingConnected = useMemo(() => {
    const result: ConnectorBase[] = [];
    for (const item of matchingConnectors) {
      // The memory bank is stored as an MCP server row but is not a connector a user acts on:
      // it is never offered in a chat, the model never chooses to call it, and Settings → Memory
      // owns its whole lifecycle. Listing it here too would invite treating it as a connector.
      if (item.isConfigured && !isMemoryProvider(item.connector)) {
        const authenticated = connectors.authStatusById.get(item.connector.id) ?? item.connector.authenticated;
        result.push(
          authenticated === item.connector.authenticated ? item.connector : { ...item.connector, authenticated },
        );
      }
    }
    return result;
  }, [connectors.authStatusById, matchingConnectors]);

  const availableConnectors = useMemo(() => {
    const result: ConnectorCatalogEntry[] = [];
    for (const item of matchingConnectors) {
      if (!item.isConfigured) result.push(item.connector);
    }
    return result;
  }, [matchingConnectors]);

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

  const closeApiKeyModal = () => {
    setConnectorAwaitingKey(null);
    setApiKey('');
    setFormError(null);
  };

  // Clears a stale test result and, by bumping the generation, any result a still-in-flight test
  // for this id would otherwise deliver afterward. Call this on every event that makes the last
  // test result speak to credentials (or a connector row) that no longer exist: a key replacement,
  // a disconnect, an OAuth reconnect, or a delete.
  const invalidateConnectionCheck = useCallback((id: string) => {
    checkGenerationById.current.set(id, (checkGenerationById.current.get(id) ?? 0) + 1);
    setCheckStatusById(current => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

  const createFromCatalog = async (entry: ConnectorCatalogEntry, authOverride?: ConnectorAuth) => {
    const auth: ConnectorAuth =
      authOverride ??
      (entry.auth.type === 'header'
        ? {
            type: 'header',
            ...(entry.auth.headerName ? { headerName: entry.auth.headerName } : {}),
          }
        : entry.auth.type === 'dcr'
          ? { type: 'dcr' }
          : { type: 'none' });
    await connectorCatalog.createConnector({
      name: entry.name,
      description: entry.description ?? entry.url,
      url: entry.url,
      auth,
    });
  };

  const handleConnect = (entry: ConnectorCatalogEntry) => {
    if (entry.auth.type === 'header') {
      setApiKey('');
      setFormError(null);
      setConnectorAwaitingKey(entry);
      return;
    }

    void runMutation(async () => {
      await createFromCatalog(entry);
    }).catch(() => {});
  };

  const handleApiKeySubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!connectorAwaitingKey || !apiKey.trim()) return;

    const entry = connectorAwaitingKey;
    setFormError(null);
    void runMutation(async () => {
      const auth: ConnectorAuth = {
        type: 'header',
        apiKey: apiKey.trim(),
        ...(entry.auth.type === 'header' && entry.auth.headerName ? { headerName: entry.auth.headerName } : {}),
      };
      const existing = connectors.ordered.find(({ connector }) => connector.id === entry.id);
      const existingConnector = existing?.isConfigured ? existing.connector : undefined;
      if (existingConnector) {
        // updateConnector sends the full manifest, so the memory-provider flag has to be
        // resupplied here too or it would be silently cleared by this unrelated key change.
        await connectorCatalog.updateConnector(
          memoryProviderUpdateRequest({ ...existingConnector, auth }, isMemoryProvider(existingConnector)),
        );
        // The credential just changed, so any earlier connection test no longer speaks to what
        // is stored now; go back to unverified until it is tested again.
        invalidateConnectionCheck(entry.id);
      } else {
        await createFromCatalog(entry, auth);
      }
      closeApiKeyModal();
      setTimeout(() => {
        toaster?.showSuccess({
          title: `${entry.name} ${existingConnector ? 'updated' : 'connected'}`,
        });
      }, 100);
    }, setFormError).catch(() => {});
  };

  const handleAddMcpServer = async (draft: AddMcpServerDraft) => {
    setFormError(null);
    await runMutation(async () => {
      await connectorCatalog.createConnector({ ...draft });
    }, setFormError);
    setTimeout(() => {
      toaster?.showSuccess({ title: `${draft.name} added` });
    }, 0);
  };

  const handleEditMcpServer = async (draft: AddMcpServerDraft) => {
    const connector = editingConnector;
    if (!connector) return;
    setFormError(null);
    await runMutation(async () => {
      const updated = await connectorCatalog.updateConnector({ id: connector.id, ...draft });
      setSelectedConnector(current => (current?.id === updated.id ? updated : current));
    }, setFormError);
    setTimeout(() => {
      toaster?.showSuccess({ title: `${draft.name} updated` });
    }, 0);
  };

  const handleDisconnect = (connector: ConnectorBase) => {
    void runMutation(async () => {
      await connectorCatalog.disconnectConnector({ id: connector.id });
      setSelectedConnector(null);
      // Credentials just went away; a "Connected" from before this must not keep showing for a
      // connector that now needs authentication again.
      invalidateConnectionCheck(connector.id);
    }).catch(() => {});
  };

  const handleDeleteConnector = (connector: ConnectorBase) => {
    setConnectorPendingDelete(connector);
  };

  const cancelDeleteConnector = () => {
    setConnectorPendingDelete(null);
  };

  const confirmDeleteConnector = () => {
    const connector = connectorPendingDelete;
    if (!connector) return;
    setConnectorPendingDelete(null);
    void runMutation(async () => {
      // Drop it from the current chat's spec first so the spec never points at
      // a connector that no longer exists.
      if (canUpdateChat && agentSpec != null && updateAgentSpec != null) {
        const nextSpec = withConnectorEnabled({ spec: agentSpec, connector, enabled: false });
        if (nextSpec !== agentSpec) {
          updateAgentSpec({ mcpServers: nextSpec.mcpServers });
        }
      }
      await connectorCatalog.deleteConnector?.({ id: connector.id });
      setSelectedConnector(current => (current?.id === connector.id ? null : current));
      // A stale test result for a now-deleted row would otherwise carry over verbatim if a
      // connector with the same id is ever added again — and bumping the generation here also
      // discards a test for this id that was still in flight when the delete landed, so its
      // result can never write itself back in afterward.
      invalidateConnectionCheck(connector.id);
    })
      .then(() => {
        toaster?.showSuccess({ title: `${connector.name} deleted` });
      })
      .catch(() => {});
  };

  const handleConnectorRefreshed = (refreshedConnector: ConnectorBase) => {
    setSelectedConnector(current => (current?.id === refreshedConnector.id ? refreshedConnector : current));
    setConnectors(current => {
      const authStatusById = new Map(current.authStatusById);
      authStatusById.set(refreshedConnector.id, refreshedConnector.authenticated);

      return {
        ordered: current.ordered.map(item =>
          item.isConfigured && item.connector.id === refreshedConnector.id
            ? { connector: refreshedConnector, isConfigured: true }
            : item,
        ),
        authStatusById,
      };
    });
    // This only fires after a fresh OAuth authorization landed; whatever a connection test found
    // before that no longer speaks to the credentials now in effect.
    invalidateConnectionCheck(refreshedConnector.id);
  };

  // The runtime's connector port does not declare the connection test; the Harness adapter adds
  // it. Read for it rather than editing `@truefoundry/assistant-ui-runtime`: another host's
  // catalog may carry none, and the control is hidden when the check is absent. The memory check
  // lives in Settings → Memory, which owns the bank.
  const connectionTester = hasConnectorConnectionTest(connectorCatalog)
    ? (req: { id: string }) => connectorCatalog.testConnector(req)
    : undefined;

  const canUpdateChat = shellIsMutable(mode) && agentSpec != null && updateAgentSpec != null;
  const isPlainDraft = mode.status === 'active' && mode.isMutable && mode.agentId == null && pendingSessionId == null;

  const handleChatEnabledChange = (connector: ConnectorBase, enabled: boolean) => {
    if (!canUpdateChat || agentSpec == null || updateAgentSpec == null) return;
    const nextSpec = withConnectorEnabled({ spec: agentSpec, connector, enabled });
    if (nextSpec === agentSpec) return;
    updateAgentSpec({ mcpServers: nextSpec.mcpServers });
  };

  const handleConnectionTest = (connector: ConnectorBase) => {
    if (connectionTester === undefined || checkInFlightIds.has(connector.id)) {
      return;
    }
    // Captured now, checked when the response lands: if invalidateConnectionCheck bumped this
    // id's generation in between (a delete, disconnect, reconnect, or key replace), the
    // generation this request started with is no longer current and its result is dropped —
    // never written into the map, no matter how long after the fact it arrives.
    const generation = (checkGenerationById.current.get(connector.id) ?? 0) + 1;
    checkGenerationById.current.set(connector.id, generation);
    setCheckInFlightIds(current => new Set(current).add(connector.id));
    const isCurrent = () => checkGenerationById.current.get(connector.id) === generation;
    void connectionTester({ id: connector.id })
      .then(result => {
        if (!isCurrent()) return;
        setCheckStatusById(current => {
          const next = new Map(current);
          next.set(connector.id, {
            ok: result.ok,
            message: result.ok
              ? connectionTestSuccessMessage(result.toolNames.length)
              : connectionTestFailureMessage(result),
          });
          return next;
        });
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return;
        setCheckStatusById(current => {
          const next = new Map(current);
          next.set(connector.id, { ok: false, message: getErrorMessage(err, 'The connection test failed') });
          return next;
        });
      })
      .finally(() => {
        setCheckInFlightIds(current => {
          if (!current.has(connector.id)) return current;
          const next = new Set(current);
          next.delete(connector.id);
          return next;
        });
      });
  };

  const renderConnector = (connector: ConnectorBase, isConnected: boolean) => {
    const logoSrc = connectorIconMap[connector.name];
    const enabledForChat = isConnectorEnabled({ spec: agentSpec, connector });
    const connectorCheckStatus = checkStatusById.get(connector.id) ?? null;
    // Nothing has dialed this connector's endpoint yet: `authenticated` only means "has valid
    // credentials" (or "no credentials needed"), which the server computes without ever reaching
    // the endpoint — so it is not by itself evidence of reachability. Where a connection
    // test is available, the badge shows what the last test actually found instead. Where the host
    // offers no test at all, there is no way to verify reachability, so fall back to the
    // credential-based signal rather than showing "unverified" forever with no way to clear it.
    const canVerifyReachability = connectionTester !== undefined;
    const isVerifiedConnected = canVerifyReachability ? connectorCheckStatus?.ok === true : connector.authenticated;
    const isVerifiedFailed = canVerifyReachability && connectorCheckStatus?.ok === false;
    const needsAuthentication = connector.requiresAuth && !connector.authenticated;
    const chatToggleDisabled = !canUpdateChat || needsAuthentication || isThreadRunning;
    const chatToggleTitle = needsAuthentication
      ? 'Connect this connector to use it in this chat.'
      : !canUpdateChat
        ? 'Open an editable chat to add or remove connectors.'
        : isThreadRunning
          ? 'Wait for the current turn to finish before changing connectors in this chat.'
          : undefined;
    const content = (
      <>
        <span
          className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-secondary-bg"
          aria-hidden
        >
          {logoSrc ? (
            <CatalogLogo src={logoSrc} alt={connector.name} className="size-4.5" />
          ) : (
            <Icon name="mcp-server" className="size-4.5 text-text-primary" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <h5 className="truncate text-sm font-medium text-text-primary">{connector.name}</h5>
          <p className="mt-0.5 line-clamp-2 text-sm text-text-secondary sm:truncate">{connector.description}</p>
        </div>
      </>
    );

    const rowClassName = 'flex min-h-16 w-full items-center gap-3 border-b border-border p-3 text-left last:border-b-0';

    if (isConnected) {
      return (
        <article
          key={connector.id}
          className="flex min-h-16 w-full flex-col gap-3 border-b border-border p-3 last:border-b-0 sm:flex-row sm:items-center cursor-pointer transition-colors hover:bg-ghost-button-hover/60"
          onClick={() => {
            setSelectedConnector(connector);
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">{content}</div>

          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-full border border-border bg-secondary-bg/40 px-2 py-0.5 text-xs font-medium',
                isVerifiedConnected ? 'text-success-bg' : isVerifiedFailed ? 'text-failure-bg' : 'text-text-primary',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  isVerifiedConnected ? 'bg-success-bg' : isVerifiedFailed ? 'bg-failure-bg' : 'bg-primary-button-bg',
                )}
              ></span>
              {isVerifiedConnected
                ? 'Connected'
                : isVerifiedFailed
                  ? 'Connection failed'
                  : connector.authenticated
                    ? 'Unverified'
                    : 'Added'}
            </span>
            {connectionTester !== undefined ? (
              <Button
                variant="ghost"
                size="small"
                type="button"
                disabled={busy || checkInFlightIds.has(connector.id)}
                aria-label={`Test the connection for ${connector.name}`}
                onClick={event => {
                  event.stopPropagation();
                  handleConnectionTest(connector);
                }}
              >
                Test connection
              </Button>
            ) : null}
            <div
              className="flex items-center gap-2"
              title={chatToggleTitle}
              onClick={event => {
                event.stopPropagation();
              }}
            >
              {enabledForChat ? (
                <>
                  <span className="text-xs font-medium text-text-secondary">In chat</span>
                  <Button
                    variant="ghost"
                    size="small"
                    type="button"
                    disabled={chatToggleDisabled}
                    aria-label={`Remove ${connector.name} from this chat`}
                    onClick={() => {
                      handleChatEnabledChange(connector, false);
                    }}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  size="small"
                  type="button"
                  disabled={chatToggleDisabled}
                  aria-label={`Add ${connector.name} to this chat`}
                  onClick={() => {
                    handleChatEnabledChange(connector, true);
                  }}
                >
                  Add to chat
                </Button>
              )}
            </div>
            {connectorCheckStatus ? (
              <p
                className={cn(
                  'w-full text-xs sm:text-right',
                  connectorCheckStatus.ok ? 'text-success-bg' : 'text-failure-bg',
                )}
                role="status"
              >
                {connectorCheckStatus.message}
              </p>
            ) : null}
            <Button
              variant="secondary"
              size="small"
              type="button"
              disabled={busy}
              onClick={event => {
                event.stopPropagation();
                setFormError(null);
                setEditingConnector(connector);
              }}
            >
              <Icon name="pencil" className="size-3" />
              Edit
            </Button>
            {connectorCatalog.deleteConnector != null ? (
              <Button
                variant="ghost"
                size="small"
                type="button"
                disabled={busy}
                aria-label={`Delete the ${connector.name} connector`}
                onClick={event => {
                  event.stopPropagation();
                  handleDeleteConnector(connector);
                }}
              >
                Delete
              </Button>
            ) : null}
            <Icon name="chevron-right" className="size-4" />
          </div>
        </article>
      );
    }

    return (
      <article key={connector.id} className={rowClassName}>
        {content}
      </article>
    );
  };

  const renderCatalogEntry = (entry: ConnectorCatalogEntry) => {
    const logoSrc = connectorIconMap[entry.name];
    return (
      <article
        key={entry.id}
        className="flex min-h-16 w-full items-center gap-3 border-b border-border p-3 text-left last:border-b-0"
      >
        <span
          className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-secondary-bg"
          aria-hidden
        >
          {logoSrc ? (
            <CatalogLogo src={logoSrc} alt={entry.name} className="size-4.5" />
          ) : (
            <Icon name="mcp-server" className="size-4.5 text-text-primary" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <h5 className="truncate text-sm font-medium text-text-primary">{entry.name}</h5>
          <p className="mt-0.5 line-clamp-2 text-sm text-text-secondary sm:truncate">
            {entry.description ?? entry.url}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-xs text-text-secondary sm:inline">
            {AUTH_TYPE_LABELS[entry.auth.type] ?? AUTH_TYPE_LABELS.none}
          </span>
          <Button
            variant="secondary"
            size="small"
            type="button"
            disabled={busy}
            onClick={() => {
              handleConnect(entry);
            }}
          >
            {entry.auth.type === 'dcr' ? 'Add' : 'Connect'}
          </Button>
        </div>
      </article>
    );
  };

  const isReplacingKey = useMemo(() => {
    return (
      connectorAwaitingKey !== null &&
      connectors.ordered.some(
        (item: ConnectorListItem) => item.isConfigured && item.connector.id === connectorAwaitingKey.id,
      )
    );
  }, [connectorAwaitingKey, connectors.ordered]);

  if (selectedConnector) {
    return (
      <>
        <ConnectorDetails
          connector={selectedConnector}
          busy={busy}
          onBack={() => {
            setSelectedConnector(null);
          }}
          onConnectorRefreshed={handleConnectorRefreshed}
          onEdit={() => {
            setFormError(null);
            setEditingConnector(selectedConnector);
          }}
          onDisconnect={() => {
            handleDisconnect(selectedConnector);
          }}
        />
        <AddMcpServerForm
          open={editingConnector !== null}
          onOpenChange={open => {
            if (!open) {
              setEditingConnector(null);
              setFormError(null);
            }
          }}
          connector={editingConnector ?? undefined}
          onSubmit={handleEditMcpServer}
          busy={busy}
          error={formError}
        />
      </>
    );
  }

  const hasMatches = matchingConnected.length > 0 || availableConnectors.length > 0;

  return (
    <>
      <h3 className="text-xl font-semibold tracking-tight text-text-primary">Connectors</h3>
      <p className="mt-1 text-sm text-text-secondary">
        Connected tools are ready to use. Add one to the current chat when you want Aman to use it. Test connection
        dials a connector and reports the tools it answered with.
      </p>
      {isPlainDraft ? (
        <p className="mt-1 text-xs text-text-secondary">
          Selections in a new draft are remembered for future new chats.
        </p>
      ) : null}

      {!loading && matchingConnected.length === 0 ? (
        <section
          aria-label="Getting started with connectors"
          className="mt-4 rounded-xl border border-border bg-card-bg px-4 py-3"
        >
          <h4 className="text-sm font-semibold text-text-primary">Get connected in three steps</h4>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-text-secondary">
            <li>
              Find a connector in <span className="font-medium text-text-primary">Available</span> below and choose
              Connect — most need an API key or token from that service.
            </li>
            <li>Add it to the current chat from the connector row so Aman can use its tools.</li>
            <li>
              Use <span className="font-medium text-text-primary">Test connection</span> to dial the connector and see
              which tools answered.
            </li>
          </ol>
        </section>
      ) : null}

      {error ? (
        <p className="mt-3 rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex-1 overflow-y-hidden">
        <div className="flex h-full flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex-1">
              <SearchInput query={query} setQuery={setQuery} placeholder="Search connectors" />
            </div>
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setFormError(null);
                setAddMcpServerFormOpen(true);
              }}
            >
              <Icon name="plus" size="1rem" className="mr-1" />
              Add MCP Server
            </Button>
          </div>

          <div className="flex flex-1 flex-col gap-5 overflow-y-auto pb-1">
            {loading ? <p className="py-8 text-center text-sm text-text-secondary">Loading…</p> : null}

            {!loading && matchingConnected.length > 0 ? (
              <section aria-labelledby="connected-connectors-heading">
                <h4
                  id="connected-connectors-heading"
                  className="mb-2 text-[0.8125rem] font-semibold uppercase text-text-secondary"
                >
                  Configured · {matchingConnected.length}
                </h4>
                <div className="overflow-hidden rounded-xl border border-border bg-card-bg">
                  {matchingConnected.map(connector => renderConnector(connector, true))}
                </div>
              </section>
            ) : null}

            {!loading && availableConnectors.length > 0 ? (
              <section aria-labelledby="available-connectors-heading">
                <h4
                  id="available-connectors-heading"
                  className="mb-2 text-[0.8125rem] font-semibold uppercase text-text-secondary"
                >
                  Available · {availableConnectors.length}
                </h4>
                <div className="overflow-hidden rounded-xl border border-border bg-card-bg">
                  {availableConnectors.map(entry => renderCatalogEntry(entry))}
                </div>
              </section>
            ) : null}

            {!loading && !hasMatches ? (
              <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">
                {query.trim() ? `No connectors match “${query.trim()}”.` : 'No connectors yet.'}
              </div>
            ) : null}
          </div>

          <CenteredModal
            open={connectorAwaitingKey !== null}
            onOpenChange={open => {
              if (!open) closeApiKeyModal();
            }}
            title={`${isReplacingKey ? 'Replace key for' : 'Connect'} ${connectorAwaitingKey?.name ?? 'connector'}`}
            description={connectorAwaitingKey?.url}
            contentSized
            className="md:max-w-xl"
          >
            <form onSubmit={handleApiKeySubmit}>
              <div className="space-y-5 px-5 py-5">
                <div className="flex items-center gap-3">
                  <span
                    className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-secondary-bg"
                    aria-hidden
                  >
                    <Icon name="mcp-server" className="size-6 text-text-primary" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">{connectorAwaitingKey?.name}</p>
                    <p className="truncate text-sm text-text-secondary">{connectorAwaitingKey?.description}</p>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="connector-api-key"
                    className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary"
                  >
                    API key / token
                  </label>
                  <input
                    id="connector-api-key"
                    type="password"
                    value={apiKey}
                    onChange={event => {
                      setApiKey(event.target.value);
                    }}
                    placeholder={`Paste the token from ${connectorAwaitingKey?.name ?? 'the provider'}`}
                    autoFocus
                    required
                    className={auiInputClass('h-11')}
                  />
                </div>
                {formError ? <p className="text-failure-bg text-sm">{formError}</p> : null}
              </div>

              <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
                <Button variant="ghost" type="button" onClick={closeApiKeyModal} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!apiKey.trim() || busy}>
                  {isReplacingKey ? 'Replace Key' : 'Connect'}
                </Button>
              </footer>
            </form>
          </CenteredModal>

          <AddMcpServerForm
            open={addMcpServerFormOpen || editingConnector !== null}
            onOpenChange={open => {
              if (!open) {
                setAddMcpServerFormOpen(false);
                setEditingConnector(null);
                setFormError(null);
              }
            }}
            connector={editingConnector ?? undefined}
            onSubmit={editingConnector ? handleEditMcpServer : handleAddMcpServer}
            busy={busy}
            error={formError}
          />

          <CenteredModal
            open={connectorPendingDelete !== null}
            onOpenChange={open => {
              if (!open) cancelDeleteConnector();
            }}
            title={`Delete ${connectorPendingDelete?.name ?? 'connector'}?`}
            contentSized
            className="md:max-w-md"
          >
            <div className="px-5 py-5">
              <p className="text-sm text-text-secondary">
                Chats that still reference it will show it as unavailable until it is removed from them.
              </p>
            </div>
            <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="ghost" type="button" onClick={cancelDeleteConnector} disabled={busy}>
                Cancel
              </Button>
              <Button variant="destructive" type="button" disabled={busy} onClick={confirmDeleteConnector}>
                Delete
              </Button>
            </footer>
          </CenteredModal>
        </div>
      </div>
    </>
  );
};

export default ConnectorSettings;
