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

/** The grid row whose persona is `label`, found by its row heading. */
function row(label: string): HTMLElement {
  const heading = screen.getByRole('rowheader', { name: new RegExp(`^${label}`) });
  const tr = heading.closest('tr');
  if (tr === null) throw new Error(`No grid row for ${label}`);
  return tr;
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

  it('shows one grid: a row per reader and a column per set of notes', () => {
    renderSharing({ namespaces: [HEALTH] });
    expect(screen.getByRole('table', { name: 'Which notes each persona can read' })).toBeInTheDocument();
    // Persona columns come first, topic collections after them.
    expect(screen.getAllByRole('columnheader').map(header => header.textContent)).toEqual([
      'Can also read notes from',
      'Theo',
      'June',
      'Health',
    ]);
    expect(screen.getByRole('rowheader', { name: /^Theo/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /^June/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /^Juniper/ })).toBeInTheDocument();
  });

  it('gives each crossing a real checkbox that reports its state', () => {
    renderSharing({ shares: { [THEO.id]: [personaVaultNamespace('June')] } });

    const theo = within(row('Theo')).getByRole('checkbox', { name: 'June' });
    expect(theo).toBeChecked();
    const june = within(row('June')).getByRole('checkbox', { name: 'Theo' });
    expect(june).not.toBeChecked();
    // The main assistant is listed by its display name, and offered every persona's notes.
    expect(
      within(row('Juniper'))
        .getAllByRole('checkbox')
        .map(box => box.getAttribute('aria-label')),
    ).toEqual(['Theo', 'June']);
  });

  it('leaves the self crossing blank: a persona is never offered its own notes', () => {
    renderSharing({});
    expect(within(row('Theo')).queryByRole('checkbox', { name: 'Theo' })).toBeNull();
    expect(within(row('June')).queryByRole('checkbox', { name: 'June' })).toBeNull();
    // The main assistant keeps no notes of its own, so it has no column.
    expect(screen.queryByRole('columnheader', { name: 'Juniper' })).toBeNull();
    // Every row still has one cell per column, the blank one included.
    for (const label of ['Theo', 'June', 'Juniper']) {
      expect(row(label).querySelectorAll('td')).toHaveLength(2);
    }
  });

  it('says "Only its own notes" in muted text in the row when nothing is ticked', () => {
    renderSharing({ shares: { [THEO.id]: [personaVaultNamespace('June')] } });

    const quiet = within(row('June')).getByText('Only its own notes');
    expect(quiet).toHaveClass('text-text-muted');
    expect(within(row('Theo')).queryByText('Only its own notes')).toBeNull();
    expect(within(row('Juniper')).getByText('Only the shared notes')).toBeInTheDocument();
  });

  it('offers the topic collections on every row, the main assistant included', async () => {
    const { onSave } = renderSharing({ namespaces: [HEALTH] });
    for (const label of ['Theo', 'June', 'Juniper']) {
      expect(within(row(label)).getByRole('checkbox', { name: 'Health' })).not.toBeChecked();
    }

    fireEvent.click(within(row('June')).getByRole('checkbox', { name: 'Health' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ shares: { [JUNE.id]: ['topic:health'] } }));
  });

  it('leaves out the Help persona unless it keeps notes, and then calls it Help', () => {
    const { container } = renderSharing({ personas: [THEO, JUNE, GUIDE] });
    expect(container.textContent).not.toContain(AMAN_GUIDE_NAME);
    expect(screen.queryByRole('rowheader', { name: /^Help/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Help' })).toBeNull();
    expect(screen.queryAllByRole('checkbox', { name: 'Help' })).toHaveLength(0);
  });

  it('lists the Help persona as Help when it keeps notes of its own', () => {
    renderSharing({ personas: [THEO, JUNE, GUIDE], withNotes: [AMAN_GUIDE_NAME] });
    expect(row('Help')).toBeInTheDocument();
    expect(within(row('Theo')).getByRole('checkbox', { name: 'Help' })).not.toBeChecked();
  });

  it('saves each change as it is made, with no save button, and says Saved', async () => {
    const { onSave } = renderSharing({});
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();

    fireEvent.click(within(row('Juniper')).getByRole('checkbox', { name: 'Theo' }));

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

    fireEvent.click(within(row('Theo')).getByRole('checkbox', { name: 'June' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ shares: { [THEO.id]: ['topic:health'] } }));
  });

  it('puts the box back and says what to do when a save fails', async () => {
    renderSharing({ onSave: vi.fn(async () => Promise.reject(new Error('offline'))) });

    const box = within(row('Theo')).getByRole('checkbox', { name: 'June' });
    fireEvent.click(box);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That change was not saved. Check your connection, then try again.',
    );
    expect(box).not.toBeChecked();
  });

  it('says there is nothing to share before any persona exists', () => {
    renderSharing({ personas: [] });
    expect(
      screen.getByText('No personas keep notes of their own yet, so there is nothing to share.'),
    ).toBeInTheDocument();
  });
});
