// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function toggle(name: string): HTMLElement {
  return screen.getByRole('switch', { name });
}

describe('MemorySharing', () => {
  it('offers one toggle per other persona vault, derived from the persona list', () => {
    renderSharing({});

    expect(screen.getAllByRole('switch')).toHaveLength(6);
    expect(toggle("Alpha can read Beta's vault")).toBeTruthy();
    expect(toggle("Alpha can read Gamma's vault")).toBeTruthy();
    expect(toggle("Beta can read Alpha's vault")).toBeTruthy();
    expect(toggle("Gamma can read Beta's vault")).toBeTruthy();
    expect(screen.queryByRole('switch', { name: "Alpha can read Alpha's vault" })).toBeNull();
  });

  it('shows the saved grants as on and everything else as off', () => {
    renderSharing({ shares: { [ALPHA.id]: [personaVaultNamespace('Beta')] } });

    expect(toggle("Alpha can read Beta's vault").getAttribute('aria-checked')).toBe('true');
    expect(toggle("Alpha can read Gamma's vault").getAttribute('aria-checked')).toBe('false');
    expect(toggle("Beta can read Alpha's vault").getAttribute('aria-checked')).toBe('false');
  });

  it('saves granted persona vaults keyed by persona id', async () => {
    const { onSave } = renderSharing({});

    fireEvent.click(toggle("Alpha can read Beta's vault"));
    fireEvent.click(toggle("Gamma can read Alpha's vault"));
    fireEvent.click(screen.getByRole('button', { name: 'Save sharing' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      shares: { [ALPHA.id]: ['persona:Beta'], [GAMMA.id]: ['persona:Alpha'] },
    });
    expect(await screen.findByText('Sharing saved.')).toBeTruthy();
  });

  it('drops a persona from the saved config once its last grant is turned off', async () => {
    const { onSave } = renderSharing({ shares: { [ALPHA.id]: ['persona:Beta'] } });

    fireEvent.click(toggle("Alpha can read Beta's vault"));
    fireEvent.click(screen.getByRole('button', { name: 'Save sharing' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ shares: {} }));
  });

  it('offers topic vaults to every persona next to the persona vaults', () => {
    renderSharing({ personas: [ALPHA, BETA], namespaces: [{ value: 'finance', label: 'finance' }] });

    expect(screen.getAllByRole('switch')).toHaveLength(4);
    expect(toggle('Alpha can read the finance vault')).toBeTruthy();
    expect(toggle('Beta can read the finance vault')).toBeTruthy();
  });

  it('keeps grants for vaults it no longer lists', async () => {
    const { onSave } = renderSharing({
      personas: [ALPHA, BETA],
      shares: { [ALPHA.id]: ['persona:Retired'] },
    });

    fireEvent.click(toggle("Alpha can read Beta's vault"));
    fireEvent.click(screen.getByRole('button', { name: 'Save sharing' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ shares: { [ALPHA.id]: ['persona:Retired', 'persona:Beta'] } }),
    );
  });

  it('says so instead of rendering an empty box when a persona has nothing to read', () => {
    renderSharing({ personas: [ALPHA] });

    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.getByText('No other vaults to read yet.')).toBeTruthy();
  });

  it('explains there is nothing to share when no persona exists', () => {
    renderSharing({ personas: [] });

    expect(screen.getByText('No personas are configured yet, so there is nothing to share with.')).toBeTruthy();
  });
});
