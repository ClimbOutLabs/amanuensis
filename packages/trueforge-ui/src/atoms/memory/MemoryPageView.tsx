'use client';

import { useEffect, useRef, useState } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import type {
  MemoryPageDetail,
  MemoryPageLine,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryPagesCatalog.js';
import type { MemoryPagesState } from './useMemoryPagesState.js';

const INPUT_CLASS = 'rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary';

function lineDates(line: MemoryPageLine): string | null {
  if (line.seen !== null) return `seen ${line.seen}`;
  if (line.since !== null && line.until !== null) return `${line.since} to ${line.until}`;
  if (line.since !== null) return `since ${line.since}`;
  if (line.until !== null) return `until ${line.until}`;
  return null;
}

function PageLineRow({
  line,
  unconfirmed,
  sections,
  state,
}: {
  line: MemoryPageLine;
  unconfirmed: boolean;
  sections: string[];
  state: MemoryPagesState;
}) {
  const [section, setSection] = useState('Now');
  const dates = lineDates(line);
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border bg-card-bg px-3 py-2">
      <span className="whitespace-pre-wrap break-words text-sm text-text-primary">{line.text}</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
        {unconfirmed ? <span className="font-medium">Not confirmed</span> : null}
        {line.own ? null : <span>{line.sourceLabel}</span>}
        {dates === null ? null : <span>{dates}</span>}
      </span>
      {unconfirmed ? (
        line.id === null ? (
          <span className="text-xs text-text-secondary">Edit the page to change this line.</span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            {sections.length > 1 ? (
              <select
                aria-label={`Move to, for: ${line.text}`}
                value={section}
                onChange={event => setSection(event.target.value)}
                className={INPUT_CLASS}
              >
                {sections.map(name => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              aria-label={`Confirm: ${line.text}`}
              onClick={() =>
                void state.confirmLine({ factId: line.id ?? '', section: sections.includes(section) ? section : 'Now' })
              }
              className={auiButtonClass({ variant: 'secondary', size: 'small' })}
            >
              Confirm
            </button>
            <button
              type="button"
              aria-label={`Dismiss: ${line.text}`}
              onClick={() => void state.dismissLine(line.id ?? '')}
              className={auiButtonClass({ variant: 'ghost', size: 'small' })}
            >
              Dismiss
            </button>
          </span>
        )
      ) : null}
    </li>
  );
}

function PageSections({ page, state }: { page: MemoryPageDetail; state: MemoryPagesState }) {
  if (page.sections.every(section => section.lines.length === 0)) {
    return <p className="text-sm text-text-secondary">This page has no lines yet.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {page.sections.map(section => {
        const list = (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {section.lines.map((line, index) => (
              <PageLineRow
                key={`${line.id ?? 'typed'}-${String(index)}`}
                line={line}
                unconfirmed={section.name === 'Unconfirmed'}
                sections={page.confirmableSections}
                state={state}
              />
            ))}
          </ul>
        );
        if (section.name === 'Earlier') {
          return (
            <details key={section.name} className="flex flex-col gap-2">
              <summary className="cursor-pointer text-xs font-semibold text-text-secondary">
                Earlier ({String(section.lines.length)})
              </summary>
              <div className="mt-2">{list}</div>
            </details>
          );
        }
        if (section.lines.length === 0) return null;
        return (
          <section key={section.name} aria-label={section.name} className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold text-text-secondary">{section.name}</h4>
            {list}
          </section>
        );
      })}
    </div>
  );
}

function PageEditor({ page, state, onDone }: { page: MemoryPageDetail; state: MemoryPagesState; onDone: () => void }) {
  const [draft, setDraft] = useState(page.markdown);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await state.savePage({ markdown: draft, version: page.version });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save this page. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="memory-page-editor" className="text-xs font-medium text-text-secondary">
        Edit page text
      </label>
      <textarea
        id="memory-page-editor"
        value={draft}
        onChange={event => setDraft(event.target.value)}
        rows={20}
        disabled={busy}
        spellCheck={false}
        className={cn(
          'w-full rounded-md border border-border bg-primary-bg px-3 py-2 font-mono text-sm text-text-primary',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
        )}
      />
      {error === null ? null : (
        <p role="alert" className="text-sm text-error-text">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || draft === page.markdown}
          className={auiButtonClass({ variant: 'primary', size: 'small' })}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className={auiButtonClass({ variant: 'ghost', size: 'small' })}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One page: its sections, a text editor, and Delete page. Lines Aman read are marked; the person's own are plain. */
export function MemoryPageView({ page, state }: { page: MemoryPageDetail; state: MemoryPagesState }) {
  const [editing, setEditing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [page.slug, page.kind]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 ref={heading} tabIndex={-1} className="text-base font-semibold text-text-primary outline-none">
            {page.title}
          </h3>
          {page.summary === null ? null : <p className="text-sm text-text-secondary">{page.summary}</p>}
          {page.otherNames.length === 0 ? null : (
            <p className="text-xs text-text-secondary">Also called: {page.otherNames.join(', ')}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {editing ? null : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={auiButtonClass({ variant: 'secondary', size: 'small' })}
            >
              Edit page
            </button>
          )}
          <button
            type="button"
            onClick={() => state.deletePage({ kind: page.kind, slug: page.slug })}
            className={auiButtonClass({ variant: 'ghost', size: 'small' })}
          >
            Delete page
          </button>
        </div>
      </div>
      {editing ? (
        <PageEditor key={page.version} page={page} state={state} onDone={() => setEditing(false)} />
      ) : (
        <PageSections page={page} state={state} />
      )}
    </div>
  );
}
