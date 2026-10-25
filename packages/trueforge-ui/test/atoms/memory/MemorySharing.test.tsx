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

/** The row whose persona is `label`, found by its group of boxes. */
function group(label: string): HTMLElement {
  return screen.getByRole('group', { name: `${label} can also read notes from` });
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

  it('gives each persona and the main assistant one row of real checkboxes that report their state', () => {
    renderSharing({ shares: { [THEO.id]: [personaVaultNamespace('June')] } });

    const theo = within(group('Theo')).getByRole('checkbox', { name: 'June' });
    expect(theo).toBeChecked();
    const june = within(group('June')).getByRole('checkbox', { name: 'Theo' });
    expect(june).not.toBeChecked();
    // The main assistant is listed by its display name, and offered every persona's notes.
    expect(
      within(group('Juniper'))
        .getAllByRole('checkbox')
        .map(box => box.closest('label')?.textContent),
    ).toEqual(['Theo', 'June']);
  });

  it('says "Only its own notes" in muted text after the boxes when nothing is ticked', () => {
    renderSharing({ shares: { [THEO.id]: [personaVaultNamespace('June')] } });

    const juneRow = group('June').closest('li');
    const quiet = within(juneRow ?? document.body).getByText('Only its own notes');
    expect(quiet).toHaveClass('text-text-muted');
    expect(group('June').compareDocumentPosition(quiet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(group('Theo').closest('li') ?? document.body).queryByText('Only its own notes')).toBeNull();
    expect(
      within(group('Juniper').closest('li') ?? document.body).getByText('Only the shared notes'),
    ).toBeInTheDocument();
  });

  it('leaves out the Help persona unless it keeps notes, and then calls it Help', () => {
    const { container } = renderSharing({ personas: [THEO, JUNE, GUIDE] });
    expect(container.textContent).not.toContain(AMAN_GUIDE_NAME);
    expect(screen.queryByRole('group', { name: 'Help can also read notes from' })).toBeNull();
  });

  it('lists the Help persona as Help when it keeps notes of its own', () => {
    renderSharing({ personas: [THEO, JUNE, GUIDE], withNotes: [AMAN_GUIDE_NAME] });
    expect(group('Help')).toBeInTheDocument();
    expect(within(group('Theo')).getByRole('checkbox', { name: 'Help' })).not.toBeChecked();
  });

  it('saves each change as it is made, with no save button, and says Saved', async () => {
    const { onSave } = renderSharing({});
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();

    fireEvent.click(within(group('Juniper')).getByRole('checkbox', { name: 'Theo' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        shares: { [MAIN_ASSISTANT_SHARING_KEY]: [personaVaultNamespace('Theo')] },
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
  });

  it('puts the box back and says what to do when a save fails', async () => {
    renderSharing({ onSave: vi.fn(async () => Promise.reject(new Error('offline'))) });

    const box = within(group('Theo')).getByRole('checkbox', { name: 'June' });
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
