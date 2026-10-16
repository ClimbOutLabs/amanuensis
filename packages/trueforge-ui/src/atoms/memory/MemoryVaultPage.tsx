'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import { Spinner } from '@/atoms/primitives/Spinner.js';
import { useOptionalPersonas } from '@/components/PersonaContext.js';
import { Icon } from '@/icons/Icon.js';
import {
  memoryVaultErrorMessage,
  personaVaultNamespace,
  type MemoryVaultCatalog,
  type MemoryVaultEntry,
  type MemoryVaultSharing,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';
import { useOptionalServer } from '@/server/ServerContext.js';
import { MemorySharing } from './MemorySharing.js';
import { MemoryVaultEntryRow } from './MemoryVaultEntry.js';

const SHARED_NAMESPACE = '';

function hasMemoryVaultPort(server: object): server is { memoryVault: MemoryVaultCatalog } {
  const port: unknown = Reflect.get(server, 'memoryVault');
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'listEntries') === 'function' &&
    typeof Reflect.get(port, 'exportEntries') === 'function' &&
    typeof Reflect.get(port, 'importEntries') === 'function'
  );
}

type NamespaceOption = { value: string; label: string };

/** Browse, edit, export, and import long-lived memory facts. */
export function MemoryVaultPage() {
  const server = useOptionalServer();
  const vault = server !== null && hasMemoryVaultPort(server) ? server.memoryVault : null;
  const personasContext = useOptionalPersonas();
  const personas = useMemo(
    () =>
      (personasContext?.personas ?? []).map(persona => ({
        id: persona.id,
        displayName: persona.display_name,
      })),
    [personasContext],
  );

  const namespaceOptions = useMemo<NamespaceOption[]>(() => {
    const options: NamespaceOption[] = [{ value: SHARED_NAMESPACE, label: 'Shared vault' }];
    for (const persona of personas) {
      options.push({ value: personaVaultNamespace(persona.displayName), label: `${persona.displayName} vault` });
    }
    return options;
  }, [personas]);

  const [namespace, setNamespace] = useState<string>(SHARED_NAMESPACE);
  const [customNamespace, setCustomNamespace] = useState('');
  const [topicNamespaces, setTopicNamespaces] = useState<NamespaceOption[]>([]);
  const [entries, setEntries] = useState<MemoryVaultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'facts' | 'sharing'>('facts');
  const [sharing, setSharing] = useState<MemoryVaultSharing | null>(null);
  const [sharingError, setSharingError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (vault === null) {
      setLoading(false);
      setError('This server does not support the memory vault.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const listed = await vault.listEntries(namespace === SHARED_NAMESPACE ? undefined : namespace);
      setEntries(listed);
    } catch (loadError) {
      setError(memoryVaultErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [vault, namespace]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (vault === null) {
      setSharingError('This server does not support the memory vault.');
      return;
    }
    vault
      .getSharing()
      .then(value => setSharing(value))
      .catch(loadError => setSharingError(memoryVaultErrorMessage(loadError)));
  }, [vault]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query === '') return entries;
    return entries.filter(entry => entry.text.toLowerCase().includes(query));
  }, [entries, search]);

  async function handleSave(options: { entryId: string; text: string }) {
    if (vault === null) return;
    const saved = await vault.updateEntry(options);
    setEntries(previous => previous.map(entry => (entry.id === saved.id ? saved : entry)));
  }

  async function handleDelete(entryId: string) {
    if (vault === null) return;
    await vault.deleteEntry(entryId);
    setEntries(previous => previous.filter(entry => entry.id !== entryId));
  }

  function handleExport() {
    if (vault === null) return;
    vault
      .exportEntries(namespace === SHARED_NAMESPACE ? undefined : namespace)
      .then(payload => {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `memory-vault-${namespace === SHARED_NAMESPACE ? 'shared' : namespace.replace(/[^a-z0-9]+/gi, '-')}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      })
      .catch(exportError => setError(memoryVaultErrorMessage(exportError)));
  }

  function handleImportFile(file: File) {
    if (vault === null) return;
    file
      .text()
      .then(text => {
        const parsed: unknown = JSON.parse(text);
        const items = Array.isArray(parsed)
          ? parsed
          : typeof parsed === 'object' && parsed !== null && Array.isArray(Reflect.get(parsed, 'entries'))
            ? (Reflect.get(parsed, 'entries') as unknown[])
            : null;
        if (items === null) {
          throw new Error('That file does not look like a memory vault export.');
        }
        const entriesToImport = items.flatMap(item => {
          if (typeof item === 'object' && item !== null && typeof Reflect.get(item, 'text') === 'string') {
            const timestamp = Reflect.get(item, 'timestamp');
            return [
              {
                text: Reflect.get(item, 'text') as string,
                ...(typeof timestamp === 'string' ? { timestamp } : {}),
              },
            ];
          }
          return [];
        });
        if (entriesToImport.length === 0) {
          throw new Error('No importable facts found in that file.');
        }
        return vault.importEntries({
          namespace: namespace === SHARED_NAMESPACE ? undefined : namespace,
          entries: entriesToImport,
        });
      })
      .then(() => refresh())
      .catch(importError => setError(memoryVaultErrorMessage(importError)));
  }

  function addTopicNamespace() {
    const trimmed = customNamespace.trim();
    if (trimmed === '') return;
    setTopicNamespaces(previous => {
      if (previous.some(option => option.value === trimmed)) return previous;
      return [...previous, { value: trimmed, label: `${trimmed} vault` }];
    });
    setNamespace(trimmed);
    setCustomNamespace('');
  }

  const allNamespaces = useMemo(() => [...namespaceOptions, ...topicNamespaces], [namespaceOptions, topicNamespaces]);

  const sharingNamespaces = useMemo(
    () => topicNamespaces.map(option => ({ value: option.value, label: option.label.replace(/ vault$/, '') })),
    [topicNamespaces],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Memory vault</h2>
        <p className="text-sm text-text-secondary">
          Facts the assistant remembers across chats. Edits and deletes keep the original entry in history; the vault
          shows the current version.
        </p>
      </div>

      <div role="tablist" aria-label="Memory vault sections" className="flex gap-1 border-b border-border">
        {(
          [
            { id: 'facts', label: 'Facts' },
            { id: 'sharing', label: 'Sharing' },
          ] as const
        ).map(item => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={cn(
              'px-3 py-2 text-sm font-medium',
              tab === item.id ? 'border-b-2 border-primary-button-bg text-text-primary' : 'text-text-secondary',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'sharing' ? (
        sharingError !== null ? (
          <p role="alert" className="text-sm text-error-text">
            {sharingError}
          </p>
        ) : sharing === null ? (
          <div className="flex items-center gap-2 py-8" role="status" aria-live="polite">
            <Spinner size={16} className="text-text-secondary" />
            <span className="text-sm text-text-secondary">Loading sharing…</span>
          </div>
        ) : (
          <MemorySharing
            personas={personas}
            namespaces={sharingNamespaces}
            sharing={sharing}
            onSave={async value => {
              if (vault !== null) {
                await vault.updateSharing(value);
              }
            }}
          />
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="vault-namespace" className="text-sm font-medium text-text-secondary">
              Vault
            </label>
            <select
              id="vault-namespace"
              value={namespace}
              onChange={event => setNamespace(event.target.value)}
              className="rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary"
            >
              {allNamespaces.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={customNamespace}
              onChange={event => setCustomNamespace(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') addTopicNamespace();
              }}
              placeholder="New topic vault name"
              aria-label="New topic vault name"
              className="rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary"
            />
            <button
              type="button"
              onClick={addTopicNamespace}
              className={auiButtonClass({ variant: 'secondary', size: 'small' })}
            >
              Add topic vault
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={handleExport}
                className={auiButtonClass({ variant: 'secondary', size: 'small' })}
              >
                <Icon name="download" className="h-3.5 w-3.5" />
                Export
              </button>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className={auiButtonClass({ variant: 'secondary', size: 'small' })}
              >
                <Icon name="file" className="h-3.5 w-3.5" />
                Import
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json"
                className="hidden"
                aria-label="Import vault JSON file"
                onChange={event => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file !== undefined) handleImportFile(file);
                }}
              />
            </div>
          </div>

          <input
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search facts"
            aria-label="Search facts"
            className="rounded-md border border-border bg-primary-bg px-3 py-1.5 text-sm text-text-primary"
          />

          {loading ? (
            <div className="flex items-center gap-2 py-8" role="status" aria-live="polite">
              <Spinner size={16} className="text-text-secondary" />
              <span className="text-sm text-text-secondary">Loading facts…</span>
            </div>
          ) : error !== null ? (
            <div className="rounded-xl border border-border bg-card-bg p-4" role="alert">
              <p className="text-sm text-error-text">{error}</p>
              <button
                type="button"
                onClick={() => void refresh()}
                className={cn(auiButtonClass({ variant: 'secondary', size: 'small' }), 'mt-2')}
              >
                Try again
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border border-border bg-card-bg p-8 text-center">
              <p className="text-sm text-text-secondary">
                {entries.length === 0
                  ? 'No facts here yet. Facts the assistant saves will appear in this vault.'
                  : 'No facts match this search.'}
              </p>
            </div>
          ) : (
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4">
              {filtered.map(entry => (
                <MemoryVaultEntryRow key={entry.id} entry={entry} onSave={handleSave} onDelete={handleDelete} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
