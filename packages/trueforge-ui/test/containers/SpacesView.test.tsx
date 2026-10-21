// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatRelativeUpdated, measureFrameContentHeight, spaceKind, SpacesView } from '@/containers/SpacesView.js';
import { SPACE_PAGE_BASE_STYLE } from '@/containers/spacePageBase.js';
import { takeComposerPrefill } from '@/hooks/useComposerDraft.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import { SpaceProvider, type Space, type SpaceStore } from '@/server/SpaceContext.js';

// jsdom does not implement HTMLDialogElement.showModal()/close(); CenteredModal (used for the
// delete-space confirmation) calls both, so it needs the same minimal polyfill the CenteredModal
// suite uses, toggling the `open` attribute the dialog UA stylesheet keys off.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
const showModal = vi.fn(function showModal(this: HTMLDialogElement) {
  this.open = true;
});
const close = vi.fn(function close(this: HTMLDialogElement) {
  this.open = false;
  this.dispatchEvent(new Event('close'));
});

beforeEach(() => {
  showModal.mockClear();
  close.mockClear();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close });
});

afterEach(() => {
  if (originalShowModal === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  } else {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  }
  if (originalClose === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  } else {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  }
});

const SPAIN_HOUSES: Space = {
  id: 's-spain-houses',
  name: 'Spain houses',
  purpose: 'Track candidate houses in Spain: price, location, and viewing status.',
  status: 'active',
  body: [
    '# Spain houses',
    '',
    'Shortlist of candidate houses.',
    '',
    '| Address | Price | Status |',
    '| --- | --- | --- |',
    '| Calle Mayor 1 | 250000 | Viewed |',
    '| Calle Sol 2 |  | |',
  ].join('\n'),
  format: 'markdown',
  revision: 2,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-10T00:00:00.000Z',
};

const ARCHIVED_TRIP: Space = {
  id: 's-trip',
  name: 'Iceland trip',
  purpose: 'Plan the Iceland trip itinerary.',
  status: 'archived',
  body: '## Day 1\nArrive in Reykjavik.',
  format: 'markdown',
  revision: 5,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-20T00:00:00.000Z',
};

const DESIGNED_TRACKER: Space = {
  id: 's-html-tracker',
  name: 'Launch tracker',
  purpose: 'Track the launch checklist.',
  status: 'active',
  body: '<style>body{background:#111}</style><h1>Launch tracker</h1><p>Ready to ship.</p>',
  format: 'html',
  revision: 1,
  created_at: '2026-09-05T00:00:00.000Z',
  updated_at: '2026-09-12T00:00:00.000Z',
};

/**
 * Backed by the caller's array by reference: `delete` splices it (mirroring the server), and a
 * test can push into or replace elements of it between renders to simulate the model creating or
 * updating a space after the provider mounted. `list` hands back the live array; `SpaceProvider`
 * sorts a copy, so the store's array itself is never reordered.
 */
function mockStore(backing: Space[]): SpaceStore {
  return {
    list: vi.fn(async () => backing),
    get: vi.fn(async ({ spaceId }) => {
      const found = backing.find(space => space.id === spaceId);
      if (found === undefined) throw new Error(`Space not found: ${spaceId}`);
      return found;
    }),
    delete: vi.fn(async ({ spaceId }) => {
      const index = backing.findIndex(space => space.id === spaceId);
      if (index === -1) throw new Error(`Space not found: ${spaceId}`);
      backing.splice(index, 1);
    }),
  };
}

function Harness({ store, initialSpaceId }: { store: SpaceStore; initialSpaceId?: string }) {
  return (
    <ShellModeProvider>
      <SpaceProvider store={store}>
        <OpenOnMount spaceId={initialSpaceId} />
        <SpacesView />
      </SpaceProvider>
    </ShellModeProvider>
  );
}

function OpenOnMount({ spaceId }: { spaceId?: string }) {
  const { openSpaces } = useShellMode();
  // Opens the view on mount, mirroring what SpacesButton does on click.
  useEffect(() => {
    openSpaces(spaceId ?? null);
  }, [openSpaces, spaceId]);
  return null;
}

type Shell = ReturnType<typeof useShellMode>;

let shell: Shell;
function CaptureShell() {
  shell = useShellMode();
  return null;
}

/** Same as Harness, but with a composer, so a new chat can open from the page. */
function ComposerHarness({ store, initialSpaceId }: { store: SpaceStore; initialSpaceId?: string }) {
  return (
    <ShellModeProvider
      agentConfig={{ mode: 'AgentComposer', defaultAgentSpec: { model: { name: 'openai-main/gpt-4.1' } } }}
    >
      <SpaceProvider store={store}>
        <CaptureShell />
        <OpenOnMount spaceId={initialSpaceId} />
        <SpacesView />
      </SpaceProvider>
    </ShellModeProvider>
  );
}

/** A library-only host: no composer can open, so the page must not offer to start a chat. */
function LibraryOnlyHarness({ store, initialSpaceId }: { store: SpaceStore; initialSpaceId?: string }) {
  return (
    <ShellModeProvider agentConfig={{ mode: 'AgentLibrary' }}>
      <SpaceProvider store={store}>
        <OpenOnMount spaceId={initialSpaceId} />
        <SpacesView />
      </SpaceProvider>
    </ShellModeProvider>
  );
}

/** Leaves the view closed on mount so a test can open it later via `shell.openSpaces`. */
function ManualHarness({ store }: { store: SpaceStore }) {
  return (
    <ShellModeProvider>
      <SpaceProvider store={store}>
        <CaptureShell />
        <SpacesView />
      </SpaceProvider>
    </ShellModeProvider>
  );
}

describe('SpacesView list page', () => {
  it('renders each space as a card with its purpose, a type cue, and a relative updated time', async () => {
    render(<Harness store={mockStore([SPAIN_HOUSES, ARCHIVED_TRIP])} />);

    expect(await screen.findByRole('heading', { name: 'Spaces' })).toBeInTheDocument();
    expect(screen.getByText('Spain houses')).toBeInTheDocument();
    expect(screen.getByText('Table')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
    expect(screen.getByText(/Track candidate houses in Spain/)).toBeInTheDocument();
    expect(screen.getAllByText(/just now|ago/).length).toBeGreaterThan(0);
  });

  it('lists the newest space first', async () => {
    const older = { ...SPAIN_HOUSES, id: 's-old', name: 'Older', updated_at: '2026-01-01T00:00:00.000Z' };
    const newer = { ...SPAIN_HOUSES, id: 's-new', name: 'Newer', updated_at: '2026-10-01T00:00:00.000Z' };
    render(<Harness store={mockStore([older, newer])} />);

    const names = (await screen.findAllByRole('button', { name: /Newer|Older/ })).map(card => card.textContent);
    expect(names[0]).toContain('Newer');
    expect(names[1]).toContain('Older');
  });

  it('shows an empty state with one example prompt that starts a chat', async () => {
    render(<ComposerHarness store={mockStore([])} />);

    expect(await screen.findByText(/No spaces yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make a space called Dog breeds that compares family dogs' }));
    await waitFor(() => expect(shell.spacesOpen).toBe(false));
    expect(shell.mode).toMatchObject({ status: 'active', isMutable: true });
    expect(takeComposerPrefill()).toBe('Make a space called Dog breeds that compares family dogs');
  });

  it('leaves the example prompt out when no composer can open', async () => {
    render(<LibraryOnlyHarness store={mockStore([])} />);

    expect(await screen.findByText(/No spaces yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dog breeds/ })).not.toBeInTheDocument();
  });

  it('opens a space page on click', async () => {
    render(<Harness store={mockStore([SPAIN_HOUSES])} />);

    fireEvent.click(await screen.findByRole('button', { name: /Spain houses/ }));

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Spain houses' })).toBeInTheDocument());
  });
});

describe('SpacesView space page', () => {
  it('shows the name once as the title, not repeated as a body heading', async () => {
    render(<Harness store={mockStore([SPAIN_HOUSES])} initialSpaceId={SPAIN_HOUSES.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Spain houses' })).toBeInTheDocument());
    expect(screen.getAllByRole('heading', { name: 'Spain houses' })).toHaveLength(1);
  });

  it('keeps headings in the body that do not repeat the name', async () => {
    render(<Harness store={mockStore([ARCHIVED_TRIP])} initialSpaceId={ARCHIVED_TRIP.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Iceland trip' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Day 1' })).toBeInTheDocument();
  });

  it('shows the purpose as a subtitle and an updated line by Aman, without a revision number or status pill', async () => {
    render(<Harness store={mockStore([SPAIN_HOUSES])} initialSpaceId={SPAIN_HOUSES.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Spain houses' })).toBeInTheDocument());
    expect(screen.getByText(/Track candidate houses in Spain/)).toBeInTheDocument();
    expect(screen.getByText(/Kept up to date by Aman/)).toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
    expect(screen.queryByText(/revision/i)).not.toBeInTheDocument();
  });

  it('shows the Archived label only on an archived space', async () => {
    render(<Harness store={mockStore([ARCHIVED_TRIP])} initialSpaceId={ARCHIVED_TRIP.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Iceland trip' })).toBeInTheDocument());
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  it('puts the updated time in the accessible name with the exact time', async () => {
    render(<Harness store={mockStore([SPAIN_HOUSES])} initialSpaceId={SPAIN_HOUSES.id} />);

    const updated = await screen.findByLabelText(/^updated /);
    expect(updated.tagName).toBe('TIME');
    expect(updated).toHaveAttribute('title', expect.stringMatching(/\d/));
  });

  it('offers Ask Aman to change this, which opens a chat with the space named and nothing sent', async () => {
    render(<ComposerHarness store={mockStore([SPAIN_HOUSES])} initialSpaceId={SPAIN_HOUSES.id} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ask Aman to change this' }));
    await waitFor(() => expect(shell.spacesOpen).toBe(false));
    expect(takeComposerPrefill()).toBe('In the space “Spain houses”, ');
  });

  it('hides Ask Aman to change this when no composer can open', async () => {
    render(<LibraryOnlyHarness store={mockStore([SPAIN_HOUSES])} initialSpaceId={SPAIN_HOUSES.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Spain houses' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Ask Aman to change this' })).not.toBeInTheDocument();
  });

  it('renders a markdown table in the body as a table element', async () => {
    render(<Harness store={mockStore([SPAIN_HOUSES])} initialSpaceId={SPAIN_HOUSES.id} />);

    const table = await screen.findByRole('table');
    expect(table).toBeInTheDocument();
    expect(screen.getByText('Calle Mayor 1')).toBeInTheDocument();
  });

  it('renders a format "html" space body in a sandboxed iframe, not as markdown', async () => {
    render(<Harness store={mockStore([DESIGNED_TRACKER])} initialSpaceId={DESIGNED_TRACKER.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Launch tracker' })).toBeInTheDocument());
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.hasAttribute('srcdoc')).toBe(true);
    // The page heading lives inside the iframe's srcdoc, not the light DOM as a markdown heading.
    expect(screen.queryAllByRole('heading', { name: 'Launch tracker' })).toHaveLength(1);
  });

  it('opens the srcdoc head with a strict CSP so nothing in a space can reach the network', async () => {
    render(<Harness store={mockStore([DESIGNED_TRACKER])} initialSpaceId={DESIGNED_TRACKER.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Launch tracker' })).toBeInTheDocument());
    const srcdoc = document.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    const head = new DOMParser().parseFromString(srcdoc, 'text/html').head;
    const first = head.firstElementChild;
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    const policy = first?.getAttribute('content') ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain('img-src data:;');
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toMatch(/https?:|\*|'self'|blob:/);
  });

  it('gives the iframe no scrollbar of its own, so the outer page owns scrolling', async () => {
    render(<Harness store={mockStore([DESIGNED_TRACKER])} initialSpaceId={DESIGNED_TRACKER.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Launch tracker' })).toBeInTheDocument());
    const frame = document.querySelector('iframe');
    expect(frame?.getAttribute('scrolling')).toBe('no');
    expect(frame?.className).toContain('overflow-hidden');
  });

  it('injects base styles that let content size to auto height and wide tables scroll horizontally', async () => {
    render(<Harness store={mockStore([DESIGNED_TRACKER])} initialSpaceId={DESIGNED_TRACKER.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Launch tracker' })).toBeInTheDocument());
    const frame = document.querySelector('iframe');
    const srcdoc = frame?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('height:auto');
    expect(srcdoc).toContain('overflow:visible');
    expect(srcdoc).toContain('table{display:block;overflow-x:auto;}');
    expect(srcdoc).toContain('img,table{max-width:100%;}');
  });

  it('injects the designed base stylesheet ahead of the page’s own <style>', async () => {
    render(<Harness store={mockStore([DESIGNED_TRACKER])} initialSpaceId={DESIGNED_TRACKER.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Launch tracker' })).toBeInTheDocument());
    const frame = document.querySelector('iframe');
    const srcdoc = frame?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain(SPACE_PAGE_BASE_STYLE);

    const baseIndex = srcdoc.indexOf(SPACE_PAGE_BASE_STYLE);
    // DESIGNED_TRACKER's own body opens with `<style>body{background:#111}</style>`.
    const pageStyleIndex = srcdoc.indexOf('body{background:#111}');
    expect(baseIndex).toBeGreaterThanOrEqual(0);
    expect(pageStyleIndex).toBeGreaterThan(baseIndex);
  });

  it('gives the base stylesheet its design-system classes: cards, tables, badges, page-header, grids', async () => {
    render(<Harness store={mockStore([DESIGNED_TRACKER])} initialSpaceId={DESIGNED_TRACKER.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Launch tracker' })).toBeInTheDocument());
    const frame = document.querySelector('iframe');
    const srcdoc = frame?.getAttribute('srcdoc') ?? '';
    for (const selector of [
      '.page-header',
      '.card,section',
      '.grid-2',
      '.grid-3',
      'thead th',
      'td.num,th.num',
      '.badge',
      '.badge-success',
      '.badge-warning',
      'details',
    ]) {
      expect(srcdoc).toContain(selector);
    }
  });

  it('renders a format "markdown" space as markdown, not an iframe', async () => {
    render(<Harness store={mockStore([SPAIN_HOUSES])} initialSpaceId={SPAIN_HOUSES.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Spain houses' })).toBeInTheDocument());
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('measureFrameContentHeight', () => {
  // jsdom never lays out an iframe's srcdoc, so scrollHeight stays 0 regardless of content and the
  // sizing behaviour cannot be asserted through a rendered iframe. This exercises the pure
  // computation the frame's load and ResizeObserver handlers both call into.
  it('returns the larger of documentElement and body scrollHeight', () => {
    expect(measureFrameContentHeight({ documentElement: { scrollHeight: 900 }, body: { scrollHeight: 640 } })).toBe(
      900,
    );
    expect(measureFrameContentHeight({ documentElement: { scrollHeight: 300 }, body: { scrollHeight: 640 } })).toBe(
      640,
    );
  });

  it('returns 0 when the document or its elements are unavailable', () => {
    expect(measureFrameContentHeight(null)).toBe(0);
    expect(measureFrameContentHeight({ documentElement: null, body: null })).toBe(0);
    expect(measureFrameContentHeight({})).toBe(0);
  });
});

describe('SpacesView refresh on open', () => {
  it('refreshes the space list when the view opens', async () => {
    const store = mockStore([]);
    render(<ManualHarness store={store} />);

    await waitFor(() => expect(store.list).toHaveBeenCalledTimes(1));

    act(() => shell.openSpaces());

    await waitFor(() => expect(store.list).toHaveBeenCalledTimes(2));
  });

  it('shows a space created after mount when the view opens, with no focus or visibility event', async () => {
    const backing: Space[] = [];
    const store = mockStore(backing);
    render(<ManualHarness store={store} />);

    await waitFor(() => expect(store.list).toHaveBeenCalledTimes(1));

    // The model created a space during chat, after the provider mounted.
    backing.push(SPAIN_HOUSES);

    // No window focus or visibilitychange is fired here: opening the view itself refreshes.
    act(() => shell.openSpaces());

    expect(await screen.findByText('Spain houses')).toBeInTheDocument();
  });

  it('shows fresh data on the detail page when it opens', async () => {
    const backing: Space[] = [{ ...SPAIN_HOUSES, body: 'Shortlist.' }];
    const store = mockStore(backing);
    render(<ManualHarness store={store} />);

    act(() => shell.openSpaces(SPAIN_HOUSES.id));
    expect(await screen.findByText('Shortlist.')).toBeInTheDocument();

    // The model updated the space after the first open.
    backing[0] = { ...SPAIN_HOUSES, body: 'Updated shortlist.', revision: 3 };

    act(() => shell.closeSpaces());
    act(() => shell.openSpaces(SPAIN_HOUSES.id));

    expect(await screen.findByText('Updated shortlist.')).toBeInTheDocument();
  });
});

describe('SpacesView list page html cards', () => {
  it('shows an html space as a board, with its purpose and no markup from its body', async () => {
    render(<Harness store={mockStore([DESIGNED_TRACKER])} />);

    expect(await screen.findByText('Launch tracker')).toBeInTheDocument();
    expect(screen.getByText('Board')).toBeInTheDocument();
    expect(screen.getByText('Track the launch checklist.')).toBeInTheDocument();
    expect(screen.queryByText(/<h1>/)).not.toBeInTheDocument();
  });
});
describe('SpacesView delete', () => {
  it('has no per-row delete control on the list page', async () => {
    render(<Harness store={mockStore([SPAIN_HOUSES])} />);

    expect(await screen.findByText('Spain houses')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /space actions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('deletes the space after confirmation naming it, then returns to the list', async () => {
    const store = mockStore([SPAIN_HOUSES]);
    render(<Harness store={store} initialSpaceId={SPAIN_HOUSES.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Spain houses' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Space actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /delete space/i }));

    // The confirmation names the space being deleted.
    await screen.findByRole('heading', { name: 'Delete “Spain houses”?' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete space' }));

    await waitFor(() => expect(store.delete).toHaveBeenCalledWith({ spaceId: SPAIN_HOUSES.id, expectedRevision: 2 }));
    // Deleting returns to the list page, and the list no longer shows the deleted space.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 1, name: 'Spain houses' })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/No spaces yet/)).toBeInTheDocument();
  });

  it('does not delete the space when the confirmation is cancelled', async () => {
    const store = mockStore([SPAIN_HOUSES]);
    render(<Harness store={store} initialSpaceId={SPAIN_HOUSES.id} />);

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Spain houses' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Space actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /delete space/i }));
    await screen.findByRole('heading', { name: 'Delete “Spain houses”?' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(store.delete).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'Spain houses' })).toBeInTheDocument();
  });
});

describe('formatRelativeUpdated', () => {
  const now = Date.parse('2026-10-21T12:00:00.000Z');

  it('says how long ago, in plain words', () => {
    expect(formatRelativeUpdated('2026-10-21T11:55:00.000Z', now)).toBe('5 minutes ago');
    expect(formatRelativeUpdated('2026-10-21T09:00:00.000Z', now)).toBe('3 hours ago');
    expect(formatRelativeUpdated('2026-10-19T12:00:00.000Z', now)).toBe('2 days ago');
  });

  it('says just now under a minute', () => {
    expect(formatRelativeUpdated('2026-10-21T11:59:30.000Z', now)).toBe('just now');
  });

  it('falls back to the raw value for a timestamp it cannot read', () => {
    expect(formatRelativeUpdated('not a date', now)).toBe('not a date');
  });
});

describe('spaceKind', () => {
  it('calls an html page a board', () => {
    expect(spaceKind({ format: 'html', body: '<table></table>' })).toBe('board');
  });

  it('calls a markdown body with a table a table', () => {
    expect(spaceKind({ format: 'markdown', body: '| A | B |\n| --- | --- |\n| 1 | 2 |' })).toBe('table');
  });

  it('calls any other markdown body a list', () => {
    expect(spaceKind({ format: 'markdown', body: '- milk\n- eggs' })).toBe('list');
  });
});
