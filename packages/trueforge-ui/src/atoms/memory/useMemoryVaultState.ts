'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useOptionalPersonas } from '@/components/PersonaContext.js';
import {
  memoryVaultErrorMessage,
  personaVaultNamespace,
  type MemoryVaultCatalog,
  type MemoryVaultSharing,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';
import { useOptionalServer } from '@/server/ServerContext.js';
import {
  DEFAULT_MEMORY_FILTERS,
  filterMemories,
  formatCount,
  groupMemoriesByDate,
  sortNewestFirst,
  type ExplorerMemory,
  type MemoryFilters,
  type MemoryOwner,
} from './memoryExplorer.js';
import { useForgetWithUndo } from './useForgetWithUndo.js';

const SHARED_NAMESPACE = '';
const SEARCH_DEBOUNCE_MS = 150;

/** Memories shown before "Show more". The list is paged so a large memory store never renders at once. */
export const MEMORY_PAGE_SIZE = 50;

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

/** One place memories are kept, read on every refresh. */
type Collection = { namespace: string; owner: MemoryOwner; persona: string | null };

// Accepts a bare array or an export object with an `entries` array.
function readImportItems(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed !== 'object' || parsed === null) return null;
  const entries: unknown = Reflect.get(parsed, 'entries');
  return Array.isArray(entries) ? entries : null;
}

/**
 * All memory state for one surface: every collection's memories in one list, the filters and
 * paging over it, selection, forget with undo, and the export/import tools. The standalone memory
 * page and the Settings Memory section share this hook, so switching sub-tabs keeps the loaded
 * memories and the chosen filters.
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

  // Export and import work on one collection at a time; the list always shows all of them.
  const [namespace, setNamespace] = useState<string>(SHARED_NAMESPACE);
  const [customNamespace, setCustomNamespace] = useState('');
  const [topicNamespaces, setTopicNamespaces] = useState<NamespaceOption[]>([]);
  const [entries, setEntries] = useState<ExplorerMemory[]>([]);
  // Date filters and headings are read against this moment; each load takes a new one.
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Collections whose newest turn summary failed and is still owed, from the last load.
  const [summaryPending, setSummaryPending] = useState<{ namespace: string; persona: string | null }[]>([]);
  // Set when some collections loaded and others did not: the list is shown with this note.
  const [loadWarning, setLoadWarning] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<MemoryVaultSharing | null>(null);
  const [sharingError, setSharingError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const collections = useMemo<Collection[]>(
    () => [
      { namespace: SHARED_NAMESPACE, owner: 'you', persona: null },
      ...personas.map(persona => ({
        namespace: personaVaultNamespace(persona.displayName),
        owner: 'persona' as const,
        persona: persona.displayName,
      })),
      ...topicNamespaces.map(option => ({ namespace: option.value, owner: 'shared' as const, persona: null })),
    ],
    [personas, topicNamespaces],
  );

  const refresh = useCallback(async () => {
    if (vault === null) {
      setLoading(false);
      setError('This server does not support memory.');
      return;
    }
    setLoading(true);
    setError(null);
    setLoadWarning(null);
    // Each collection loads on its own: one collection's failed read must not hide the
    // memories the others already returned, so the loads settle independently and only
    // a load where every collection failed becomes the page error.
    const results = await Promise.allSettled(
      collections.map(async collection => {
        const listed = await vault.listEntries(
          collection.namespace === SHARED_NAMESPACE ? undefined : collection.namespace,
        );
        // A failed status read only loses the pending line for this collection; the
        // entries it returned still count.
        const status = await vault
          .getSummaryStatus(collection.namespace === SHARED_NAMESPACE ? undefined : collection.namespace)
          .catch(() => null);
        return {
          collection,
          entries: listed.map((entry): ExplorerMemory => ({
            ...entry,
            persona: collection.persona ?? entry.persona,
            owner: collection.owner,
          })),
          summaryPending: status?.summaryPending ?? false,
        };
      }),
    );
    const loaded = results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    setNow(new Date());
    if (failure !== undefined && loaded.length === 0) {
      setSummaryPending([]);
      setError(memoryVaultErrorMessage(failure.reason));
    } else {
      setEntries(sortNewestFirst(loaded.flatMap(load => load.entries)));
      setSummaryPending(
        loaded
          .filter(load => load.summaryPending)
          .map(load => ({ namespace: load.collection.namespace, persona: load.collection.persona })),
      );
      setLoadWarning(failure === undefined ? null : 'Some memories could not be loaded. Try again.');
    }
    setLoading(false);
  }, [vault, collections]);

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

  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<MemoryFilters>(DEFAULT_MEMORY_FILTERS);
  const [limit, setLimit] = useState(MEMORY_PAGE_SIZE);

  // The typed text shows at once; the list and highlight follow after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setLimit(MEMORY_PAGE_SIZE);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  function updateFilters(patch: Partial<MemoryFilters>) {
    setFilters(previous => ({ ...previous, ...patch }));
    setLimit(MEMORY_PAGE_SIZE);
  }

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmForgetIds, setConfirmForgetIds] = useState<string[] | null>(null);

  const forgetCommit = useCallback(
    async (ids: string[]) => {
      if (vault === null) return;
      const settled = await Promise.allSettled(
        ids.map(async id => {
          await vault.deleteEntry(id);
          return id;
        }),
      );
      const removed = new Set(settled.flatMap(result => (result.status === 'fulfilled' ? [result.value] : [])));
      const failed = ids.length - removed.size;
      setEntries(previous => previous.filter(entry => !removed.has(entry.id)));
      setSelectedIds(previous => new Set([...previous].filter(id => !removed.has(id))));
      setActionError(
        failed === 0
          ? null
          : `Could not forget ${formatCount(failed)} of ${formatCount(ids.length)} memories. Try again.`,
      );
    },
    [vault],
  );

  const forgetWithUndo = useForgetWithUndo({ commit: forgetCommit });

  /** Forgets after the undo window. Callers pass ids; the confirm step for many lives in the panel. */
  function forgetMemories(ids: string[]) {
    setActionError(null);
    setConfirmForgetIds(null);
    setSelectedIds(previous => new Set([...previous].filter(id => !ids.includes(id))));
    forgetWithUndo.forget(ids);
  }

  function toggleSelected(id: string) {
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelected() {
    setSelectedIds(new Set());
  }

  const liveEntries = useMemo(
    () => entries.filter(entry => !forgetWithUndo.heldIds.has(entry.id)),
    [entries, forgetWithUndo.heldIds],
  );

  const activeFilters = useMemo<MemoryFilters>(() => ({ ...filters, query }), [filters, query]);

  const matches = useMemo(
    () => filterMemories({ memories: liveEntries, filters: activeFilters, now }),
    [liveEntries, activeFilters, now],
  );

  const shownGroups = useMemo(
    () => groupMemoriesByDate({ memories: matches.slice(0, limit), now }),
    [matches, limit, now],
  );

  const personaCount = useMemo(() => liveEntries.filter(entry => entry.owner === 'persona').length, [liveEntries]);

  async function handleSave(options: { entryId: string; text: string }) {
    if (vault === null) return;
    const saved = await vault.updateEntry(options);
    setEntries(previous =>
      previous.map(entry =>
        entry.id === saved.id ? { ...entry, text: saved.text, timestamp: saved.timestamp } : entry,
      ),
    );
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
          throw new Error('No importable memories found in that file.');
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
    entries: liveEntries,
    loading,
    error,
    loadWarning,
    summaryPending,
    actionError,
    search,
    setSearch,
    filters: activeFilters,
    updateFilters,
    matchCount: matches.length,
    shownGroups,
    hasMore: matches.length > limit,
    showMore: () => setLimit(previous => previous + MEMORY_PAGE_SIZE),
    personaCount,
    selectedIds,
    toggleSelected,
    clearSelected,
    confirmForgetIds,
    askForgetSelected: () => setConfirmForgetIds([...selectedIds]),
    cancelForget: () => setConfirmForgetIds(null),
    confirmForget: () => {
      if (confirmForgetIds !== null) forgetMemories(confirmForgetIds);
    },
    forgetMemories,
    undoForget: forgetWithUndo.undo,
    heldCount: forgetWithUndo.heldCount,
    sharing,
    sharingError,
    fileInput,
    refresh,
    handleSave,
    handleExport,
    handleImportFile,
    addTopicNamespace,
    handleSharingSave,
    allNamespaces,
    sharingNamespaces,
  };
}

export type MemoryVaultState = ReturnType<typeof useMemoryVaultState>;
