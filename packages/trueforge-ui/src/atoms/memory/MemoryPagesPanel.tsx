'use client';

import type { ReactNode } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import { Spinner } from '@/atoms/primitives/Spinner.js';
import { Icon } from '@/icons/Icon.js';
import type { MemoryPageSummary } from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryPagesCatalog.js';
import { useAssistantDisplayName } from '../../components/PersonalizationContext.js';
import { dayCopy, MemoryPageView, PageActions } from './MemoryPageView.js';
import { filterPages, useMemoryPagesState, type MemoryPagesState } from './useMemoryPagesState.js';

const INPUT_CLASS = 'rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary';

function PageRow({ page, state }: { page: MemoryPageSummary; state: MemoryPagesState }) {
  const ref = { kind: page.kind, slug: page.slug };
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-card-bg p-3">
      <button
        type="button"
        onClick={() => state.openPage(ref)}
        className={cn(
          'flex w-full flex-col gap-1 rounded-md text-left',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
        )}
      >
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
          <span className="min-w-0 break-words">{page.title}</span>
          {page.disagreementCount > 0 ? (
            <span className="rounded-full border border-border px-2 text-xs font-normal text-text-secondary">
              {String(page.disagreementCount)} {page.disagreementCount === 1 ? 'pair disagrees' : 'pairs disagree'}
            </span>
          ) : null}
        </span>
        {page.summary === null ? null : (
          <span className="line-clamp-2 text-sm text-text-secondary">{page.summary}</span>
        )}
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-text-secondary">
          {page.changedOn === null ? '' : `Updated ${dayCopy(page.changedOn)}`}
        </span>
        <PageActions
          title={page.title}
          loadPage={() => state.fetchPage(ref)}
          onEdit={() => state.openPage(ref, { editing: true })}
          onDelete={() => state.deletePage(ref)}
        />
      </div>
    </li>
  );
}

function PageGroup({ label, pages, state }: { label: string; pages: MemoryPageSummary[]; state: MemoryPagesState }) {
  if (pages.length === 0) return null;
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-text-secondary">{label}</h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {pages.map(page => (
          <PageRow key={`${page.kind}/${page.slug}`} page={page} state={state} />
        ))}
      </ul>
    </section>
  );
}

function EmptyState({ assistant }: { assistant: string }) {
  return (
    <div className="rounded-xl border border-border bg-card-bg p-6 text-center">
      <p className="text-sm text-text-primary">
        A page is a short note about one person or one matter, such as a trip or a move.
      </p>
      <p className="mt-1 text-sm text-text-secondary">
        {assistant} fills pages as you talk. You can read, fix and delete them here.
      </p>
    </div>
  );
}

function PageList({ state }: { state: MemoryPagesState }) {
  const assistant = useAssistantDisplayName();
  const shown = filterPages({ pages: state.pages, query: state.search });
  if (state.pages.length === 0) {
    return (
      <>
        <EmptyState assistant={assistant} />
        <SkippedFiles state={state} />
      </>
    );
  }
  return (
    <>
      <input
        type="search"
        value={state.search}
        onChange={event => state.setSearch(event.target.value)}
        placeholder="Search pages"
        aria-label="Search pages"
        className={cn(INPUT_CLASS, 'w-full')}
      />
      {shown.length === 0 ? (
        <p className="text-sm text-text-secondary">No page has that name. Try another name.</p>
      ) : (
        <>
          <PageGroup label="People" pages={shown.filter(page => page.kind === 'person')} state={state} />
          <PageGroup label="Matters" pages={shown.filter(page => page.kind === 'matter')} state={state} />
        </>
      )}
      <SkippedFiles state={state} />
    </>
  );
}

function SkippedFiles({ state }: { state: MemoryPagesState }) {
  if (state.skippedFiles.length === 0) return null;
  return (
    <p className="text-sm text-text-secondary">
      {`These files could not be read as pages: ${state.skippedFiles.join(', ')}. Rename each one with lowercase letters and dashes only.`}
    </p>
  );
}

/** Settings > Memory > Pages: the pages Aman keeps for people and matters, one page at a time. */
export function MemoryPagesPanel() {
  const state = useMemoryPagesState();

  let body: ReactNode;
  if (state.loading) {
    body = (
      <div className="flex items-center gap-2 py-8" role="status" aria-live="polite">
        <Spinner size={16} className="text-text-secondary" />
        <span className="text-sm text-text-secondary">Loading pages…</span>
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
  } else if (state.open !== null) {
    body = (
      <>
        <div>
          <button
            type="button"
            onClick={state.closePage}
            className={cn(auiButtonClass({ variant: 'secondary', size: 'small' }), 'gap-1.5')}
          >
            <Icon name="arrow-left" />
            Back to all pages
          </button>
        </div>
        {state.page === null ? (
          <div className="flex items-center gap-2 py-4" role="status" aria-live="polite">
            <Spinner size={16} className="text-text-secondary" />
            <span className="text-sm text-text-secondary">Loading page…</span>
          </div>
        ) : (
          <MemoryPageView page={state.page} state={state} />
        )}
      </>
    );
  } else {
    body = (
      <>
        {state.namespaceOptions.length > 1 ? (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="memory-pages-collection" className="text-sm font-medium text-text-secondary">
              Whose pages
            </label>
            <select
              id="memory-pages-collection"
              value={state.namespace}
              onChange={event => state.setNamespace(event.target.value)}
              className={INPUT_CLASS}
            >
              {state.namespaceOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <PageList state={state} />
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {state.deleteHeld ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card-bg p-3"
        >
          <span className="text-sm text-text-primary">Page deleted.</span>
          <button
            type="button"
            onClick={state.undoDelete}
            className={auiButtonClass({ variant: 'secondary', size: 'small' })}
          >
            Undo
          </button>
        </div>
      ) : null}
      {state.actionError === null ? null : (
        <p role="alert" className="text-sm text-error-text">
          {state.actionError}
        </p>
      )}
      {body}
    </div>
  );
}
