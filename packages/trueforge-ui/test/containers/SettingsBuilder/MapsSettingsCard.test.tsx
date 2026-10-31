// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import MapsSettingsCard from '@/containers/SettingsBuilder/MapsSettingsCard.js';
import {
  MAPS_SERVER_FIELD_IDS,
  type MapsServerFieldId,
  type MapsSettingsState,
  type MapsSettingsUpdate,
  type MapsSetupPort,
} from '@/server/mapsSetup.js';

function asInput(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) {
    throw new Error('expected an input element');
  }
  return element;
}

function fieldState(value: string | null, defaultUrl: string, setByEnvironment = false) {
  return { value, defaultUrl, setByEnvironment };
}

function stateOf(overrides: Partial<Record<MapsServerFieldId, ReturnType<typeof fieldState>>> = {}): MapsSettingsState {
  return {
    router: fieldState(null, 'https://router.project-osrm.org'),
    walking: fieldState(null, 'https://routing.openstreetmap.de/routed-foot'),
    cycling: fieldState(null, 'https://routing.openstreetmap.de/routed-bike'),
    geocoder: fieldState(null, 'https://nominatim.openstreetmap.org'),
    transit: fieldState(null, 'https://api.transitous.org/api/v6'),
    tile: fieldState(null, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
    ...overrides,
  };
}

function portWith(state: MapsSettingsState, calls: { updates: MapsSettingsUpdate[] }): MapsSetupPort {
  return {
    getMapsSettings: async () => state,
    updateMapsSettings: async (update: MapsSettingsUpdate) => {
      calls.updates.push(update);
      const next = { ...state };
      for (const key of MAPS_SERVER_FIELD_IDS) {
        const value = update[key];
        if (value !== undefined) {
          next[key] = { ...next[key], value };
        }
      }
      return next;
    },
    testMapsSettings: async () => ({
      router: { ok: true, message: null },
      walking: { ok: true, message: null },
      cycling: { ok: true, message: null },
      geocoder: {
        ok: false,
        message: "The address search server didn't answer. Check the address and that the server is running.",
      },
      transit: { ok: true, message: null },
      tile: { ok: true, message: null },
    }),
  };
}

describe('MapsSettingsCard', () => {
  it('shows the six fields with the defaults as placeholders', async () => {
    const calls: { updates: MapsSettingsUpdate[] } = { updates: [] };
    render(<MapsSettingsCard port={portWith(stateOf(), calls)} />);
    const driving = await screen.findByLabelText('Driving routes');
    expect(driving.getAttribute('placeholder')).toBe('https://router.project-osrm.org');
    expect(screen.getByLabelText('Map pictures').getAttribute('placeholder')).toBe(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    );
    expect(screen.getByText(/Maps use free public OpenStreetMap services/)).toBeTruthy();
  });

  it('shows a field set by the environment read-only, with its label', async () => {
    const calls: { updates: MapsSettingsUpdate[] } = { updates: [] };
    const state = stateOf({
      geocoder: fieldState('https://geo.internal.example.com', 'https://nominatim.openstreetmap.org', true),
    });
    render(<MapsSettingsCard port={portWith(state, calls)} />);
    const geocoder = asInput(await screen.findByLabelText('Address search'));
    expect(geocoder.value).toBe('https://geo.internal.example.com');
    expect(geocoder.readOnly).toBe(true);
    expect(screen.getByText('Set by the server environment')).toBeTruthy();
  });

  it('saves a typed address and clears it again with Reset to default', async () => {
    const calls: { updates: MapsSettingsUpdate[] } = { updates: [] };
    render(<MapsSettingsCard port={portWith(stateOf(), calls)} />);
    const driving = asInput(await screen.findByLabelText('Driving routes'));
    fireEvent.change(driving, { target: { value: 'https://osrm.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.updates).toEqual([{ router: 'https://osrm.example.com' }]));

    fireEvent.click(screen.getAllByRole('button', { name: 'Reset to default' })[0] ?? document.body);
    expect(driving.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.updates).toEqual([{ router: 'https://osrm.example.com' }, { router: null }]));
  });

  it('shows the problem under the field that has it and saves nothing', async () => {
    const calls: { updates: MapsSettingsUpdate[] } = { updates: [] };
    render(<MapsSettingsCard port={portWith(stateOf(), calls)} />);
    const tile = await screen.findByLabelText('Map pictures');
    fireEvent.change(tile, { target: { value: 'https://tile.example.org/tile.png' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        'The map pictures address needs {z}, {x} and {y} in it, like https://tile.example.org/{z}/{x}/{y}.png.',
      ),
    ).toBeTruthy();
    expect(calls.updates).toEqual([]);
  });

  it('shows each test result next to its field', async () => {
    const calls: { updates: MapsSettingsUpdate[] } = { updates: [] };
    render(<MapsSettingsCard port={portWith(stateOf(), calls)} />);
    await screen.findByLabelText('Driving routes');
    fireEvent.click(screen.getByRole('button', { name: 'Test connections' }));
    await waitFor(() => expect(screen.getAllByText('ok').length).toBeGreaterThan(0));
    expect(
      screen.getByText("The address search server didn't answer. Check the address and that the server is running."),
    ).toBeTruthy();
  });

  it('renders nothing when the read is refused, as it is for a non-admin', async () => {
    const port: MapsSetupPort = {
      getMapsSettings: async () => {
        throw new Error('Admin access required.');
      },
      updateMapsSettings: async () => stateOf(),
      testMapsSettings: async () => {
        throw new Error('Admin access required.');
      },
    };
    const { container } = render(<MapsSettingsCard port={port} />);
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(screen.queryByLabelText('Driving routes')).toBeNull();
  });
});
