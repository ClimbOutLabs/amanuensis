'use client';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import { Spinner } from '@/atoms/primitives/Spinner.js';
import { Icon } from '@/icons/Icon.js';
import { MemorySharing } from './MemorySharing.js';
import { MemoryVaultEntryRow } from './MemoryVaultEntry.js';
import type { MemoryVaultState } from './useMemoryVaultState.js';

/** The memory list: pick a collection, search, edit, delete, export, and import facts. */
export function MemoryVaultFactsPanel({ state }: { state: MemoryVaultState }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="vault-namespace" className="text-sm font-medium text-text-secondary">
          Collection
        </label>
        <select
          id="vault-namespace"
          value={state.namespace}
          onChange={event => state.setNamespace(event.target.value)}
          className="rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary"
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
          className="rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary"
        />
        <button
          type="button"
          onClick={state.addTopicNamespace}
          className={auiButtonClass({ variant: 'secondary', size: 'small' })}
        >
          Add topic
        </button>
        <div className="ml-auto flex items-center gap-2">
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

      <input
        type="search"
        value={state.search}
        onChange={event => state.setSearch(event.target.value)}
        placeholder="Search memories"
        aria-label="Search memories"
        className="rounded-md border border-border bg-primary-bg px-3 py-1.5 text-sm text-text-primary"
      />

      {state.loading ? (
        <div className="flex items-center gap-2 py-8" role="status" aria-live="polite">
          <Spinner size={16} className="text-text-secondary" />
          <span className="text-sm text-text-secondary">Loading facts…</span>
        </div>
      ) : state.error !== null ? (
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
      ) : state.filtered.length === 0 ? (
        <div className="rounded-xl border border-border bg-card-bg p-8 text-center">
          <p className="text-sm text-text-secondary">
            {state.entries.length === 0
              ? 'No facts here yet. Facts the assistant saves will appear here.'
              : 'No facts match this search.'}
          </p>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4">
          {state.filtered.map(entry => (
            <MemoryVaultEntryRow key={entry.id} entry={entry} onSave={state.handleSave} onDelete={state.handleDelete} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The sharing panel: which memories each specialist may see. */
export function MemoryVaultSharingPanel({ state }: { state: MemoryVaultState }) {
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
      namespaces={state.sharingNamespaces}
      sharing={state.sharing}
      onSave={state.handleSharingSave}
    />
  );
}
