// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MAIN_ASSISTANT_SHARING_KEY } from '@truefoundry/trueforge-core/core/memory/vaultSharing';
import { AMAN_GUIDE_NAME } from '@truefoundry/trueforge-core/core/personas/guide';
import { describe, expect, it, vi } from 'vitest';

import { MemorySharing } from '@/atoms/memory/MemorySharing.js';
import { personaVaultNamespace } from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';

const THEO = { id: 'p-theo', displayName: 'Theo' };
const JUNE = { id: 'p-june', displayName: 'June' };
const GUIDE = { id: 'p-guide', displayName: AMAN_GUIDE_NAME };
const HEALTH = { value: 'topic:health', label: 'Health' };

function renderSharing(options: {
  personas?: Array<{ id: string; displayName: string }>;
  withNotes?: string[];
  namespaces?: Array<{ value: string; label: string }>;
  shares?: Record<string, string[]>;
  onSave?: (sharing: { shares: Record<string, string[]> }) => Promise<void>;
}) {
  const onSave = options.onSave ?? vi.fn(async () => undefined);
  const view = render(
    <MemorySharing
      personas={options.personas ?? [THEO, JUNE]}
      assistant="Juniper"
      personasWithNotes={new Set(options.withNotes ?? [])}
      namespaces={options.namespaces ?? []}
      sharing={{ shares: options.shares ?? {} }}
      onSave={onSave}
    />,
  );
  return { onSave, container: view.container };
}

/** The row of the reader called `label`. */
function row(label: string): HTMLElement {
  return within(screen.getByRole('list', { name: 'Which notes each persona can read' })).getByRole('listitem', {
    name: label,
  });
}

/** Opens a reader's boxes and returns its row. */
function openRow(label: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: `Select what ${label} can read` }));
  return row(label);
}

describe('MemorySharing', () => {
  it('opens with the plain intro, and never says agent or specialist', () => {
    const { container } = renderSharing({});
    expect(
      screen.getByText(
        'Everything you tell any persona about yourself is shared with all of them. Each persona also keeps its own notes. Choose which other personas’ notes each one can read.',
      ),
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bagents?\b|specialist/i);
    for (const element of Array.from(container.querySelectorAll('[aria-label]'))) {
      expect(element.getAttribute('aria-label')).not.toMatch(/\bagents?\b|specialist/i);
    }
  });

  it('shows one row per reader, the main assistant first, with no boxes until one is opened', () => {
    renderSharing({ namespaces: [HEALTH] });
    expect(
      within(screen.getByRole('list', { name: 'Which notes each persona can read' }))
        .getAllByRole('listitem')
        .map(item => item.getAttribute('aria-label')),
    ).toEqual(['Juniper', 'Theo', 'June']);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('says in words what each reader reads', () => {
    renderSharing({
      namespaces: [HEALTH],
      shares: { [THEO.id]: [personaVaultNamespace('June'), 'topic:health'] },
    });

    expect(within(row('Theo')).getByText('Also reads notes from June and Health')).toBeInTheDocument();
    expect(within(row('Theo')).queryByText('Only its own notes')).toBeNull();
    expect(within(row('June')).getByText('Only its own notes')).toHaveClass('text-text-muted');
    expect(within(row('Juniper')).getByText('Only the shared notes')).toBeInTheDocument();
  });

  it('keeps the line short when a reader reads many sets of notes', () => {
    const many = ['Ada', 'Ben', 'Cy', 'Dee', 'Eli'].map(name => ({ id: `p-${name}`, displayName: name }));
    renderSharing({
      personas: [THEO, ...many],
      shares: { [THEO.id]: many.map(persona => personaVaultNamespace(persona.displayName)) },
    });
    expect(within(row('Theo')).getByText('Also reads notes from Ada, Ben and 3 more')).toBeInTheDocument();
  });

  it('opens one reader at a time, with a real checkbox per set of notes that reports its state', () => {
    renderSharing({ shares: { [THEO.id]: [personaVaultNamespace('June')] } });

    expect(within(openRow('Theo')).getByRole('checkbox', { name: 'June' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Close the choices for Theo' })).toHaveAttribute('aria-expanded', 'true');

    // Opening another reader closes the first.
    expect(within(openRow('June')).getByRole('checkbox', { name: 'Theo' })).not.toBeChecked();
    expect(within(row('Theo')).queryAllByRole('checkbox')).toHaveLength(0);

    // The main assistant is listed by its display name, and offered every persona's notes.
    expect(
      within(openRow('Juniper'))
        .getAllByRole('checkbox')
        .map(box => box.getAttribute('aria-label')),
    ).toEqual(['Theo', 'June']);

    fireEvent.click(screen.getByRole('button', { name: 'Close the choices for Juniper' }));
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('never offers a persona its own notes, and never offers the main assistant as a set of notes', () => {
    renderSharing({});
    expect(within(openRow('Theo')).queryByRole('checkbox', { name: 'Theo' })).toBeNull();
    expect(within(openRow('June')).queryByRole('checkbox', { name: 'June' })).toBeNull();
    expect(within(row('June')).queryByRole('checkbox', { name: 'Juniper' })).toBeNull();
  });

  it('offers the topic collections to every reader, the main assistant included', async () => {
    const { onSave } = renderSharing({ namespaces: [HEALTH] });
    for (const label of ['Theo', 'Juniper', 'June']) {
      const opened = openRow(label);
      expect(within(opened).getByRole('group', { name: 'Topics' })).toBeInTheDocument();
      expect(within(opened).getByRole('checkbox', { name: 'Health' })).not.toBeChecked();
    }

    fireEvent.click(within(row('June')).getByRole('checkbox', { name: 'Health' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ shares: { [JUNE.id]: ['topic:health'] } }));
    expect(within(row('June')).getByText('Also reads notes from Health')).toBeInTheDocument();
  });

  it('leaves out the Help persona unless it keeps notes, and then calls it Help', () => {
    const { container } = renderSharing({ personas: [THEO, JUNE, GUIDE] });
    expect(container.textContent).not.toContain(AMAN_GUIDE_NAME);
    expect(screen.queryByRole('listitem', { name: 'Help' })).toBeNull();
    expect(within(openRow('Theo')).queryByRole('checkbox', { name: 'Help' })).toBeNull();
  });

  it('lists the Help persona as Help when it keeps notes of its own', () => {
    renderSharing({ personas: [THEO, JUNE, GUIDE], withNotes: [AMAN_GUIDE_NAME] });
    expect(row('Help')).toBeInTheDocument();
    expect(within(openRow('Theo')).getByRole('checkbox', { name: 'Help' })).not.toBeChecked();
  });

  it('saves each change as it is made, with no save button, and says Saved', async () => {
    const { onSave } = renderSharing({});
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();

    fireEvent.click(within(openRow('Juniper')).getByRole('checkbox', { name: 'Theo' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        shares: { [MAIN_ASSISTANT_SHARING_KEY]: [personaVaultNamespace('Theo')] },
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
  });

  it('turning a box off saves the row without that grant', async () => {
    const { onSave } = renderSharing({
      shares: { [THEO.id]: [personaVaultNamespace('June'), 'topic:health'] },
      namespaces: [HEALTH],
    });

    fireEvent.click(within(openRow('Theo')).getByRole('checkbox', { name: 'June' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ shares: { [THEO.id]: ['topic:health'] } }));
  });

  it('puts the box and the line back and says what to do when a save fails', async () => {
    renderSharing({ onSave: vi.fn(async () => Promise.reject(new Error('offline'))) });

    const box = within(openRow('Theo')).getByRole('checkbox', { name: 'June' });
    fireEvent.click(box);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That change was not saved. Check your connection, then try again.',
    );
    expect(box).not.toBeChecked();
    expect(within(row('Theo')).getByText('Only its own notes')).toBeInTheDocument();
  });

  it('says there is nothing to share before any persona exists', () => {
    renderSharing({ personas: [] });
    expect(
      screen.getByText('No personas keep notes of their own yet, so there is nothing to share.'),
    ).toBeInTheDocument();
  });
});
