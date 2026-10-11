import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MapCard, type MapCardData } from '@/components/MapCard.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';

type MapCardProps = Parameters<typeof MapCard>[0];

/** Handlers registered via tileLayer.on(event, handler) in the current render. */
let tileHandlers: Record<string, Array<() => void>>;

interface MockLayer {
  addTo: (map: unknown) => MockLayer;
  bindPopup?: (el: HTMLElement) => void;
}

function mockLayer(): MockLayer {
  const layer: MockLayer = {
    addTo: () => layer,
  };
  return layer;
}

vi.mock('leaflet', () => {
  const makeTileLayer = () => ({
    on: vi.fn((event: string, handler: () => void) => {
      (tileHandlers[event] ??= []).push(handler);
      return undefined;
    }),
    addTo: vi.fn(),
  });
  return {
    map: vi.fn(() => ({
      remove: vi.fn(),
      setView: vi.fn(),
      fitBounds: vi.fn(),
    })),
    tileLayer: vi.fn(makeTileLayer),
    marker: vi.fn(() => {
      const m = mockLayer();
      m.bindPopup = vi.fn();
      return m;
    }),
    circleMarker: vi.fn(() => {
      const m = mockLayer();
      m.bindPopup = vi.fn();
      return m;
    }),
    polyline: vi.fn(() => mockLayer()),
    latLng: vi.fn((lat: number, lng: number) => ({ lat, lng })),
    latLngBounds: vi.fn(() => ({})),
  };
});

const leaflet = vi.mocked(await import('leaflet'));

function renderCard(props: MapCardProps) {
  return render(
    <ThemeProvider>
      <MapCard {...props} />
    </ThemeProvider>,
  );
}

const placeData: MapCardData = {
  kind: 'place',
  lat: 48.858844,
  lng: 2.294481,
  zoom: 13,
  resolved_name: 'Eiffel Tower, Paris, France',
  address: 'Champ de Mars, 75007 Paris, France',
  pins: [{ name: 'Cafe Paris', lat: 48.86, lng: 2.295 }],
  attribution: '© OpenStreetMap contributors',
};

beforeEach(() => {
  tileHandlers = {};
  vi.clearAllMocks();
});

/** Wait until the component has created its tile layer, then fire n tile errors. */
async function failTiles(count = 3) {
  await waitFor(() => expect(leaflet.tileLayer).toHaveBeenCalled());
  const handlers = tileHandlers['tileerror'] ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    for (const handler of handlers) {
      handler();
    }
  }
}

describe('MapCard', () => {
  it('renders the place name, address, and attribution', () => {
    renderCard({ data: placeData, state: 'ready', cardId: 'call-1' });
    expect(screen.getByTestId('map-card')).toBeInTheDocument();
    expect(screen.getByText('Eiffel Tower, Paris, France')).toBeInTheDocument();
    expect(screen.getByText('Champ de Mars, 75007 Paris, France')).toBeInTheDocument();
    expect(screen.getByText('© OpenStreetMap contributors')).toBeInTheDocument();
  });

  it('hides the address line when it equals the resolved name', () => {
    renderCard({
      data: { ...placeData, address: 'Eiffel Tower, Paris, France' },
      state: 'ready',
      cardId: 'call-1',
    });
    // The name appears exactly once: no duplicate subtitle.
    expect(screen.getAllByText('Eiffel Tower, Paris, France')).toHaveLength(1);
    expect(document.querySelector('.maps-card-subtitle')).not.toBeInTheDocument();
  });

  it('renders a route summary', () => {
    renderCard({
      data: {
        ...placeData,
        kind: 'route',
        from_name: 'Madrid',
        to_name: 'Barcelona',
        distance_km: 621.5,
        duration_min: 360.2,
      },
      state: 'ready',
      cardId: 'call-2',
    });
    expect(screen.getAllByText(/Madrid/).length).toBeGreaterThan(0);
    expect(screen.getByText(/621.5 km/)).toBeInTheDocument();
  });

  it('renders the blocked state with a message and Retry', () => {
    renderCard({ data: null, state: 'blocked', cardId: 'call-3', blockedMessage: 'Rate limited.' });
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('Map unavailable')).toBeInTheDocument();
    expect(screen.getByText('Rate limited.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders the unavailable state', () => {
    renderCard({ data: null, state: 'unavailable', cardId: 'call-4' });
    expect(screen.getByText('Map tiles unavailable')).toBeInTheDocument();
  });

  it('renders blocked when data is null even in ready state', () => {
    renderCard({ data: null, state: 'ready', cardId: 'call-5' });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('uses the same card frame for every state', () => {
    const { rerender } = renderCard({ data: placeData, state: 'ready', cardId: 'call-1' });
    expect(screen.getByTestId('map-card')).toHaveClass('maps-card');
    rerender(
      <ThemeProvider>
        <MapCard data={null} state="blocked" cardId="call-1" blockedMessage="Rate limited." />
      </ThemeProvider>,
    );
    // Blocked keeps the identical .maps-card frame: same width and radius.
    expect(screen.getByTestId('map-card')).toHaveClass('maps-card');
    rerender(
      <ThemeProvider>
        <MapCard data={placeData} state="ready" cardId="call-1" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('map-card')).toHaveClass('maps-card');
  });

  it('shows the unavailable panel with Retry when tiles fail, never a blank map', async () => {
    renderCard({ data: placeData, state: 'ready', cardId: 'call-1' });
    await failTiles();
    await waitFor(() => expect(screen.getByText('Map tiles unavailable')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The map div is gone; no grey box remains.
    expect(document.querySelector('.maps-card-map')).not.toBeInTheDocument();
  });

  it('Retry re-attempts tiles exactly once and does not auto-retry', async () => {
    renderCard({ data: placeData, state: 'ready', cardId: 'call-1' });
    await failTiles();
    await waitFor(() => expect(screen.getByText('Map tiles unavailable')).toBeInTheDocument());
    const callsAfterFailure = vi.mocked(leaflet.tileLayer).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // One new tile layer: a single user-initiated re-attempt.
    await waitFor(() => expect(vi.mocked(leaflet.tileLayer).mock.calls.length).toBe(callsAfterFailure + 1));
    expect(screen.queryByText('Map tiles unavailable')).not.toBeInTheDocument();
    // No further tile layers appear without another click: no auto-retry.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(vi.mocked(leaflet.tileLayer).mock.calls.length).toBe(callsAfterFailure + 1);
  });

  it('calls onRetry when provided instead of retrying tiles internally', async () => {
    const onRetry = vi.fn();
    renderCard({ data: null, state: 'blocked', cardId: 'call-3', blockedMessage: 'Rate limited.', onRetry });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
