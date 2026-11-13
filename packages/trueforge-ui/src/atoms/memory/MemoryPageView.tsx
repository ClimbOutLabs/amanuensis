'use client';

import { useEffect, useRef, useState } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import type {
  MemoryPageDetail,
  MemoryPageDisagreement,
  MemoryPageLine,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryPagesCatalog.js';
import { copyText } from '@/utils/copyText.js';
import type { MemoryPagesState } from './useMemoryPagesState.js';

const COPIED_NOTE_MS = 2000;

const INPUT_CLASS = 'rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary';

/** A stored day such as 2026-11-11 as people write it; anything else is shown as stored. */
export function dayCopy(day: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00`) : null;
  return date === null || Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A page as plain text for the clipboard: its name, its summary, then each section with its lines as bullets. */
function pageAsText(page: MemoryPageDetail): string {
  const sections = page.sections
    .filter(section => section.lines.length > 0)
    .map(section => [section.name, ...section.lines.map(line => `- ${line.text}`)].join('\n'));
  return [page.title, ...(page.summary === null ? [] : [page.summary]), ...sections].join('\n\n');
}

/** Copy, Edit and Delete for one page, the same three a memory has. */
export function PageActions({
  title,
  loadPage,
  onEdit,
  onDelete,
}: {
  title: string;
  loadPage: () => Promise<MemoryPageDetail | null>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    setFailed(false);
    try {
      const page = await loadPage();
      if (page === null) return;
      await copyText(pageAsText(page));
      setCopied(true);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {copied ? (
        <span role="status" className="text-xs text-text-secondary">
          Copied
        </span>
      ) : null}
      {failed ? (
        <span role="alert" className="text-xs text-error-text">
          Could not copy this page. Try again.
        </span>
      ) : null}
      <button
        type="button"
        aria-label={`Copy page: ${title}`}
        onClick={() => void copy()}
        className={auiButtonClass({ variant: 'ghost', size: 'small' })}
      >
        Copy
      </button>
      <button
        type="button"
        aria-label={`Edit page: ${title}`}
        onClick={onEdit}
        className={auiButtonClass({ variant: 'ghost', size: 'small' })}
      >
        Edit
      </button>
      <button
        type="button"
        aria-label={`Delete page: ${title}`}
        onClick={onDelete}
        className={auiButtonClass({ variant: 'ghost', size: 'small' })}
      >
        Delete
      </button>
    </div>
  );
}

function lineDates(line: MemoryPageLine): string | null {
  if (line.seen !== null) return `seen ${dayCopy(line.seen)}`;
  if (line.since !== null && line.until !== null) return `${dayCopy(line.since)} to ${dayCopy(line.until)}`;
  if (line.since !== null) return `since ${dayCopy(line.since)}`;
  if (line.until !== null) return `until ${dayCopy(line.until)}`;
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
    <li className="pl-1 marker:text-text-secondary">
      <span className="flex flex-col gap-1">
        <span className="whitespace-pre-wrap break-words text-sm text-text-primary">{line.text}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
          {unconfirmed ? <span className="font-medium">Not confirmed</span> : null}
          <span>{line.sourceLabel}</span>
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
                  void state.confirmLine({
                    factId: line.id ?? '',
                    section: sections.includes(section) ? section : 'Now',
                  })
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
      </span>
    </li>
  );
}

/** Two lines the nightly check found that cannot both be true. Nothing on the page changed; the person settles it by editing. */
function DisagreementBlock({ pairs, state }: { pairs: MemoryPageDisagreement[]; state: MemoryPagesState }) {
  if (pairs.length === 0) return null;
  return (
    <section aria-label="These lines disagree" className="flex flex-col gap-2">
      <h4 className="text-xs font-semibold text-text-secondary">These lines disagree</h4>
      <p className="text-xs text-text-secondary">
        Aman changed nothing. Edit the page to fix the line that is wrong, or choose Not a problem.
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {pairs.map(pair => (
          <li key={pair.id} className="flex flex-col gap-1 rounded-md border border-border bg-card-bg px-3 py-2">
            <span className="whitespace-pre-wrap break-words text-sm text-text-primary">{pair.first.text}</span>
            <span className="whitespace-pre-wrap break-words text-sm text-text-primary">{pair.second.text}</span>
            <span className="text-xs text-text-secondary">{pair.reason}</span>
            <span>
              <button
                type="button"
                aria-label={`Not a problem: ${pair.first.text} and ${pair.second.text}`}
                onClick={() => void state.dismissDisagreement(pair.id)}
                className={auiButtonClass({ variant: 'ghost', size: 'small' })}
              >
                Not a problem
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
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
          <ul className="m-0 flex list-disc flex-col gap-2 py-0 pl-5 pr-0">
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
  const [draft, setDraft] = useState(page.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await state.savePage({ text: draft, version: page.version });
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
      <p id="memory-page-editor-help" className="text-xs text-text-secondary">
        The first line is the page’s name. Each line that starts with a dash is one thing Aman remembers. A line you
        change or add counts as coming from you. Lines you leave alone keep where they came from.
      </p>
      <textarea
        id="memory-page-editor"
        aria-describedby="memory-page-editor-help"
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
          disabled={busy || draft === page.text}
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

/** One page: when it changed, its summary, its lines as bullets, then Copy, Edit and Delete. Every line says where it came from. */
export function MemoryPageView({ page, state }: { page: MemoryPageDetail; state: MemoryPagesState }) {
  const [editing, setEditing] = useState(state.openEditing);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [page.slug, page.kind]);

  // A page with no summary of its own borrows its first line, which is already shown below.
  const repeated = page.sections.some(section => section.lines.some(line => line.text === page.summary));
  const changedOn =
    state.pages.find(listed => listed.kind === page.kind && listed.slug === page.slug)?.changedOn ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 ref={heading} tabIndex={-1} className="text-base font-semibold text-text-primary outline-none">
            {page.title}
          </h3>
          {changedOn === null ? null : <p className="text-xs text-text-secondary">Last updated {dayCopy(changedOn)}</p>}
          {page.otherNames.length === 0 ? null : (
            <p className="text-xs text-text-secondary">Also called: {page.otherNames.join(', ')}</p>
          )}
        </div>
      </div>
      {editing ? (
        <PageEditor key={page.version} page={page} state={state} onDone={() => setEditing(false)} />
      ) : (
        <>
          {page.summary === null || repeated ? null : (
            <section aria-label="Summary" className="flex flex-col gap-1">
              <h4 className="text-xs font-semibold text-text-secondary">Summary</h4>
              <p className="text-sm text-text-primary">{page.summary}</p>
            </section>
          )}
          <DisagreementBlock pairs={page.disagreements} state={state} />
          <PageSections page={page} state={state} />
          <div className="flex justify-end border-t border-border pt-2">
            <PageActions
              title={page.title}
              loadPage={() => Promise.resolve(page)}
              onEdit={() => setEditing(true)}
              onDelete={() => state.deletePage({ kind: page.kind, slug: page.slug })}
            />
          </div>
        </>
      )}
    </div>
  );
}
