'use client';

import { useMemo, type ReactNode } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import { Spinner } from '@/atoms/primitives/Spinner.js';
import { Icon } from '@/icons/Icon.js';
import { useAssistantDisplayName } from '../../components/PersonalizationContext.js';
import { MemoryExplorerFilters } from './MemoryExplorerFilters.js';
import { MemorySharing } from './MemorySharing.js';
import { MemoryVaultEntryRow } from './MemoryVaultEntry.js';
import {
  DEFAULT_MEMORY_FILTERS,
  forgetConfirmCopy,
  forgottenCopy,
  formatCount,
  memoryCountCopy,
} from './memoryExplorer.js';
import { MEMORY_PAGE_SIZE, type MemoryVaultState } from './useMemoryVaultState.js';

const INPUT_CLASS = 'rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary';

/** The one line shown for a collection whose latest summary failed; a persona's collection names its persona. */
export function summaryPendingLine(persona: string | null): string {
  return persona === null
    ? "Couldn't make a summary of the latest chat. A later chat will make a new summary."
    : `Couldn't make a summary of the latest chat with ${persona}. A later chat with ${persona} will make a new summary.`;
}

/** The undo bar: forgotten memories wait here for the undo window before the server call. */
function ForgetUndoBar({ state }: { state: MemoryVaultState }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card-bg p-3"
    >
      <span className="text-sm text-text-primary">{forgottenCopy(state.heldCount)}</span>
      <button
        type="button"
        onClick={state.undoForget}
        className={auiButtonClass({ variant: 'secondary', size: 'small' })}
      >
        Undo
      </button>
    </div>
  );
}

/** Plain confirm for forgetting several memories at once. */
function ForgetConfirm({ state, count }: { state: MemoryVaultState; count: number }) {
  const assistant = useAssistantDisplayName();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card-bg p-3">
      <p className="text-sm text-text-primary">{forgetConfirmCopy({ count, assistant })}</p>
      <button
        type="button"
        onClick={state.confirmForget}
        className={auiButtonClass({ variant: 'destructive', size: 'small' })}
      >
        Forget
      </button>
      <button
        type="button"
        onClick={state.cancelForget}
        className={auiButtonClass({ variant: 'ghost', size: 'small' })}
      >
        Keep them
      </button>
    </div>
  );
}

/** Export, import, and topic collections. They work on one collection at a time, so they sit apart from the list. */
function ManageCollections({ state }: { state: MemoryVaultState }) {
  return (
    <details className="rounded-xl border border-border bg-card-bg p-4">
      <summary className="cursor-pointer text-sm font-medium text-text-primary">Export, import, and topics</summary>
      <div className="mt-3 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="memory-collection" className="text-sm font-medium text-text-secondary">
            Collection
          </label>
          <select
            id="memory-collection"
            value={state.namespace}
            onChange={event => state.setNamespace(event.target.value)}
            className={INPUT_CLASS}
          >
            {state.allNamespaces.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={state.customNamespace}
            onChange={event => state.setCustomNamespace(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') state.addTopicNamespace();
            }}
            placeholder="New topic name"
            aria-label="New topic name"
            className={INPUT_CLASS}
          />
          <button
            type="button"
            onClick={state.addTopicNamespace}
            className={auiButtonClass({ variant: 'secondary', size: 'small' })}
          >
            Add topic
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={state.handleExport}
            className={auiButtonClass({ variant: 'secondary', size: 'small' })}
          >
            <Icon name="download" className="h-3.5 w-3.5" />
            Export
          </button>
          <button
            type="button"
            onClick={() => state.fileInput.current?.click()}
            className={auiButtonClass({ variant: 'secondary', size: 'small' })}
          >
            <Icon name="file" className="h-3.5 w-3.5" />
            Import
          </button>
          <input
            ref={state.fileInput}
            type="file"
            accept="application/json"
            className="hidden"
            aria-label="Import memory JSON file"
            onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) state.handleImportFile(file);
            }}
          />
        </div>
      </div>
    </details>
  );
}

/** Shown before any memory exists: what memory is, and where to turn it on or tune it. */
function FirstRunNote({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const assistant = useAssistantDisplayName();
  return (
    <div className="rounded-xl border border-border bg-card-bg p-6 text-center">
      <p className="text-sm text-text-primary">
        {assistant} remembers useful facts from your chats, so it can help you next time.
      </p>
      <p className="mt-1 text-sm text-text-secondary">You can read, edit, copy, or forget any of them here.</p>
      {onOpenSettings !== undefined ? (
        <button
          type="button"
          onClick={onOpenSettings}
          className={cn(auiButtonClass({ variant: 'secondary', size: 'small' }), 'mt-3')}
        >
          Open Memory settings
        </button>
      ) : null}
    </div>
  );
}

/**
 * The memory explorer: one newest-first list grouped by day, with search, filters, selection,
 * edit, copy, and forget with undo. Export and import sit below the list.
 */
export function MemoryVaultFactsPanel({
  state,
  onOpenSettings,
}: {
  state: MemoryVaultState;
  /** Opens the Settings sub-tab where memory is turned on and tuned. Omitted where no such tab exists. */
  onOpenSettings?: () => void;
}) {
  const assistant = useAssistantDisplayName();
  const shownCount = state.shownGroups.reduce((total, group) => total + group.memories.length, 0);
  const selectedCount = state.selectedIds.size;

  let body: ReactNode;
  if (state.loading && state.entries.length === 0) {
    body = (
      <div className="flex items-center gap-2 py-8" role="status" aria-live="polite">
        <Spinner size={16} className="text-text-secondary" />
        <span className="text-sm text-text-secondary">Loading memories…</span>
      </div>
    );
  } else if (state.error !== null) {
    body = (
      <div className="rounded-xl border border-border bg-card-bg p-4" role="alert">
        <p className="text-sm text-error-text">{state.error}</p>
        <button
          type="button"
          onClick={() => void state.refresh()}
          className={cn(auiButtonClass({ variant: 'secondary', size: 'small' }), 'mt-2')}
        >
          Try again
        </button>
      </div>
    );
  } else if (state.entries.length === 0) {
    body = <FirstRunNote onOpenSettings={onOpenSettings} />;
  } else {
    body = (
      <>
        <p className="text-base font-medium text-text-primary" aria-live="polite">
          {memoryCountCopy({ total: state.entries.length, personas: state.personaCount, assistant })}
        </p>
        <MemoryExplorerFilters state={state} />
        {state.confirmForgetIds !== null ? <ForgetConfirm state={state} count={state.confirmForgetIds.length} /> : null}
        {selectedCount > 0 && state.confirmForgetIds === null ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-text-primary">{formatCount(selectedCount)} selected</span>
            <button
              type="button"
              onClick={state.askForgetSelected}
              className={auiButtonClass({ variant: 'destructive', size: 'small' })}
            >
              Forget selected
            </button>
            <button
              type="button"
              onClick={state.clearSelected}
              className={auiButtonClass({ variant: 'ghost', size: 'small' })}
            >
              Clear selection
            </button>
          </div>
        ) : null}
        {state.matchCount === 0 ? (
          <div className="rounded-xl border border-border bg-card-bg p-8 text-center">
            <p className="text-sm text-text-secondary">No memories match these filters.</p>
            <button
              type="button"
              onClick={() => {
                state.setSearch('');
                state.updateFilters(DEFAULT_MEMORY_FILTERS);
              }}
              className={cn(auiButtonClass({ variant: 'secondary', size: 'small' }), 'mt-3')}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {state.shownGroups.map(group => (
              <section key={group.label} aria-label={group.label} className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-text-secondary">{group.label}</h3>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {group.memories.map(memory => (
                    <MemoryVaultEntryRow
                      key={memory.id}
                      entry={memory}
                      highlight={state.filters.query.trim()}
                      selected={state.selectedIds.has(memory.id)}
                      onToggleSelected={state.toggleSelected}
                      onSave={state.handleSave}
                      onForget={id => state.forgetMemories([id])}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {state.matchCount > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-secondary">
            <span>
              Showing {formatCount(shownCount)} of {formatCount(state.matchCount)}
            </span>
            {state.hasMore ? (
              <button
                type="button"
                onClick={state.showMore}
                className={auiButtonClass({ variant: 'secondary', size: 'small' })}
              >
                Show {formatCount(MEMORY_PAGE_SIZE)} more
              </button>
            ) : null}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {state.heldCount > 0 ? <ForgetUndoBar state={state} /> : null}
      {state.actionError !== null ? (
        <p role="alert" className="text-sm text-error-text">
          {state.actionError}
        </p>
      ) : null}
      {state.loadWarning !== null ? (
        <p role="alert" className="text-sm text-error-text">
          {state.loadWarning}
        </p>
      ) : null}
      {state.error === null && !state.loading
        ? state.summaryPending.map(pending => (
            <div key={pending.namespace} className="rounded-xl border border-border bg-card-bg p-4">
              <p className="text-sm text-text-primary">{summaryPendingLine(pending.persona)}</p>
            </div>
          ))
        : null}
      {body}
      <ManageCollections state={state} />
    </div>
  );
}

/** The sharing panel: which other personas' notes each persona can read. */
export function MemoryVaultSharingPanel({ state }: { state: MemoryVaultState }) {
  const assistant = useAssistantDisplayName();
  const personasWithNotes = useMemo(
    () => new Set(state.entries.flatMap(entry => (entry.persona === null ? [] : [entry.persona]))),
    [state.entries],
  );
  if (state.sharingError !== null) {
    return (
      <p role="alert" className="text-sm text-error-text">
        {state.sharingError}
      </p>
    );
  }
  if (state.sharing === null) {
    return (
      <div className="flex items-center gap-2 py-8" role="status" aria-live="polite">
        <Spinner size={16} className="text-text-secondary" />
        <span className="text-sm text-text-secondary">Loading sharing…</span>
      </div>
    );
  }
  return (
    <MemorySharing
      personas={state.personas}
      assistant={assistant}
      personasWithNotes={personasWithNotes}
      namespaces={state.sharingNamespaces}
      sharing={state.sharing}
      onSave={state.handleSharingSave}
    />
  );
}
