// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryVaultPage } from '@/atoms/memory/MemoryVaultPage.js';
import { MemoryVaultFactsPanel } from '@/atoms/memory/MemoryVaultPanels.js';
import { FORGET_UNDO_MS } from '@/atoms/memory/useForgetWithUndo.js';
import { useMemoryVaultState } from '@/atoms/memory/useMemoryVaultState.js';
import { PersonaProvider, type Persona, type PersonaApi } from '@/components/PersonaContext.js';
import type {
  MemoryVaultCatalog,
  MemoryVaultEntry,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { personaKnowledgeApiStubs } from '../../personaApiStubs.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo({ days, hour = 9 }: { days: number; hour?: number }): string {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return new Date(date.getTime() - days * DAY_MS).toISOString();
}

function memory({ id, text, timestamp }: { id: string; text: string; timestamp: string }): MemoryVaultEntry {
  return { id, text, timestamp, persona: null };
}

const FIXTURE: MemoryVaultEntry[] = [
  memory({ id: 'tea', text: 'Drinks **tea** in the morning.', timestamp: daysAgo({ days: 0, hour: 8 }) }),
  memory({ id: 'walks', text: 'Likes long morning walks.', timestamp: daysAgo({ days: 1 }) }),
  memory({ id: 'lisbon', text: 'Planning a trip to Lisbon in spring.', timestamp: daysAgo({ days: 40 }) }),
];

/** A fake vault: lists what it holds and removes deleted memories, like the real server. */
function createCatalog(initial: MemoryVaultEntry[]) {
  let stored = initial;
  const deleteEntry = vi.fn(async (entryId: string) => {
    stored = stored.filter(entry => entry.id !== entryId);
  });
  const catalog: MemoryVaultCatalog = {
    listEntries: async namespace => (namespace === undefined ? stored : []),
    getSummaryStatus: async () => ({ summaryPending: false }),
    updateEntry: async () => {
      throw new Error('not used in these tests');
    },
    deleteEntry,
    exportEntries: async () => ({ namespace: '', exportedAt: daysAgo({ days: 0 }), entries: [] }),
    importEntries: async () => ({ namespace: '', imported: 0 }),
    getSharing: async () => ({ shares: {} }),
    updateSharing: async sharing => sharing,
  };
  return { catalog, deleteEntry };
}

function Shell({ catalog, children }: { catalog: MemoryVaultCatalog; children: ReactNode }) {
  const server = { ...createMockAgentUIServer({ catalog: createMockCatalog() }), memoryVault: catalog };
  return <ServerProvider server={server}>{children}</ServerProvider>;
}

function Harness(props: { onOpenSettings?: () => void }) {
  const state = useMemoryVaultState();
  return <MemoryVaultFactsPanel state={state} onOpenSettings={props.onOpenSettings} />;
}

function renderPanel(memories: MemoryVaultEntry[], options: { onOpenSettings?: () => void } = {}) {
  const fake = createCatalog(memories);
  render(
    <Shell catalog={fake.catalog}>
      <Harness onOpenSettings={options.onOpenSettings} />
    </Shell>,
  );
  return fake;
}

function byIndex(elements: HTMLElement[], index: number): HTMLElement {
  const element = elements[index];
  if (element === undefined) throw new Error(`No element at index ${index}`);
  return element;
}

function listedTexts(): string[] {
  return screen.queryAllByRole('listitem').map(item => item.textContent ?? '');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Memory explorer', () => {
  it('states the counts in plain words at the top', async () => {
    renderPanel(FIXTURE);

    expect(await screen.findByText('Aman remembers 3 things about you. None belong to personas.')).toBeInTheDocument();
  });

  it('shows the list newest first, under date headings', async () => {
    renderPanel(FIXTURE);

    const today = await screen.findByRole('region', { name: 'Today' });
    expect(within(today).getByText('tea')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Yesterday' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Last week' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(listedTexts()[0]).toContain('tea');
  });

  it('renders each memory as formatted text', async () => {
    renderPanel(FIXTURE);

    await screen.findByText('tea');
    expect(screen.getByText('tea').tagName).toBe('STRONG');
  });

  it('filters as you type and highlights the match', async () => {
    renderPanel(FIXTURE);
    await screen.findByText('Aman remembers 3 things about you. None belong to personas.');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search memories' }), { target: { value: 'morning' } });

    await waitFor(() => expect(listedTexts()).toHaveLength(2));
    const marks = Array.from(document.querySelectorAll('mark')).map(mark => mark.textContent);
    expect(marks).toEqual(expect.arrayContaining(['morning']));
    expect(screen.queryByText(/Lisbon/)).toBeNull();
  });

  it('narrows to memories changed in the last seven days', async () => {
    renderPanel(FIXTURE);
    await screen.findByText('tea');

    fireEvent.click(screen.getByRole('checkbox', { name: /Changed in the last 7 days/ }));

    await waitFor(() => expect(screen.queryByText(/Lisbon/)).toBeNull());
    expect(screen.getByText(/Likes long morning walks/)).toBeInTheDocument();
  });

  it('narrows to this month by the saved date', async () => {
    renderPanel(FIXTURE);
    await screen.findByText('tea');

    fireEvent.change(screen.getByRole('combobox', { name: 'When saved' }), { target: { value: 'today' } });

    await waitFor(() => expect(listedTexts()).toHaveLength(1));
    expect(screen.getByText('tea')).toBeInTheDocument();
  });

  it('shows a plain no-match message and clears the filters from it', async () => {
    renderPanel(FIXTURE);
    await screen.findByText('tea');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search memories' }), { target: { value: 'zzz' } });
    expect(await screen.findByText('No memories match these filters.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(listedTexts()).toHaveLength(3));
  });

  it('asks once before forgetting several memories, with plain copy', async () => {
    const { deleteEntry } = renderPanel(FIXTURE);
    await screen.findByText('tea');

    const boxes = screen.getAllByRole('checkbox', { name: 'Select this memory' });
    fireEvent.click(byIndex(boxes, 0));
    fireEvent.click(byIndex(boxes, 1));
    fireEvent.click(screen.getByRole('button', { name: 'Forget selected' }));

    expect(screen.getByText("Forget 2 memories? Aman won't use them again.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(screen.queryByText(/Forget 2 memories/)).toBeNull();
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it('forgets nothing on the server until the undo window ends, and Undo cancels it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { deleteEntry } = renderPanel(FIXTURE);
    await screen.findByText('tea');

    fireEvent.click(byIndex(screen.getAllByRole('button', { name: 'Forget' }), 0));
    expect(screen.getByRole('status')).toHaveTextContent('Forgot 1 memory.');
    expect(screen.queryByText('tea')).toBeNull();

    act(() => vi.advanceTimersByTime(FORGET_UNDO_MS - 1000));
    expect(deleteEntry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('tea')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(FORGET_UNDO_MS * 2));
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it('sends the forget to the server once the undo window ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { deleteEntry } = renderPanel(FIXTURE);
    await screen.findByText('tea');

    fireEvent.click(byIndex(screen.getAllByRole('button', { name: 'Forget' }), 0));
    act(() => vi.advanceTimersByTime(FORGET_UNDO_MS));

    await waitFor(() => expect(deleteEntry).toHaveBeenCalledWith('tea'));
    expect(await screen.findByText('Aman remembers 2 things about you. None belong to personas.')).toBeInTheDocument();
  });

  it('shows the first-run note with a way to Memory settings when nothing is remembered yet', async () => {
    const onOpenSettings = vi.fn();
    renderPanel([], { onOpenSettings });

    expect(await screen.findByText(/Aman remembers useful facts from your chats/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Memory settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps the list paged, so ten thousand memories never render at once', async () => {
    const many = Array.from({ length: 10_000 }, (_, index) =>
      memory({ id: `m-${index}`, text: `Memory number ${index} about tea`, timestamp: daysAgo({ days: index % 400 }) }),
    );
    renderPanel(many);

    expect(
      await screen.findByText('Aman remembers 10,000 things about you. None belong to personas.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByText('Showing 50 of 10,000')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(100));
  }, 30_000);

  it('uses no internal words in anything a person reads', async () => {
    render(
      <Shell catalog={createCatalog(FIXTURE).catalog}>
        <MemoryVaultPage />
      </Shell>,
    );
    await screen.findByText('tea');

    expect(document.body.textContent ?? '').not.toMatch(/vault|namespace|entry/i);
  });
});

describe('Memory explorer with several collections', () => {
  const ZARA: Persona = {
    id: 'p-zara',
    display_name: 'Zara',
    aliases: [],
    instructions: 'Answer as a careful archivist.',
    model_name: 'anthropic/haiku',
  };

  const SHARED_PENDING_LINE = "Couldn't make a summary of the latest chat. A later chat will make a new summary.";
  const ZARA_PENDING_LINE =
    "Couldn't make a summary of the latest chat with Zara. A later chat with Zara will make a new summary.";

  function personaApi(): PersonaApi {
    return {
      listPersonas: async () => [ZARA],
      createPersona: async () => {
        throw new Error('not used in these tests');
      },
      updatePersona: async () => {
        throw new Error('not used in these tests');
      },
      deletePersona: async () => {},
      getSessionPersona: async () => null,
      setSessionPersona: async () => null,
      ...personaKnowledgeApiStubs,
    };
  }

  function catalogWith(overrides: Partial<MemoryVaultCatalog>): MemoryVaultCatalog {
    return {
      listEntries: async () => [],
      getSummaryStatus: async () => ({ summaryPending: false }),
      updateEntry: async () => {
        throw new Error('not used in these tests');
      },
      deleteEntry: async () => {},
      exportEntries: async () => ({ namespace: '', exportedAt: daysAgo({ days: 0 }), entries: [] }),
      importEntries: async () => ({ namespace: '', imported: 0 }),
      getSharing: async () => ({ shares: {} }),
      updateSharing: async sharing => sharing,
      ...overrides,
    };
  }

  function renderPersonaPanel(catalog: MemoryVaultCatalog) {
    const server = { ...createMockAgentUIServer({ catalog: createMockCatalog() }), memoryVault: catalog };
    render(
      <ServerProvider server={server}>
        <PersonaProvider api={personaApi()}>
          <Harness />
        </PersonaProvider>
      </ServerProvider>,
    );
  }

  it('still shows one persona’s stored summary when another collection fails to load', async () => {
    const catalog = catalogWith({
      listEntries: async namespace => {
        if (namespace === undefined) {
          throw new Error('The memory request failed');
        }
        return [
          memory({
            id: 'z1',
            text: 'Turn summary: Zara filed the travel notes.',
            timestamp: daysAgo({ days: 0, hour: 8 }),
          }),
        ];
      },
    });
    renderPersonaPanel(catalog);

    expect(await screen.findByText(/Turn summary: Zara filed the travel notes\./)).toBeInTheDocument();
    expect(await screen.findByText('Some memories could not be loaded. Try again.')).toBeInTheDocument();
  });

  it('shows the plain line in place of a summary that failed, for that persona only', async () => {
    const catalog = catalogWith({
      listEntries: async namespace =>
        namespace === undefined
          ? [memory({ id: 's1', text: 'Turn summary: the shared notes.', timestamp: daysAgo({ days: 0, hour: 8 }) })]
          : [
              memory({
                id: 'z1',
                text: 'User: the full text of a long chat.\n\nAssistant: the full reply.',
                timestamp: daysAgo({ days: 0, hour: 9 }),
              }),
            ],
      getSummaryStatus: async namespace => ({ summaryPending: namespace === 'persona:Zara' }),
    });
    renderPersonaPanel(catalog);

    expect(await screen.findByText(ZARA_PENDING_LINE)).toBeInTheDocument();
    expect(screen.queryByText(SHARED_PENDING_LINE)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Couldn't make a summary/)).toHaveLength(1);
    expect(screen.getByText(/Turn summary: the shared notes\./)).toBeInTheDocument();
  });

  it('names the persona on its own line and keeps the plain line for the shared collection', async () => {
    const catalog = catalogWith({
      listEntries: async () => [],
      getSummaryStatus: async () => ({ summaryPending: true }),
    });
    renderPersonaPanel(catalog);

    expect(await screen.findByText(ZARA_PENDING_LINE)).toBeInTheDocument();
    expect(screen.getByText(SHARED_PENDING_LINE)).toBeInTheDocument();
    expect(screen.getAllByText(/Couldn't make a summary/)).toHaveLength(2);
  });

  it('does not promise that the failed chat itself is summarised again', async () => {
    const catalog = catalogWith({
      listEntries: async () => [],
      getSummaryStatus: async () => ({ summaryPending: true }),
    });
    renderPersonaPanel(catalog);

    const line = await screen.findByText(SHARED_PENDING_LINE);
    expect(line.textContent).not.toMatch(/try again|retry/i);
    expect(line.textContent).toMatch(/new summary/);
  });

  it('shows no pending line when every summary was made', async () => {
    const catalog = catalogWith({
      listEntries: async namespace => [
        memory({
          id: namespace === undefined ? 's1' : 'z1',
          text: 'Turn summary: the shared notes.',
          timestamp: daysAgo({ days: 0, hour: 8 }),
        }),
      ],
    });
    renderPersonaPanel(catalog);

    expect(await screen.findByText(/Turn summary: the shared notes\./)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't make a summary/)).toBeNull();
  });
});
