'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import { sanitizeSpaceHtml } from '@/atoms/lib/sanitizeSpaceHtml.js';
import { Markdown } from '@/atoms/Markdown.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import { DropdownMenu, DropdownMenuItem } from '@/atoms/primitives/DropdownMenu.js';
import { Icon } from '@/icons/Icon.js';
import { useShellMode } from '@/server/ShellModeContext.js';
import { useOptionalSpaces, type Space, type SpaceStatus } from '@/server/SpaceContext.js';
import { resolvePresetTokens } from '@/theme/presets/index.js';
import { useThemeMode } from '@/theme/SlotsProvider.js';
import { TOKEN_CSS_VARS } from '@/theme/types.js';

import { SPACE_PAGE_BASE_STYLE, spaceThemeDeclarations } from './spacePageBase.js';

/** Strips a leading H1 that repeats the space name (the model echoes it in the body). Markdown only. */
function bodyWithoutRepeatedTitle(space: Pick<Space, 'name' | 'body'>): string {
  const match = /^\s*#\s+(.+?)\s*\n/.exec(space.body);
  if (match == null) return space.body;
  if (match[1]?.trim().toLowerCase() !== space.name.trim().toLowerCase()) return space.body;
  return space.body.slice(match[0].length);
}

/** Strips markup down to text, for a one-line preview of an html body. Drops `<style>`/`<script>` content wholesale, not just their tags, so CSS or JS text never leaks into the preview. */
function stripTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

/** First non-heading, non-empty line of the body, for a one-line preview on the list page. */
function bodyPreview(space: Pick<Space, 'name' | 'body' | 'format'>): string {
  if (space.format === 'html') {
    return stripTags(space.body).replace(/\s+/g, ' ').trim();
  }
  const rest = bodyWithoutRepeatedTitle(space);
  for (const rawLine of rest.split('\n')) {
    const line = rawLine.trim().replace(/^#+\s*/, '');
    if (line.length > 0) return line;
  }
  return '';
}

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function StatusPill({ status }: { status: SpaceStatus }) {
  const active = status === 'active';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        active ? 'bg-success-bg text-success-text' : 'bg-secondary-bg text-text-secondary',
      )}
    >
      {active ? 'Active' : 'Archived'}
    </span>
  );
}

function SpacesListSkeleton() {
  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading spaces</span>
      {[0, 1, 2].map(i => (
        <div key={i} className="h-20 animate-pulse rounded-lg border border-border bg-card-bg" aria-hidden />
      ))}
    </div>
  );
}

function SpacesEmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-16 text-center">
      <Icon name="cube" className="size-6 text-text-secondary" aria-hidden />
      <p className="text-sm font-medium text-text-primary">No spaces yet</p>
      <p className="max-w-sm text-sm text-text-secondary">
        Ask the assistant to build one, e.g. “build me a space for tracking houses in Spain.”
      </p>
    </div>
  );
}

function SpaceRow({ space, onOpen }: { space: Space; onOpen: (spaceId: string) => void }) {
  const preview = bodyPreview(space);
  return (
    <button
      type="button"
      className="flex w-full flex-col gap-1 rounded-lg border border-border bg-card-bg px-4 py-3 text-left transition-colors hover:bg-secondary-bg/40"
      onClick={() => onOpen(space.id)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{space.name}</span>
        <StatusPill status={space.status} />
      </div>
      {space.purpose.length > 0 ? <p className="truncate text-xs text-text-secondary">{space.purpose}</p> : null}
      {preview.length > 0 ? <p className="truncate text-xs text-text-secondary/80">{preview}</p> : null}
      <p className="text-[11px] text-text-secondary/70">Updated {formatUpdated(space.updated_at)}</p>
    </button>
  );
}

function SpacesListPage({ onOpen }: { onOpen: (spaceId: string) => void }) {
  const ctx = useOptionalSpaces();
  if (ctx == null) return null;
  const showSkeleton = ctx.loading && ctx.spaces.length === 0;
  const showEmpty = !ctx.loading && ctx.error == null && ctx.spaces.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3 px-6 py-6">
      {ctx.error != null ? <p className="text-sm text-failure-bg">{ctx.error}</p> : null}
      {showSkeleton ? <SpacesListSkeleton /> : null}
      {showEmpty ? <SpacesEmptyState /> : null}
      {!showSkeleton && ctx.spaces.length > 0
        ? ctx.spaces.map(space => <SpaceRow key={space.id} space={space} onOpen={onOpen} />)
        : null}
    </div>
  );
}

/**
 * Reads the full rendered height of a same-origin iframe document. `documentElement.scrollHeight`
 * and `body.scrollHeight` can each under-report on their own (the root element's scrollHeight is
 * clamped to its own box when an ancestor rule gives it a fixed or percentage height; the body's
 * is clamped when it is the one sized that way instead), so the larger of the two is the frame's
 * true content height. Takes a document-like object rather than `Document` so the pure computation
 * is testable without a real iframe: jsdom never lays out an iframe's srcdoc, so `scrollHeight`
 * stays 0 in tests regardless of content, and this function is what a test exercises instead.
 */
export function measureFrameContentHeight(
  doc: { documentElement?: { scrollHeight: number } | null; body?: { scrollHeight: number } | null } | null,
): number {
  if (doc == null) return 0;
  const documentElementHeight = doc.documentElement?.scrollHeight ?? 0;
  const bodyHeight = doc.body?.scrollHeight ?? 0;
  return Math.max(documentElementHeight, bodyHeight);
}

/** Base styles injected into every space srcdoc, ahead of anything the model authored. */
const SPACE_FRAME_BASE_STYLE = [
  'html,body{margin:0;padding:0;height:auto;overflow:visible;}',
  'img,table{max-width:100%;}',
  'table{display:block;overflow-x:auto;}',
].join('');

/**
 * Renders a `format: 'html'` space body in a sandboxed, sanitised iframe. `sandbox="allow-same-origin"`
 * only: no `allow-scripts` (so nothing in the srcdoc can execute), and `allow-same-origin` solely so
 * the parent can read `contentDocument` to size the frame to its content — that combination is safe
 * because the well-known sandbox escape needs `allow-scripts` *and* `allow-same-origin` together.
 * The app's theme tokens (background, text, card, border, accent, and status colors) are read once
 * from its own CSS custom properties and injected as `--space-*` CSS variables at the top of the
 * srcdoc, so the page follows light/dark instead of defaulting to a plain white box.
 * `SPACE_PAGE_BASE_STYLE` (a designed system of type scale, spacing, cards, tables, badges, and
 * more, all keyed off those `--space-*` variables) is injected ahead of that variable block and
 * ahead of the page's own `<style>`, so the model inherits a page that already looks considered
 * and only needs a small `<style>` for page-specific touches.
 *
 * The frame has no scrollbar of its own (`scrolling="no"`, `overflow: hidden` on the iframe box):
 * its height instead tracks the inner document's content height, so the space page scrolls as one
 * document with the rest of the app. `html,body{height:auto;overflow:visible}` in the injected base
 * style keeps the inner document from clamping its own scrollHeight to a percentage height (which
 * would otherwise measure as the frame's *current*, pre-content, height instead of its full
 * content height); `table{display:block;overflow-x:auto}` gives a table wider than the frame its
 * own horizontal scrollbar instead of overflowing past the frame's edge.
 */
function SpaceHtmlFrame({ html }: { html: string }) {
  const mode = useThemeMode();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);

  const sanitized = useMemo(() => sanitizeSpaceHtml(html) ?? '', [html]);

  const srcDoc = useMemo(() => {
    const style = typeof window === 'undefined' ? undefined : getComputedStyle(document.documentElement);
    const presetTokens = resolvePresetTokens(undefined, mode);
    // Real app theme values, derived once per render. Placed after SPACE_PAGE_BASE_STYLE so the
    // cascade lets these override that module's own preset-derived fallbacks.
    const themeVars = spaceThemeDeclarations(
      token => style?.getPropertyValue(TOKEN_CSS_VARS[token]).trim() || presetTokens[token],
    );

    return [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<meta charset="utf-8">',
      `<style>${SPACE_FRAME_BASE_STYLE}</style>`,
      `<style>${SPACE_PAGE_BASE_STYLE}</style>`,
      `<style>:root{${themeVars}}</style>`,
      '</head>',
      `<body>${sanitized}</body>`,
      '</html>',
    ].join('');
  }, [sanitized, mode]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe == null) return;
    let observer: ResizeObserver | undefined;

    const measure = () => {
      try {
        const measured = measureFrameContentHeight(iframe.contentDocument);
        if (measured > 0) setHeight(measured);
      } catch {
        // contentDocument is inaccessible (e.g. the sandbox denied same-origin access); keep the
        // last known height instead of throwing.
      }
    };

    const handleLoad = () => {
      measure();
      try {
        const doc = iframe.contentDocument;
        if (doc?.documentElement != null && typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(measure);
          observer.observe(doc.documentElement);
          if (doc.body != null) observer.observe(doc.body);
        }
      } catch {
        /* ignore: no same-origin access, no live resize tracking */
      }
    };

    // The srcdoc may already have finished loading by the time this effect runs (a same-tick
    // re-render reusing an iframe whose content did not change), in which case 'load' never
    // fires again; measure once up front so that case is not left at the stale default height.
    measure();
    iframe.addEventListener('load', handleLoad);
    return () => {
      iframe.removeEventListener('load', handleLoad);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={iframeRef}
      title="Space content"
      srcDoc={srcDoc}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      scrolling="no"
      className="w-full overflow-hidden rounded-lg border border-border"
      style={{ height: `${String(height)}px` }}
    />
  );
}

/**
 * Overflow menu on the space page holding the one destructive action a person can take here.
 * Deliberately not placed beside the title/status row: deletion is rare and irreversible, so it
 * sits apart from anything read on every visit rather than beside a "primary" action (there isn't
 * one to be next to; the space itself has no other person-facing controls).
 */
function SpaceOverflowMenu({ onRequestDelete }: { onRequestDelete: () => void }) {
  return (
    <DropdownMenu
      trigger={
        <button
          type="button"
          aria-label="Space actions"
          title="Space actions"
          className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
        >
          <Icon name="ellipsis" />
        </button>
      }
    >
      <DropdownMenuItem onClick={onRequestDelete} className="text-failure-bg">
        <Icon name="trash" className="size-4" aria-hidden />
        Delete space
      </DropdownMenuItem>
    </DropdownMenu>
  );
}

function DeleteSpaceModal({
  space,
  open,
  onOpenChange,
  onDeleted,
}: {
  space: Space;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const ctx = useOptionalSpaces();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmDelete = () => {
    if (ctx == null) return;
    setBusy(true);
    setError(null);
    void ctx
      .deleteSpace({ spaceId: space.id, expectedRevision: space.revision })
      .then(() => {
        onOpenChange(false);
        onDeleted();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'Failed to delete space');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <CenteredModal
      open={open}
      onOpenChange={next => {
        if (!busy) onOpenChange(next);
      }}
      title={`Delete “${space.name}”?`}
      contentSized
      className="md:max-w-md"
    >
      <div className="flex flex-col gap-2 px-5 py-5">
        <p className="text-sm text-text-secondary">This permanently deletes the space and its content.</p>
        {error != null ? <p className="text-sm text-failure-bg">{error}</p> : null}
      </div>
      <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
        <Button variant="ghost" type="button" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" type="button" disabled={busy} onClick={confirmDelete}>
          Delete space
        </Button>
      </footer>
    </CenteredModal>
  );
}

function SpaceDetailPage({ spaceId, onDeleted }: { spaceId: string; onDeleted: () => void }) {
  const ctx = useOptionalSpaces();
  const space = useMemo(() => ctx?.spaces.find(s => s.id === spaceId), [ctx, spaceId]);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (ctx == null) return null;
  if (space == null) {
    return ctx.loading ? (
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-3 px-6 py-6">
        <SpacesListSkeleton />
      </div>
    ) : (
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-6">
        <p className="text-sm text-text-secondary">This space is no longer available.</p>
      </div>
    );
  }

  const body = space.format === 'html' ? space.body : bodyWithoutRepeatedTitle(space);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-6">
      <header className="flex flex-col gap-2 border-b border-border pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{space.name}</h1>
            <StatusPill status={space.status} />
          </div>
          <SpaceOverflowMenu onRequestDelete={() => setDeleteOpen(true)} />
        </div>
        {space.purpose.length > 0 ? <p className="text-sm text-text-secondary">{space.purpose}</p> : null}
        <p className="text-xs text-text-secondary/70">Updated {formatUpdated(space.updated_at)}</p>
      </header>
      {body.trim().length === 0 ? null : space.format === 'html' ? (
        <SpaceHtmlFrame html={body} />
      ) : (
        <Markdown content={body} readOnly className="space-markdown max-w-none" />
      )}
      <DeleteSpaceModal space={space} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={onDeleted} />
    </div>
  );
}

/** Full-page Spaces view: a list of the user's spaces, or one open space. Wired into the shell as an alternative to chat, the same way Settings is. */
export function SpacesView() {
  const shell = useShellMode();
  const { spacesOpen, selectedSpaceId, openSpaces, closeSpaces } = shell;
  // Hooks must run before the early return below. The space list is also loaded on provider
  // mount and on window focus, but neither covers the normal loop — chat → the model creates or
  // updates a space → this view opens without the tab ever losing focus — so refresh on every
  // open and on every selection change. Refreshing behind an already-populated list does not
  // flash a loading state (see `SpaceProvider.load`). Depend on the stable `refresh` callback
  // only: the context value's identity changes on every load, which would re-trigger this.
  const { refresh } = useOptionalSpaces() ?? {};
  useEffect(() => {
    if (spacesOpen) refresh?.();
  }, [spacesOpen, selectedSpaceId, refresh]);

  if (!spacesOpen) return null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-primary-bg">
      <header className="sticky top-0 flex shrink-0 items-center gap-2 border-b border-border bg-primary-bg px-2 py-1.5">
        <button
          type="button"
          aria-label="Back"
          title="Back"
          className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
          onClick={() => (selectedSpaceId != null ? openSpaces(null) : closeSpaces())}
        >
          <Icon name="arrow-left" />
        </button>
        <h1 className="text-lg font-semibold tracking-tight text-text-primary">Spaces</h1>
      </header>
      {selectedSpaceId != null ? (
        <SpaceDetailPage spaceId={selectedSpaceId} onDeleted={() => openSpaces(null)} />
      ) : (
        <SpacesListPage onOpen={id => openSpaces(id)} />
      )}
    </div>
  );
}

export default SpacesView;
