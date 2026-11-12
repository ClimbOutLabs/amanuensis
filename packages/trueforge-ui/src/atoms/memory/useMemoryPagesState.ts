'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useOptionalPersonas } from '@/components/PersonaContext.js';
import type {
  MemoryPageDetail,
  MemoryPageKind,
  MemoryPageListing,
  MemoryPagesCatalog,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryPagesCatalog.js';
import {
  memoryVaultErrorMessage,
  personaVaultNamespace,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';
import { memoryStatusReported } from '@/plugins/trueforge-agent-server-adapter/lists.js';
import { useOptionalServer, useServerCapabilities } from '@/server/ServerContext.js';
import { useForgetWithUndo } from './useForgetWithUndo.js';

const SHARED_NAMESPACE = '';

export function hasMemoryPagesPort(server: object): server is { memoryPages: MemoryPagesCatalog } {
  const port: unknown = Reflect.get(server, 'memoryPages');
  return typeof port === 'object' && port !== null && typeof Reflect.get(port, 'listPages') === 'function';
}

/** Whether the Pages tab is offered: the server reported its memory and has the pages routes. */
export function useMemoryPagesAvailable(): boolean {
  const server = useOptionalServer();
  const reported = memoryStatusReported(useServerCapabilities());
  return reported && server !== null && hasMemoryPagesPort(server);
}

export type PageRef = { kind: MemoryPageKind; slug: string };

const refKey = ({ kind, slug }: PageRef) => `${kind}/${slug}`;

/** The pages a search matches: the title or any other name contains the typed text, ignoring case. */
export function filterPages<T extends { title: string; otherNames: string[] }>({
  pages,
  query,
}: {
  pages: T[];
  query: string;
}): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return pages;
  return pages.filter(page => [page.title, ...page.otherNames].some(name => name.toLowerCase().includes(needle)));
}

/**
 * All state of the Memory pages tab: the list, the page being read, and the actions on
 * them. Deleting a page waits for the undo window like forgetting a memory does.
 */
export function useMemoryPagesState() {
  const server = useOptionalServer();
  const pagesPort = server !== null && hasMemoryPagesPort(server) ? server.memoryPages : null;
  const personasContext = useOptionalPersonas();
  const namespaceOptions = useMemo(
    () => [
      { value: SHARED_NAMESPACE, label: 'Shared pages' },
      ...(personasContext?.personas ?? []).map(persona => ({
        value: personaVaultNamespace(persona.display_name),
        label: `${persona.display_name} pages`,
      })),
    ],
    [personasContext],
  );

  const [namespace, setNamespace] = useState(SHARED_NAMESPACE);
  const [listing, setListing] = useState<MemoryPageListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<PageRef | null>(null);
  const [openEditing, setOpenEditing] = useState(false);
  const [page, setPage] = useState<MemoryPageDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (pagesPort === null) {
      setLoading(false);
      setError('This server does not support memory pages.');
      return;
    }
    setError(null);
    try {
      setListing(await pagesPort.listPages(namespace));
    } catch (loadError) {
      setError(memoryVaultErrorMessage(loadError));
    }
    setLoading(false);
  }, [pagesPort, namespace]);

  useEffect(() => {
    setOpen(null);
    setPage(null);
    setLoading(true);
    void refresh();
  }, [refresh]);

  const target = useCallback((ref: PageRef) => ({ ...ref, namespace }), [namespace]);

  const loadPage = useCallback(
    async (ref: PageRef) => {
      if (pagesPort === null) return;
      try {
        setPage(await pagesPort.getPage(target(ref)));
        setActionError(null);
      } catch (loadError) {
        setPage(null);
        setOpen(null);
        setActionError(memoryVaultErrorMessage(loadError));
      }
    },
    [pagesPort, target],
  );

  /** Opens a page to read, or straight in its text editor when asked from the list. */
  function openPage(ref: PageRef, { editing = false }: { editing?: boolean } = {}) {
    setActionError(null);
    setPage(null);
    setOpenEditing(editing);
    setOpen(ref);
    void loadPage(ref);
  }

  function closePage() {
    setOpen(null);
    setPage(null);
  }

  /** Runs an action on the server, then reloads the list. A refusal is shown as the server wrote it. */
  async function act(work: () => Promise<void>) {
    setActionError(null);
    try {
      await work();
    } catch (failure) {
      setActionError(memoryVaultErrorMessage(failure));
    }
    await refresh();
  }

  function settleLine({ factId, section, confirm }: { factId: string; section?: string; confirm: boolean }) {
    if (pagesPort === null || open === null) return Promise.resolve();
    return act(async () => {
      setPage(
        confirm
          ? await pagesPort.confirmLine({ ...target(open), factId, section })
          : await pagesPort.dismissLine({ ...target(open), factId }),
      );
    });
  }

  function dismissDisagreement(disagreementId: string) {
    if (pagesPort === null || open === null) return Promise.resolve();
    return act(async () => {
      setPage(await pagesPort.dismissDisagreement({ ...target(open), disagreementId }));
    });
  }

  /** Saves the editor's text. A refusal throws so the editor can show it beside the text. */
  async function savePage({ markdown, version }: { markdown: string; version: string }) {
    if (pagesPort === null || open === null) return;
    setPage(await pagesPort.savePage({ ...target(open), markdown, version }));
    await refresh();
  }

  const deleteCommit = useCallback(
    async (keys: string[]) => {
      if (pagesPort === null) return;
      setActionError(null);
      for (const key of keys) {
        const [kind, ...rest] = key.split('/');
        const slug = rest.join('/');
        if (kind !== 'person' && kind !== 'matter') continue;
        try {
          await pagesPort.deletePage({ kind, slug, namespace });
        } catch (failure) {
          setActionError(memoryVaultErrorMessage(failure));
        }
      }
      await refresh();
    },
    [pagesPort, namespace, refresh],
  );

  const deleteWithUndo = useForgetWithUndo({ commit: deleteCommit });

  function deletePage(ref: PageRef) {
    closePage();
    deleteWithUndo.forget([refKey(ref)]);
  }

  /** The page as it stands on the server, for copying from the list; a failure is shown like any refusal. */
  async function fetchPage(ref: PageRef): Promise<MemoryPageDetail | null> {
    if (pagesPort === null) return null;
    try {
      return await pagesPort.getPage(target(ref));
    } catch (failure) {
      setActionError(memoryVaultErrorMessage(failure));
      return null;
    }
  }

  const pages = useMemo(
    () => (listing?.pages ?? []).filter(item => !deleteWithUndo.heldIds.has(refKey(item))),
    [listing, deleteWithUndo.heldIds],
  );

  return {
    namespace,
    setNamespace,
    namespaceOptions,
    loading,
    error,
    actionError,
    refresh,
    pages,
    skippedFiles: listing?.skippedFiles ?? [],
    search,
    setSearch,
    open,
    openEditing,
    page,
    fetchPage,
    openPage,
    closePage,
    confirmLine: (options: { factId: string; section?: string }) => settleLine({ ...options, confirm: true }),
    dismissLine: (factId: string) => settleLine({ factId, confirm: false }),
    dismissDisagreement,
    savePage,
    deletePage,
    deleteHeld: deleteWithUndo.heldCount > 0,
    undoDelete: deleteWithUndo.undo,
  };
}

export type MemoryPagesState = ReturnType<typeof useMemoryPagesState>;
