// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MemorySharing } from '@/atoms/memory/MemorySharing.js';
import { personaVaultNamespace } from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';

const ALPHA = { id: 'p-alpha', displayName: 'Alpha' };
const BETA = { id: 'p-beta', displayName: 'Beta' };
const GAMMA = { id: 'p-gamma', displayName: 'Gamma' };

function renderSharing(options: {
  personas?: Array<{ id: string; displayName: string }>;
  namespaces?: Array<{ value: string; label: string }>;
  shares?: Record<string, string[]>;
  onSave?: (sharing: { shares: Record<string, string[]> }) => Promise<void>;
}) {
  const onSave = options.onSave ?? vi.fn(async () => undefined);
  render(
    <MemorySharing
      personas={options.personas ?? [ALPHA, BETA, GAMMA]}
      namespaces={options.namespaces ?? []}
      sharing={{ shares: options.shares ?? {} }}
      onSave={onSave}
    />,
  );
  return { onSave };
}

function chip(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

function row(displayName: string): HTMLElement {
  const list = screen.getByRole('list', { name: 'Memory sharing by specialist' });
  const match = within(list)
    .getAllByRole('listitem')
    .find(item => within(item).queryByText(displayName, { selector: 'span' }) !== null);
  if (match === undefined) throw new Error(`No row for ${displayName}`);
  return match;
}

describe('MemorySharing', () => {
  it('renders one row per specialist, with a chip for each other specialist only', () => {
    renderSharing({});

    const rows = within(screen.getByRole('list', { name: 'Memory sharing by specialist' })).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(row('Alpha')).getAllByRole('button')).toHaveLength(2);
    expect(within(row('Alpha')).getByRole('button', { name: "Alpha can see Beta's memories" })).toBeTruthy();
    expect(within(row('Alpha')).getByRole('button', { name: "Alpha can see Gamma's memories" })).toBeTruthy();
    expect(screen.queryByRole('button', { name: "Alpha can see Alpha's memories" })).toBeNull();
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(6);
  });

  it('marks granted chips as pressed and the rest as not pressed', () => {
    renderSharing({ shares: { [ALPHA.id]: [personaVaultNamespace('Beta')] } });

    expect(chip("Alpha can see Beta's memories").getAttribute('aria-pressed')).toBe('true');
    expect(chip("Alpha can see Gamma's memories").getAttribute('aria-pressed')).toBe('false');
    expect(chip("Beta can see Alpha's memories").getAttribute('aria-pressed')).toBe('false');
  });

  it('shows a quiet None label only on rows with nothing turned on', () => {
    renderSharing({ shares: { [ALPHA.id]: [personaVaultNamespace('Beta')] } });

    expect(within(row('Alpha')).queryByText('None')).toBeNull();
    expect(within(row('Beta')).getByText('None')).toBeTruthy();
    expect(within(row('Gamma')).getByText('None')).toBeTruthy();
  });

  it('shows the check mark only on pressed chips', () => {
    renderSharing({ shares: { [ALPHA.id]: [personaVaultNamespace('Beta')] } });

    expect(chip("Alpha can see Beta's memories").querySelector('svg')).not.toBeNull();
    expect(chip("Alpha can see Gamma's memories").querySelector('svg')).toBeNull();
  });

  it('toggles a chip and saves granted specialists keyed by specialist id', async () => {
    const { onSave } = renderSharing({});

    fireEvent.click(chip("Alpha can see Beta's memories"));
    expect(chip("Alpha can see Beta's memories").getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip("Gamma can see Alpha's memories"));
    fireEvent.click(screen.getByRole('button', { name: 'Save sharing' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      shares: { [ALPHA.id]: [personaVaultNamespace('Beta')], [GAMMA.id]: [personaVaultNamespace('Alpha')] },
    });
    expect(await screen.findByText('Sharing saved.')).toBeTruthy();
  });

  it('drops a specialist from the saved config once its last chip is turned off', async () => {
    const { onSave } = renderSharing({ shares: { [ALPHA.id]: [personaVaultNamespace('Beta')] } });

    fireEvent.click(chip("Alpha can see Beta's memories"));
    expect(chip("Alpha can see Beta's memories").getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Save sharing' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ shares: {} }));
  });

  it('offers topic memories as chips on every row next to the specialists', () => {
    renderSharing({ personas: [ALPHA, BETA], namespaces: [{ value: 'finance', label: 'finance' }] });

    expect(within(row('Alpha')).getAllByRole('button')).toHaveLength(2);
    expect(chip('Alpha can see the finance memories')).toBeTruthy();
    expect(chip('Beta can see the finance memories')).toBeTruthy();
  });

  it('puts topic chips on their own line labelled Topics, apart from the specialist chips', () => {
    renderSharing({ personas: [ALPHA, BETA], namespaces: [{ value: 'finance', label: 'finance' }] });

    const topics = within(row('Alpha')).getByRole('group', { name: 'Topics Alpha can see' });
    expect(within(topics).getByText('Topics:')).toBeTruthy();
    expect(within(topics).getAllByRole('button')).toHaveLength(1);
    expect(within(row('Alpha')).getByRole('group', { name: 'What Alpha can see' }).textContent).not.toContain(
      'Topics:',
    );
  });

  it('keeps grants for memories it no longer lists', async () => {
    const { onSave } = renderSharing({
      personas: [ALPHA, BETA],
      shares: { [ALPHA.id]: ['persona:Retired'] },
    });

    fireEvent.click(chip("Alpha can see Beta's memories"));
    fireEvent.click(screen.getByRole('button', { name: 'Save sharing' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ shares: { [ALPHA.id]: ['persona:Retired', 'persona:Beta'] } }),
    );
  });

  it('says so on the row when there is no other specialist to share with', () => {
    renderSharing({ personas: [ALPHA] });

    expect(screen.queryAllByRole('button', { name: /can see/ })).toHaveLength(0);
    expect(screen.getByText('No other specialists to share with yet.')).toBeTruthy();
  });

  it('explains there is nothing to share when no specialist exists', () => {
    renderSharing({ personas: [] });

    expect(screen.getByText('No specialists are set up yet, so there is nothing to share.')).toBeTruthy();
  });
});
