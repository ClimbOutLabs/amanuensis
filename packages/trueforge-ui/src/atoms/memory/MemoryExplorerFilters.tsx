'use client';

import { RECENT_DAYS, ownerFilterFromValue, type SavedFilter } from './memoryExplorer.js';
import type { MemoryVaultState } from './useMemoryVaultState.js';

const CONTROL_CLASS = 'rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary';

const SAVED_OPTIONS: Array<{ value: SavedFilter; label: string }> = [
  { value: 'any', label: 'Any time' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'range', label: 'Date range' },
];

function savedFilterFromValue(value: string): SavedFilter {
  return SAVED_OPTIONS.find(option => option.value === value)?.value ?? 'any';
}

/** Search, whose memories, when saved, and recently changed. Every control narrows the same list. */
export function MemoryExplorerFilters({ state }: { state: MemoryVaultState }) {
  const { filters } = state;
  const ownerOptions: Array<{ value: string; label: string }> = [
    { value: 'everyone', label: 'Everyone' },
    { value: 'you', label: 'You' },
    { value: 'shared', label: 'Shared topics' },
    ...state.personas.map(persona => ({
      value: `persona:${persona.displayName}`,
      label: `${persona.displayName}'s memories`,
    })),
  ];

  return (
    <div className="flex flex-col gap-3">
      <input
        type="search"
        value={state.search}
        onChange={event => state.setSearch(event.target.value)}
        placeholder="Search memories"
        aria-label="Search memories"
        className="rounded-md border border-border bg-primary-bg px-3 py-1.5 text-sm text-text-primary"
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Whose memories
          <select
            value={filters.owner}
            onChange={event => state.updateFilters({ owner: ownerFilterFromValue(event.target.value) })}
            className={CONTROL_CLASS}
          >
            {ownerOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          When saved
          <select
            value={filters.saved}
            onChange={event => state.updateFilters({ saved: savedFilterFromValue(event.target.value) })}
            className={CONTROL_CLASS}
          >
            {SAVED_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {filters.saved === 'range' ? (
          <>
            <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
              From
              <input
                type="date"
                value={filters.from}
                max={filters.to === '' ? undefined : filters.to}
                onChange={event => state.updateFilters({ from: event.target.value })}
                className={CONTROL_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
              To
              <input
                type="date"
                value={filters.to}
                min={filters.from === '' ? undefined : filters.from}
                onChange={event => state.updateFilters({ to: event.target.value })}
                className={CONTROL_CLASS}
              />
            </label>
          </>
        ) : null}
        <label className="flex items-center gap-2 pb-1.5 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={filters.changedRecently}
            onChange={event => state.updateFilters({ changedRecently: event.target.checked })}
          />
          Changed in the last {RECENT_DAYS} days
        </label>
      </div>
    </div>
  );
}
