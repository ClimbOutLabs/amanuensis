'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import { Spinner } from '@/atoms/primitives/Spinner.js';
import { Icon } from '@/icons/Icon.js';
import {
  memoryVaultErrorMessage,
  type MemoryVaultCatalog,
  type MemoryVaultEntry,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';
import { useOptionalServer } from '@/server/ServerContext.js';
import { MemoryVaultEntryRow } from './MemoryVaultEntry.js';

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

/** Browse, edit, export, and import long-lived memory facts. */
export function MemoryVaultPage() {
  const server = useOptionalServer();
  const vault = server !== null && hasMemoryVaultPort(server) ? server.memoryVault : null;

  const [entries, setEntries] = useState<MemoryVaultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
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
      const listed = await vault.listEntries();
      setEntries(listed);
    } catch (loadError) {
      setError(memoryVaultErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [vault]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      .exportEntries()
      .then(payload => {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'memory-vault-shared.json';
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
        return vault.importEntries({ entries: entriesToImport });
      })
      .then(() => refresh())
      .catch(importError => setError(memoryVaultErrorMessage(importError)));
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Memory vault</h2>
        <p className="text-sm text-text-secondary">
          Facts the assistant remembers across chats. Edits and deletes keep the original entry in
          history; the vault shows the current version.
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
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
    </div>
  );
}
