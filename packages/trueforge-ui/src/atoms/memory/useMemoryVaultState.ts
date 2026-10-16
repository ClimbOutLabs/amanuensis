'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useOptionalPersonas } from '@/components/PersonaContext.js';
import {
  memoryVaultErrorMessage,
  personaVaultNamespace,
  type MemoryVaultCatalog,
  type MemoryVaultEntry,
  type MemoryVaultSharing,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';
import { useOptionalServer } from '@/server/ServerContext.js';

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

export type NamespaceOption = { value: string; label: string };

// Accepts a bare array or an export object with an `entries` array.
function readImportItems(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed !== 'object' || parsed === null) return null;
  const entries: unknown = Reflect.get(parsed, 'entries');
  return Array.isArray(entries) ? entries : null;
}

/**
 * All memory-list and sharing state for one surface. The standalone memory page and the
 * Settings Memory section share this hook so switching between the Memories and Sharing
 * sub-tabs keeps the loaded entries, the chosen collection, and any topic collections.
 */
export function useMemoryVaultState() {
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
    const options: NamespaceOption[] = [{ value: SHARED_NAMESPACE, label: 'Shared collection' }];
    for (const persona of personas) {
      options.push({ value: personaVaultNamespace(persona.displayName), label: `${persona.displayName} collection` });
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
  const [sharing, setSharing] = useState<MemoryVaultSharing | null>(null);
  const [sharingError, setSharingError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (vault === null) {
      setLoading(false);
      setError('This server does not support memory.');
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
      setSharingError('This server does not support memory.');
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
        anchor.download = `memory-${namespace === SHARED_NAMESPACE ? 'shared' : namespace.replace(/[^a-z0-9]+/gi, '-')}.json`;
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
        const items = readImportItems(parsed);
        if (items === null) {
          throw new Error('That file does not look like a memory export.');
        }
        const entriesToImport = items.flatMap(item => {
          if (typeof item !== 'object' || item === null) return [];
          const text: unknown = Reflect.get(item, 'text');
          if (typeof text !== 'string') return [];
          const timestamp: unknown = Reflect.get(item, 'timestamp');
          return [{ text, ...(typeof timestamp === 'string' ? { timestamp } : {}) }];
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
      return [...previous, { value: trimmed, label: `${trimmed} collection` }];
    });
    setNamespace(trimmed);
    setCustomNamespace('');
  }

  async function handleSharingSave(value: MemoryVaultSharing) {
    if (vault !== null) {
      await vault.updateSharing(value);
    }
  }

  const allNamespaces = useMemo(() => [...namespaceOptions, ...topicNamespaces], [namespaceOptions, topicNamespaces]);

  const sharingNamespaces = useMemo(
    () => topicNamespaces.map(option => ({ value: option.value, label: option.label.replace(/ collection$/, '') })),
    [topicNamespaces],
  );

  return {
    personas,
    namespace,
    setNamespace,
    customNamespace,
    setCustomNamespace,
    entries,
    loading,
    error,
    search,
    setSearch,
    sharing,
    sharingError,
    fileInput,
    refresh,
    filtered,
    handleSave,
    handleDelete,
    handleExport,
    handleImportFile,
    addTopicNamespace,
    handleSharingSave,
    allNamespaces,
    sharingNamespaces,
  };
}

export type MemoryVaultState = ReturnType<typeof useMemoryVaultState>;
