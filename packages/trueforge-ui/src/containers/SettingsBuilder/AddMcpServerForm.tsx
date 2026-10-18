'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { auiInputClass } from '../../atoms/lib/inputClasses.js';
import { Button } from '../../atoms/primitives/Button.js';
import { CenteredModal } from '../../atoms/primitives/CenteredModal.js';
import { Icon } from '../../icons/Icon.js';
import type { ConnectorAuth, ConnectorAuthType, ConnectorBase } from '../../server/types.js';

export type McpAuthType = ConnectorAuthType;

export type AddMcpServerDraft = {
  name: string;
  url: string;
  description: string;
  auth: ConnectorAuth;
};

/**
 * Field hints, so a caller whose URL has a required shape can show it. The memory bank is the
 * case that needs this: its URL must end in `/mcp/<bank>`, and a generic connector example
 * without a bank segment reads as a valid pattern when it is not. Every field is named together,
 * so a caller cannot replace one example and leave the other two reading as connector defaults.
 */
export type AddMcpServerPlaceholders = {
  name: string;
  description: string;
  url: string;
};

type AddMcpServerFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: AddMcpServerDraft) => void | Promise<void>;
  /** Present when editing a saved connector row directly (Settings → Connectors). */
  connector?: ConnectorBase;
  busy?: boolean;
  error?: string | null;
  /** Modal chrome, so an editor for one specific server can say what it is editing. */
  title?: string | undefined;
  description?: string | undefined;
  submitLabel?: string | undefined;
  /**
   * Seeds the fields for an edit. The API key is deliberately never seeded: a stored value only
   * ever comes back redacted, and the write path already treats a blank key as "keep the stored
   * one" (resolveWriteAuth in the connector catalog adapter), so an untouched field preserves the
   * existing credential instead of overwriting it with a redacted stand-in.
   */
  initialDraft?: AddMcpServerDraft | undefined;
  /** Locks the name for an edit: renaming a saved server would create a second row, not rename it. */
  lockName?: boolean | undefined;
  placeholders?: AddMcpServerPlaceholders | undefined;
};

const AUTH_OPTIONS: Array<{ value: McpAuthType; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'header', label: 'API key' },
  { value: 'dcr', label: 'OAuth (automatic)' },
  { value: 'oauth_client', label: 'OAuth (manual)' },
];

const inputClassName = auiInputClass('h-11 shadow-sm');

const RequiredMark = () => (
  <span className="ml-0.5 text-failure-bg" aria-hidden>
    *
  </span>
);

/** Turns a saved connector row into the same draft shape `initialDraft` uses, so both seed paths share one reset. */
function draftFromConnector(connector: ConnectorBase): AddMcpServerDraft {
  return {
    name: connector.name,
    url: connector.url,
    description: connector.description,
    auth: connector.auth,
  };
}

const AddMcpServerForm = ({
  open,
  onOpenChange,
  onSubmit,
  connector,
  busy = false,
  error,
  title,
  description: modalDescription,
  submitLabel,
  initialDraft,
  lockName = false,
  placeholders,
}: AddMcpServerFormProps) => {
  // Editing covers both seed paths: a connector row opened for Edit, or an initialDraft handed in
  // by a caller (Settings → Memory) that manages its own edit/create distinction.
  const editing = connector !== undefined || initialDraft !== undefined;
  const nameLocked = lockName || connector !== undefined;
  const seedDraft = initialDraft ?? (connector ? draftFromConnector(connector) : undefined);
  // Whether the connector as it stood before this edit already used header auth: only then can
  // the API key field be left blank to keep the stored credential.
  const editingHeaderAuth = seedDraft?.auth.type === 'header';

  const [name, setName] = useState(seedDraft?.name ?? '');
  const [url, setUrl] = useState(seedDraft?.url ?? '');
  const [description, setDescription] = useState(seedDraft?.description ?? '');
  const [authType, setAuthType] = useState<McpAuthType>(
    seedDraft?.auth.type === 'oauth_client' ? 'oauth_client' : (seedDraft?.auth.type ?? 'dcr'),
  );
  const [apiKey, setApiKey] = useState('');
  const [headerName, setHeaderName] = useState(
    seedDraft?.auth.type === 'header' ? (seedDraft.auth.headerName ?? '') : '',
  );
  const [clientId, setClientId] = useState(
    seedDraft?.auth.type === 'oauth_client' ? (seedDraft.auth.clientId ?? '') : '',
  );
  const [clientSecret, setClientSecret] = useState('');
  const [scopes, setScopes] = useState(
    seedDraft?.auth.type === 'oauth_client' && seedDraft.auth.scopes ? seedDraft.auth.scopes.join('\n') : '',
  );
  const nameInputClassName = auiInputClass(
    `h-11 shadow-sm ${nameLocked ? 'cursor-not-allowed bg-secondary-bg/60 text-text-secondary opacity-40' : ''}`,
  );

  const resetForm = useCallback(() => {
    const seed = initialDraft ?? (connector ? draftFromConnector(connector) : undefined);
    setName(seed?.name ?? '');
    setUrl(seed?.url ?? '');
    setDescription(seed?.description ?? '');
    setAuthType(seed?.auth.type === 'oauth_client' ? 'oauth_client' : (seed?.auth.type ?? 'dcr'));
    // Never carries over, in either direction: a typed key must not survive a cancel, and an
    // edit starts blank so leaving it alone keeps the stored credential.
    setApiKey('');
    setHeaderName(seed?.auth.type === 'header' ? (seed.auth.headerName ?? '') : '');
    setClientId(seed?.auth.type === 'oauth_client' ? (seed.auth.clientId ?? '') : '');
    setClientSecret('');
    setScopes(seed?.auth.type === 'oauth_client' && seed.auth.scopes ? seed.auth.scopes.join('\n') : '');
  }, [initialDraft, connector]);

  // Re-seed when the modal opens, so an editor reflects the row as it stands now rather than as
  // it stood when this component first mounted.
  useEffect(() => {
    if (open) resetForm();
  }, [open, resetForm]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  };

  // An edit may leave the key blank only when the connector already used header auth, so
  // blank means "keep the stored one" rather than "no key at all" (see `editingHeaderAuth`);
  // switching a connector onto header auth from something else still requires a key.
  const isValid =
    !!name.trim() &&
    !!description.trim() &&
    !!url.trim() &&
    (authType !== 'header' || editingHeaderAuth || !!apiKey.trim()) &&
    (authType !== 'oauth_client' || (!!clientId.trim() && (editing || !!clientSecret.trim())));

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isValid || busy) return;

    // A blank key is omitted rather than sent empty, so the write path's "keep the stored
    // credential" branch is reached by intent instead of by an empty string falling through it.
    const auth: ConnectorAuth =
      authType === 'header'
        ? {
            type: 'header',
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            ...(headerName.trim() ? { headerName: headerName.trim() } : {}),
          }
        : authType === 'oauth_client'
          ? {
              type: 'oauth_client',
              clientId: clientId.trim(),
              ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
              ...(scopes.trim() ? { scopes: scopes.trim().split('\n').filter(Boolean) } : {}),
            }
          : { type: authType };

    try {
      await onSubmit({
        name: name.trim(),
        url: url.trim(),
        description: description.trim(),
        auth,
      });
      resetForm();
      onOpenChange(false);
    } catch {
      // Parent surfaces error; keep form open.
    }
  };

  const resolvedTitle = title ?? (editing ? 'Edit MCP server' : 'Add MCP server');
  const resolvedDescription =
    modalDescription ??
    (editing
      ? 'Update how this connector authenticates.'
      : 'Point at a remote MCP endpoint. It then behaves like any other connector.');

  return (
    <CenteredModal
      open={open}
      onOpenChange={handleOpenChange}
      title={resolvedTitle}
      description={resolvedDescription}
      contentSized
      headerIcon={
        <span
          className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary-bg text-text-primary"
          aria-hidden
        >
          <Icon name="mcp-server" className="size-6" />
        </span>
      }
    >
      <form className="flex flex-col overflow-y-auto p-5 md:p-6" onSubmit={e => void handleSubmit(e)}>
        <div className="space-y-4">
          <div>
            <label htmlFor="mcp-server-name" className="mb-1.5 block text-sm font-medium text-text-primary">
              Name
              <RequiredMark />
            </label>
            <input
              id="mcp-server-name"
              type="text"
              required
              disabled={nameLocked}
              value={name}
              readOnly={nameLocked}
              aria-disabled={nameLocked}
              onChange={event => {
                setName(event.target.value);
              }}
              placeholder={placeholders?.name ?? 'analytics-postgres-mcp'}
              autoFocus={!nameLocked}
              className={nameLocked ? nameInputClassName : inputClassName}
            />
          </div>

          <div>
            <label htmlFor="mcp-server-description" className="mb-1.5 block text-sm font-medium text-text-primary">
              Description
              <RequiredMark />
            </label>
            <textarea
              id="mcp-server-description"
              value={description}
              onChange={event => {
                setDescription(event.target.value);
              }}
              placeholder={placeholders?.description ?? 'Query analytics from Postgres'}
              required
              rows={3}
              className={auiInputClass('resize-y py-2.5 shadow-sm')}
            />
          </div>

          <div>
            <label htmlFor="mcp-server-url" className="mb-1.5 block text-sm font-medium text-text-primary">
              URL
              <RequiredMark />
            </label>
            <input
              id="mcp-server-url"
              type="url"
              required
              value={url}
              onChange={event => {
                setUrl(event.target.value);
              }}
              placeholder={placeholders?.url ?? 'https://mcp.example.com/mcp'}
              className={inputClassName}
            />
          </div>

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-text-primary">
              Auth type
              <RequiredMark />
            </legend>
            <div className="flex w-full flex-row rounded-md border border-border bg-secondary-bg/40 p-1">
              {AUTH_OPTIONS.map(option => (
                <label
                  key={option.value}
                  className={`flex h-8 flex-1 cursor-pointer items-center justify-center rounded-sm text-sm font-medium transition-colors ${
                    authType === option.value
                      ? 'bg-dropdown-selected-item-bg text-dropdown-selected-item-text shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <input
                    type="radio"
                    name="mcp-auth-type"
                    value={option.value}
                    checked={authType === option.value}
                    onChange={() => {
                      setAuthType(option.value);
                    }}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          {authType === 'dcr' ? (
            <div className="flex gap-1.5 bg-secondary-bg/40 p-2 rounded-md">
              <Icon name="info" className="size-3.5 mt-1 text-text-secondary" />
              <div className="text-xs text-text-secondary leading-5.5">
                Sign-in only, for servers that register apps automatically.
              </div>
            </div>
          ) : null}

          {authType === 'oauth_client' ? (
            <>
              <div>
                <label htmlFor="mcp-client-id" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Client ID
                  <RequiredMark />
                </label>
                <input
                  id="mcp-client-id"
                  type="text"
                  required
                  value={clientId}
                  onChange={event => {
                    setClientId(event.target.value);
                  }}
                  placeholder="Client ID from the service"
                  className={inputClassName}
                />
              </div>

              <div>
                <label htmlFor="mcp-client-secret" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Client Secret
                  {editing ? (
                    <span className="font-normal text-text-secondary"> (leave blank to keep the current secret)</span>
                  ) : (
                    <RequiredMark />
                  )}
                </label>
                <input
                  id="mcp-client-secret"
                  type="password"
                  required={!editing}
                  value={clientSecret}
                  onChange={event => {
                    setClientSecret(event.target.value);
                  }}
                  placeholder={editing ? 'Unchanged' : 'OAuth client secret'}
                  className={inputClassName}
                />
              </div>

              <div>
                <label htmlFor="mcp-scopes" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Scopes <span className="font-normal text-text-secondary">(optional, one per line)</span>
                </label>
                <textarea
                  id="mcp-scopes"
                  value={scopes}
                  onChange={event => {
                    setScopes(event.target.value);
                  }}
                  placeholder="https://www.googleapis.com/auth/calendar&#10;https://www.googleapis.com/auth/drive"
                  rows={3}
                  className={auiInputClass('resize-y py-2.5 shadow-sm')}
                />
              </div>
            </>
          ) : null}

          {authType === 'header' ? (
            <>
              <div>
                <label htmlFor="mcp-server-api-key" className="mb-1.5 block text-sm font-medium text-text-primary">
                  API key
                  {editingHeaderAuth ? (
                    <span className="font-normal text-text-secondary"> (leave blank to keep the current key)</span>
                  ) : (
                    <RequiredMark />
                  )}
                </label>
                <input
                  id="mcp-server-api-key"
                  type="password"
                  required={!editingHeaderAuth}
                  value={apiKey}
                  onChange={event => {
                    setApiKey(event.target.value);
                  }}
                  placeholder={editingHeaderAuth ? 'Unchanged' : 'Paste the server token'}
                  className={inputClassName}
                />
              </div>

              <div>
                <label htmlFor="mcp-server-header-name" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Header name <span className="font-normal text-text-secondary">(optional)</span>
                </label>
                <input
                  id="mcp-server-header-name"
                  type="text"
                  value={headerName}
                  onChange={event => {
                    setHeaderName(event.target.value);
                  }}
                  placeholder="Authorization"
                  className={inputClassName}
                />
              </div>
            </>
          ) : null}
        </div>

        <div className="mt-6 space-y-3">
          {error ? <p className="text-failure-bg text-sm">{error}</p> : null}
          <Button.Primary type="submit" size="large" disabled={!isValid || busy} className="w-full shrink-0">
            {submitLabel ?? (editing ? 'Save' : 'Add')}
          </Button.Primary>
        </div>
      </form>
    </CenteredModal>
  );
};

export default AddMcpServerForm;
