// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryPagesPanel } from '@/atoms/memory/MemoryPagesPanel.js';
import { FORGET_UNDO_MS } from '@/atoms/memory/useForgetWithUndo.js';
import type {
  MemoryPageDetail,
  MemoryPageDisagreement,
  MemoryPageLine,
  MemoryPagesCatalog,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryPagesCatalog.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

function line(over: Partial<MemoryPageLine> & { text: string }): MemoryPageLine {
  return {
    id: null,
    source: 'you_said',
    sourceLabel: 'From you',
    since: null,
    until: null,
    seen: null,
    ...over,
  };
}

const WENDY: MemoryPageDetail = {
  kind: 'person',
  slug: 'wendy',
  title: 'Wendy',
  otherNames: ['my wife'],
  summary: 'The owner’s wife.',
  confirmableSections: ['How you write to them', 'Now'],
  text: '# Wendy\n\n## Now\n- Likes tea.\n',
  version: 'v1',
  disagreements: [],
  sections: [
    { name: 'Now', lines: [line({ id: 'f_01', text: 'Plays tennis on Fridays.', since: '2026-11-11' })] },
    {
      name: 'Unconfirmed',
      lines: [
        line({
          id: 'f_03',
          text: 'Might travel in November.',
          source: 'read_content',
          sourceLabel: 'External source: read content',
        }),
      ],
    },
    { name: 'Earlier', lines: [line({ id: 'f_04', text: 'Worked at Acme.', until: '2026-03' })] },
  ],
};

const MADRID: MemoryPageDetail = {
  ...WENDY,
  kind: 'matter',
  slug: 'madrid',
  title: 'The Madrid move',
  otherNames: ['Madrid'],
  summary: 'Moving in spring.',
  sections: [{ name: 'Now', lines: [line({ text: 'Lease signed.' })] }],
};

const PAIR: MemoryPageDisagreement = {
  id: 'p1',
  first: { id: 'f_01', text: 'Plays tennis on Fridays.' },
  second: { id: 'f_03', text: 'Never plays sport.' },
  reason: 'One says she plays, the other says she does not.',
  foundOn: '2026-11-11',
};

function summaryOf(page: MemoryPageDetail) {
  return {
    kind: page.kind,
    slug: page.slug,
    title: page.title,
    otherNames: page.otherNames,
    summary: page.summary,
    changedOn: '2026-11-01',
    disagreementCount: page.disagreements.length,
  };
}

function createCatalog({ pages = [WENDY, MADRID] }: { pages?: MemoryPageDetail[] }) {
  let stored = pages;
  const calls = {
    confirm: vi.fn(),
    dismiss: vi.fn(),
    notAProblem: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
  };
  const find = (slug: string): MemoryPageDetail => {
    const found = stored.find(page => page.slug === slug);
    if (found === undefined) throw new Error('There is no page with that name. Reload the list.');
    return found;
  };
  const catalog: MemoryPagesCatalog = {
    listPages: async () => ({
      pages: stored.map(page => summaryOf(page)),
      skippedFiles: [],
    }),
    getPage: async ({ slug }) => find(slug),
    savePage: async options => {
      calls.save(options);
      return find(options.slug);
    },
    confirmLine: async options => {
      calls.confirm(options);
      const page: MemoryPageDetail = {
        ...find(options.slug),
        sections: [
          { name: 'Now', lines: [line({ id: 'f_03', text: 'Might travel in November.', source: 'you_edited' })] },
        ],
      };
      stored = stored.map(item => (item.slug === page.slug ? page : item));
      return page;
    },
    dismissLine: async options => {
      calls.dismiss(options);
      const page: MemoryPageDetail = { ...find(options.slug), sections: [{ name: 'Now', lines: [] }] };
      stored = stored.map(item => (item.slug === page.slug ? page : item));
      return page;
    },
    dismissDisagreement: async options => {
      calls.notAProblem(options);
      const page: MemoryPageDetail = { ...find(options.slug), disagreements: [] };
      stored = stored.map(item => (item.slug === page.slug ? page : item));
      return page;
    },
    deletePage: async target => {
      calls.remove(target);
      stored = stored.filter(page => page.slug !== target.slug);
    },
  };
  return { catalog, calls };
}

function renderPanel(catalog: MemoryPagesCatalog) {
  const server = { ...createMockAgentUIServer({ catalog: createMockCatalog() }), memoryPages: catalog };
  return render(
    <ServerProvider server={server}>
      <MemoryPagesPanel />
    </ServerProvider>,
  );
}

async function openWendy() {
  fireEvent.click(await screen.findByRole('button', { name: /^Wendy/ }));
  await screen.findByRole('heading', { name: 'Wendy' });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MemoryPagesPanel', () => {
  it('shows a block of lines that disagree, with both lines and the reason, and drops the pair on Not a problem', async () => {
    const { catalog, calls } = createCatalog({ pages: [{ ...WENDY, disagreements: [PAIR] }, MADRID] });
    renderPanel(catalog);
    expect(await screen.findByText('1 pair disagrees')).toBeInTheDocument();
    await openWendy();

    const block = screen.getByRole('region', { name: 'These lines disagree' });
    expect(within(block).getByText('Plays tennis on Fridays.')).toBeInTheDocument();
    expect(within(block).getByText('Never plays sport.')).toBeInTheDocument();
    expect(within(block).getByText(PAIR.reason)).toBeInTheDocument();

    fireEvent.click(within(block).getByRole('button', { name: /^Not a problem/ }));
    await waitFor(() =>
      expect(calls.notAProblem).toHaveBeenCalledWith(expect.objectContaining({ disagreementId: 'p1', slug: 'wendy' })),
    );
    await waitFor(() => expect(screen.queryByRole('region', { name: 'These lines disagree' })).not.toBeInTheDocument());
  });

  it('shows no block when no lines disagree', async () => {
    renderPanel(createCatalog({}).catalog);
    await openWendy();
    expect(screen.queryByRole('region', { name: 'These lines disagree' })).not.toBeInTheDocument();
  });

  it('says what pages are when there are none', async () => {
    renderPanel(createCatalog({ pages: [] }).catalog);
    expect(await screen.findByText(/A page is a short note about one person or one matter/)).toBeInTheDocument();
    expect(screen.getByText(/fills pages as you talk/)).toBeInTheDocument();
  });

  it('lists people and matters with no count of lines to confirm, and searches names and other names', async () => {
    renderPanel(createCatalog({}).catalog);
    const people = await screen.findByRole('region', { name: 'People' });
    expect(within(people).getByText('Wendy')).toBeInTheDocument();
    expect(within(people).queryByText(/to confirm/)).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Matters' })).getByText('The Madrid move')).toBeInTheDocument();
    expect(within(people).getByText('The owner’s wife.')).toBeInTheDocument();
    expect(within(people).getByText(/^Updated .*2026/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search pages' }), { target: { value: 'my wife' } });
    expect(screen.queryByText('The Madrid move')).not.toBeInTheDocument();
    expect(screen.getByText('Wendy')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search pages' }), { target: { value: 'zzz' } });
    expect(screen.getByText(/No page has that name/)).toBeInTheDocument();
  });

  it('says where every line came from, shows days as people write them, and collapses Earlier', async () => {
    renderPanel(createCatalog({}).catalog);
    await openWendy();
    const unconfirmed = screen.getByRole('region', { name: 'Unconfirmed' });
    expect(within(unconfirmed).getByText(/You do not need to do anything/)).toBeInTheDocument();
    expect(within(unconfirmed).getByText('External source: read content')).toBeInTheDocument();
    expect(within(unconfirmed).queryByRole('button', { name: /^Confirm:/ })).not.toBeInTheDocument();
    expect(within(unconfirmed).queryByRole('button', { name: /^Dismiss:/ })).not.toBeInTheDocument();
    const now = screen.getByRole('region', { name: 'Now' });
    expect(within(now).queryByRole('button', { name: /^More for:/ })).not.toBeInTheDocument();
    expect(within(now).getByText('From you')).toBeInTheDocument();
    expect(within(now).getByText(/^since .*Nov.*2026$/)).toBeInTheDocument();
    expect(within(now).queryByText(/2026-11-11/)).not.toBeInTheDocument();
    const earlier = screen.getByText(/^Earlier/).closest('details');
    expect(earlier).not.toHaveAttribute('open');
  });

  it('confirms a line into the chosen section and dismisses another', async () => {
    const { catalog, calls } = createCatalog({});
    renderPanel(catalog);
    await openWendy();
    fireEvent.click(screen.getByRole('button', { name: 'More for: Might travel in November.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: Might travel in November.' }));
    await waitFor(() =>
      expect(calls.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ factId: 'f_03', section: 'Now', slug: 'wendy' }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Confirm:/ })).not.toBeInTheDocument());
  });

  it('dismisses an unconfirmed line', async () => {
    const { catalog, calls } = createCatalog({});
    renderPanel(catalog);
    await openWendy();
    fireEvent.click(screen.getByRole('button', { name: 'More for: Might travel in November.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Might travel in November.' }));
    await waitFor(() => expect(calls.dismiss).toHaveBeenCalledWith(expect.objectContaining({ factId: 'f_03' })));
    await waitFor(() => expect(screen.queryByText('Might travel in November.')).not.toBeInTheDocument());
  });

  it('edits the text and shows a refusal exactly as the server wrote it', async () => {
    const { catalog, calls } = createCatalog({});
    const refusal =
      'Nothing was saved. This page changed after you opened it. Reload the page to see what is there now.';
    catalog.savePage = async options => {
      calls.save(options);
      throw new Error(refusal);
    };
    renderPanel(catalog);
    await openWendy();
    fireEvent.click(screen.getByRole('button', { name: /^Edit page/ }));
    const editor = screen.getByRole('textbox', { name: 'Edit page text' });
    expect(editor).toHaveValue(WENDY.text);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(editor, { target: { value: `${WENDY.text}- hi\n` } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(refusal);
    expect(calls.save).toHaveBeenCalledWith(expect.objectContaining({ version: 'v1', text: `${WENDY.text}- hi\n` }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Edit page text' })).not.toBeInTheDocument();
  });

  it('closes the editor after a good save', async () => {
    const { catalog } = createCatalog({});
    renderPanel(catalog);
    await openWendy();
    fireEvent.click(screen.getByRole('button', { name: /^Edit page/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit page text' }), { target: { value: 'new text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit page text' })).not.toBeInTheDocument());
  });

  it('holds a delete for the undo window and sends it afterwards', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { catalog, calls } = createCatalog({});
    renderPanel(catalog);
    await openWendy();
    fireEvent.click(screen.getByRole('button', { name: /^Delete page: Wendy/ }));
    expect(await screen.findByText('Page deleted.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Wendy/ })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(FORGET_UNDO_MS + 100));
    await waitFor(() =>
      expect(calls.remove).toHaveBeenCalledWith(expect.objectContaining({ kind: 'person', slug: 'wendy' })),
    );
  });

  it('brings a page back when the delete is undone before it is sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { catalog, calls } = createCatalog({});
    renderPanel(catalog);
    await openWendy();
    fireEvent.click(screen.getByRole('button', { name: /^Delete page: Wendy/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: /^Wendy/ })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(FORGET_UNDO_MS * 2));
    expect(calls.remove).not.toHaveBeenCalled();
  });

  it('leaves a repeated summary out of the page, and shows a summary of its own with the day the page changed', async () => {
    renderPanel(createCatalog({ pages: [{ ...WENDY, summary: 'Plays tennis on Fridays.' }, MADRID] }).catalog);
    await openWendy();
    expect(screen.getAllByText('Plays tennis on Fridays.')).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Summary' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to all pages' }));
    fireEvent.click(await screen.findByRole('button', { name: /^The Madrid move/ }));
    expect(await screen.findByRole('region', { name: 'Summary' })).toHaveTextContent('Moving in spring.');
    expect(screen.getByText(/^Last updated .*2026/)).toBeInTheDocument();
  });

  it('shows no log of changes', async () => {
    renderPanel(createCatalog({}).catalog);
    await screen.findByRole('region', { name: 'People' });
    expect(screen.queryByText('Recent changes')).not.toBeInTheDocument();
  });

  it('has Copy, Edit and Delete under each page in the list', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { catalog, calls } = createCatalog({});
    renderPanel(catalog);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy page: Wendy' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
    expect(writeText).toHaveBeenCalledWith(
      'Wendy\n\nThe owner’s wife.\n\nNow\n- Plays tennis on Fridays.\n\nUnconfirmed\n- Might travel in November.\n\nEarlier\n- Worked at Acme.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit page: Wendy' }));
    expect(await screen.findByRole('textbox', { name: 'Edit page text' })).toHaveValue(WENDY.text);
    fireEvent.click(screen.getByRole('button', { name: 'Back to all pages' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete page: The Madrid move' }));
    expect(await screen.findByText('Page deleted.')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(FORGET_UNDO_MS + 100));
    await waitFor(() =>
      expect(calls.remove).toHaveBeenCalledWith(expect.objectContaining({ kind: 'matter', slug: 'madrid' })),
    );
  });
});
