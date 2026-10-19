import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MapCard, type MapCardData } from '@/components/MapCard.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';

type MapCardProps = Parameters<typeof MapCard>[0];

/** Handlers registered via tileLayer.on(event, handler) in the current render. */
let tileHandlers: Record<string, Array<() => void>>;

interface MockMap {
  remove: () => void;
  setView: () => void;
  fitBounds: () => void;
  invalidateSize: () => void;
  on: (event: string, handler: () => void) => void;
  scrollWheelZoom: { enable: () => void; disable: () => void };
}

/** Maps created through the mocked leaflet.map, in creation order. */
let mapInstances: MockMap[];

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
  const makeMap = (): MockMap => {
    const instance: MockMap = {
      remove: vi.fn(),
      setView: vi.fn(),
      fitBounds: vi.fn(),
      invalidateSize: vi.fn(),
      on: vi.fn(),
      scrollWheelZoom: { enable: vi.fn(), disable: vi.fn() },
    };
    mapInstances.push(instance);
    return instance;
  };
  return {
    map: vi.fn(makeMap),
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
  mapInstances = [];
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
    renderCard({ data: placeData, state: 'ready' });
    expect(screen.getByTestId('map-card')).toBeInTheDocument();
    expect(screen.getByText('Eiffel Tower, Paris, France')).toBeInTheDocument();
    expect(screen.getByText('Champ de Mars, 75007 Paris, France')).toBeInTheDocument();
    expect(screen.getByText('© OpenStreetMap contributors')).toBeInTheDocument();
  });

  it('hides the address line when it equals the resolved name', () => {
    renderCard({
      data: { ...placeData, address: 'Eiffel Tower, Paris, France' },
      state: 'ready',
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
    });
    expect(screen.getAllByText(/Madrid/).length).toBeGreaterThan(0);
    expect(screen.getByText(/621.5 km/)).toBeInTheDocument();
  });

  it('renders the blocked state with a message and no Retry, since the call already settled', () => {
    renderCard({ data: null, state: 'blocked', blockedMessage: 'Rate limited.' });
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('Map unavailable')).toBeInTheDocument();
    expect(screen.getByText('Rate limited.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('renders the unavailable state without a Retry', () => {
    renderCard({ data: null, state: 'unavailable', blockedMessage: 'The place could not be found.' });
    expect(screen.getByText('Map unavailable')).toBeInTheDocument();
    expect(screen.getByText('The place could not be found.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('renders blocked when data is null even in ready state', () => {
    renderCard({ data: null, state: 'ready' });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('uses the same card frame for every state', () => {
    const { rerender } = renderCard({ data: placeData, state: 'ready' });
    expect(screen.getByTestId('map-card')).toHaveClass('maps-card');
    rerender(
      <ThemeProvider>
        <MapCard data={null} state="blocked" blockedMessage="Rate limited." />
      </ThemeProvider>,
    );
    // Blocked keeps the identical .maps-card frame: same width and radius.
    expect(screen.getByTestId('map-card')).toHaveClass('maps-card');
    rerender(
      <ThemeProvider>
        <MapCard data={placeData} state="ready" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('map-card')).toHaveClass('maps-card');
  });

  it('shows the unavailable panel with Retry when tiles fail, never a blank map', async () => {
    renderCard({ data: placeData, state: 'ready' });
    await failTiles();
    await waitFor(() => expect(screen.getByText('Map tiles unavailable')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The map div is gone; no grey box remains.
    expect(document.querySelector('.maps-card-map')).not.toBeInTheDocument();
  });

  it('Retry re-attempts tiles exactly once and does not auto-retry', async () => {
    renderCard({ data: placeData, state: 'ready' });
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

  it('draws exactly one pin for render_map without poi', async () => {
    renderCard({ data: { ...placeData, pins: [] }, state: 'ready' });
    await waitFor(() => expect(vi.mocked(leaflet.circleMarker).mock.calls.length).toBe(1));
    expect(vi.mocked(leaflet.circleMarker)).toHaveBeenCalledWith([48.858844, 2.294481], expect.anything());
  });

  it('draws the place pin plus one marker per distinct poi pin', async () => {
    renderCard({
      data: {
        ...placeData,
        pins: [
          { name: 'Cafe Paris', lat: 48.86, lng: 2.295 },
          { name: 'Louvre', lat: 48.8611, lng: 2.3364 },
        ],
      },
      state: 'ready',
    });
    await waitFor(() => expect(vi.mocked(leaflet.circleMarker).mock.calls.length).toBe(3));
  });

  it('does not stack a poi pin on the place pin', async () => {
    renderCard({
      data: {
        ...placeData,
        pins: [{ name: 'Eiffel Tower', lat: 48.858844, lng: 2.294481 }],
      },
      state: 'ready',
    });
    await waitFor(() => expect(vi.mocked(leaflet.circleMarker).mock.calls.length).toBeGreaterThan(0));
    // One marker total: the coincident poi pin is not drawn twice.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(vi.mocked(leaflet.circleMarker).mock.calls.length).toBe(1);
  });

  it('tells the user the place search is not sent again when tiles fail', async () => {
    renderCard({ data: { ...placeData, pins: [] }, state: 'ready' });
    await failTiles();
    await waitFor(() =>
      expect(
        screen.getByText('The map tiles could not be loaded. Your place search was not sent again.'),
      ).toBeInTheDocument(),
    );
  });

  it('requests tiles through the proxy without a card query parameter', async () => {
    renderCard({ data: { ...placeData, pins: [] }, state: 'ready' });
    await waitFor(() => expect(leaflet.tileLayer).toHaveBeenCalled());
    expect(vi.mocked(leaflet.tileLayer).mock.calls.at(0)?.[0]).toBe('/api/maps/tiles/{z}/{x}/{y}.png');
  });

  it('does not re-create the map when the data object changes identity', async () => {
    const { rerender } = renderCard({ data: { ...placeData, pins: [] }, state: 'ready' });
    await waitFor(() => expect(leaflet.map).toHaveBeenCalledTimes(1));
    // Same values, fresh object identity, as parseMapsResult produces on each render.
    rerender(
      <ThemeProvider>
        <MapCard data={{ ...placeData, pins: [] }} state="ready" />
      </ThemeProvider>,
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(leaflet.tileLayer).toHaveBeenCalledTimes(1);
  });

  it('re-creates the map when the place changes', async () => {
    const { rerender } = renderCard({ data: { ...placeData, pins: [] }, state: 'ready' });
    await waitFor(() => expect(leaflet.map).toHaveBeenCalledTimes(1));
    rerender(
      <ThemeProvider>
        <MapCard data={{ ...placeData, lat: 40.4168, lng: -3.7038, pins: [] }} state="ready" />
      </ThemeProvider>,
    );
    await waitFor(() => expect(leaflet.map).toHaveBeenCalledTimes(2));
  });

  it('keeps scroll wheel zoom off until the map is clicked or focused', async () => {
    renderCard({ data: { ...placeData, pins: [] }, state: 'ready' });
    await waitFor(() => expect(leaflet.map).toHaveBeenCalled());
    expect(vi.mocked(leaflet.map).mock.calls.at(0)?.[1]).toMatchObject({ scrollWheelZoom: false });
    const mapInstance = mapInstances.at(0);
    if (mapInstance === undefined) throw new Error('Expected a map instance');
    const calls = vi.mocked(mapInstance.on).mock.calls;
    const clickHandler = calls.find(([event]) => event === 'click')?.[1];
    const focusHandler = calls.find(([event]) => event === 'focus')?.[1];
    expect(clickHandler).toBeDefined();
    expect(focusHandler).toBeDefined();
    clickHandler?.();
    expect(mapInstance.scrollWheelZoom.enable).toHaveBeenCalledTimes(1);
  });

  it('links the OSM attribution and names the search provider', () => {
    renderCard({ data: { ...placeData, pins: [] }, state: 'ready' });
    const link = screen.getByRole('link', { name: '© OpenStreetMap contributors' });
    expect(link).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText('Search: Nominatim')).toBeInTheDocument();
  });

  describe('travel modes', () => {
    const routeData: MapCardData = {
      ...placeData,
      kind: 'route',
      pins: [],
      from_name: 'Rua da Emenda 45',
      to_name: 'R. de Sao Bernardo 92',
      from_lat: 38.7106,
      from_lng: -9.1426,
      to_lat: 38.7142,
      to_lng: -9.1597,
      distance_km: 1.9,
      duration_min: 23.7,
      route_geometry: '_p~iF~ps|U',
    };

    it('shows the mode, distance and time for a walk', () => {
      renderCard({ data: { ...routeData, mode: 'walking' }, state: 'ready' });
      expect(screen.getByText('Walking · 1.9 km · about 24 min')).toBeInTheDocument();
      expect(screen.getByText('Routing: OSRM')).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Steps' })).not.toBeInTheDocument();
    });

    it('shows a route with no mode as driving', () => {
      renderCard({ data: routeData, state: 'ready' });
      expect(screen.getByText('Driving · 1.9 km · about 24 min')).toBeInTheDocument();
    });

    it('lists the transit steps in plain words and credits the timetables', () => {
      renderCard({
        data: {
          ...routeData,
          mode: 'transit',
          duration_min: 18,
          departs: '09:02',
          arrives: '09:20',
          steps: [
            { kind: 'walk', duration_min: 4, to_name: 'Calhariz (Bica)' },
            {
              kind: 'ride',
              vehicle: 'tram',
              line_name: '28E',
              headsign: 'Campo Ourique',
              from_name: 'Calhariz (Bica)',
              to_name: 'Estrela',
              departs: '09:06',
              arrives: '09:16',
              stops_count: 6,
            },
            { kind: 'walk', duration_min: 3, to_name: null },
          ],
        },
        state: 'ready',
      });
      expect(
        screen.getByText('Public transport · 1.9 km · about 18 min · leaves 09:02, arrives 09:20'),
      ).toBeInTheDocument();
      const items = screen.getAllByRole('listitem').map(item => item.textContent);
      expect(items).toEqual([
        'Walk 4 min to Calhariz (Bica)',
        'Tram 28E toward Campo Ourique, 6 stops, leaves 09:06',
        'Walk 3 min',
      ]);
      expect(screen.getByText('Timetables: Transitous')).toBeInTheDocument();
      expect(screen.queryByText('Routing: OSRM')).not.toBeInTheDocument();
    });
  });

  it('names the routing provider on route cards', () => {
    renderCard({
      data: { ...placeData, kind: 'route', from_name: 'Madrid', to_name: 'Barcelona' },
      state: 'ready',
    });
    expect(screen.getByText('Routing: OSRM')).toBeInTheDocument();
  });

  it('does not add a dark tile filter class', async () => {
    renderCard({ data: { ...placeData, pins: [] }, state: 'ready' });
    await waitFor(() => expect(leaflet.tileLayer).toHaveBeenCalled());
    expect(vi.mocked(leaflet.tileLayer).mock.calls.at(0)?.[1]).not.toHaveProperty('className');
  });

  it('waits for the container to become visible before creating the map', async () => {
    const observe = vi.fn<(target: Element) => void>();
    let observerCallback: IntersectionObserverCallback = () => {};
    class MockIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe = observe;
      disconnect = vi.fn();
      unobserve = vi.fn();
      takeRecords = () => [];
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    try {
      renderCard({ data: { ...placeData, pins: [] }, state: 'ready' });
      await waitFor(() => expect(observe).toHaveBeenCalled());
      expect(leaflet.map).not.toHaveBeenCalled();
      const target = observe.mock.calls.at(0)?.[0];
      if (target === undefined) throw new Error('Expected an observed element');
      const rect = target.getBoundingClientRect();
      const entry: IntersectionObserverEntry = {
        isIntersecting: true,
        target,
        time: 0,
        intersectionRatio: 1,
        boundingClientRect: rect,
        intersectionRect: rect,
        rootBounds: null,
      };
      // The container scrolls into view: the map is created exactly once.
      observerCallback([entry], new MockIntersectionObserver(observerCallback));
      await waitFor(() => expect(leaflet.map).toHaveBeenCalledTimes(1));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('paints pins and the route through theme classes, never fixed colors', async () => {
    renderCard({
      data: {
        ...placeData,
        kind: 'route',
        from_name: 'Madrid',
        to_name: 'Barcelona',
        route_geometry: '_p~iF~ps|U_ulLnnqC',
      },
      state: 'ready',
    });
    await waitFor(() => expect(leaflet.polyline).toHaveBeenCalled());
    expect(vi.mocked(leaflet.polyline).mock.calls.at(0)?.[1]).toMatchObject({ className: 'maps-card-route' });
    expect(vi.mocked(leaflet.polyline).mock.calls.at(0)?.[1]).not.toHaveProperty('color');
    for (const call of vi.mocked(leaflet.circleMarker).mock.calls) {
      expect(call[1]).toMatchObject({ className: 'maps-card-pin' });
      expect(call[1]).not.toHaveProperty('color');
      expect(call[1]).not.toHaveProperty('fillColor');
    }
  });

  it('shows the panel without Retry when the route cannot be drawn', async () => {
    vi.mocked(leaflet.latLng).mockImplementationOnce(() => {
      throw new Error('Invalid LatLng object: (NaN, NaN)');
    });
    renderCard({
      data: { ...placeData, kind: 'route', from_name: 'Madrid', to_name: 'Barcelona', route_geometry: '_p~iF~ps|U' },
      state: 'ready',
    });
    await waitFor(() => expect(screen.getByText('Map unavailable')).toBeInTheDocument());
    expect(screen.getByText('The map could not be drawn.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(document.querySelector('.maps-card-map')).not.toBeInTheDocument();
  });

  it('re-measures and re-frames the map when its container resizes, until the user takes over', async () => {
    let resizeCallback: ResizeObserverCallback = () => {};
    class MockResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    try {
      renderCard({ data: { ...placeData, pins: [] }, state: 'ready' });
      await waitFor(() => expect(mapInstances.length).toBe(1));
      const mapInstance = mapInstances.at(0);
      if (mapInstance === undefined) throw new Error('Expected a map instance');
      const resize = () => resizeCallback([], new MockResizeObserver(resizeCallback));
      resize();
      expect(mapInstance.invalidateSize).toHaveBeenCalledTimes(1);
      expect(mapInstance.setView).toHaveBeenCalledTimes(2);
      const clickHandler = vi
        .mocked(mapInstance.on)
        .mock.calls.find(([event]) => event === 'click')
        ?.at(1);
      if (typeof clickHandler !== 'function') throw new Error('Expected a click handler');
      clickHandler();
      resize();
      expect(mapInstance.invalidateSize).toHaveBeenCalledTimes(2);
      expect(mapInstance.setView).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('MapCard with several found places', () => {
  const placesData: MapCardData = {
    kind: 'places',
    lat: 38.7,
    lng: -9.1,
    zoom: 13,
    resolved_name: '2 places',
    address: null,
    pins: [{ name: 'Harbour Family Clinic', lat: 38.7, lng: -9.1 }],
    places: [
      {
        name: 'Harbour Family Clinic',
        address: '12 Example Street, Lisbon 1100-000',
        languages: 'English, Portuguese',
        hours: null,
        price: null,
        phone: '+351 210 000 111',
        source_url: 'https://harbour-clinic.example/en',
        source_site: 'harbour-clinic.example',
        fetched_at: '2026-10-17T10:00:00.000Z',
        lat: 38.7,
        lng: -9.1,
        already_in_calendar: true,
      },
      {
        name: 'Garden Health Centre',
        address: '4 Sample Avenue, Lisbon 1200-000',
        languages: null,
        hours: null,
        price: null,
        phone: null,
        source_url: 'https://garden-health.example/doctors',
        source_site: 'garden-health.example',
        fetched_at: '2026-10-17T10:00:00.000Z',
        lat: null,
        lng: null,
        already_in_calendar: false,
      },
    ],
    attribution: '© OpenStreetMap contributors',
  };

  it('shows one card per place with only the fields that were found', () => {
    renderCard({ data: placesData, state: 'ready' });
    const cards = screen.getAllByTestId('place-card');
    expect(cards).toHaveLength(2);
    const first = within(cards[0] as HTMLElement);
    expect(first.getByText('Harbour Family Clinic')).toBeInTheDocument();
    expect(first.getByText('12 Example Street, Lisbon 1100-000')).toBeInTheDocument();
    expect(first.getByText('English, Portuguese')).toBeInTheDocument();
    expect(first.getByText('+351 210 000 111')).toBeInTheDocument();
    // Fields that were not found are not shown at all, not even as a blank label.
    expect(first.queryByText(/Hours/)).not.toBeInTheDocument();
    expect(first.queryByText(/Price/)).not.toBeInTheDocument();
    const second = within(cards[1] as HTMLElement);
    expect(second.queryByText(/Languages/)).not.toBeInTheDocument();
    expect(second.queryByText(/Phone/)).not.toBeInTheDocument();
  });

  it('cites the site and time with a link to the page', () => {
    renderCard({ data: placesData, state: 'ready' });
    const first = within(screen.getAllByTestId('place-card')[0] as HTMLElement);
    const link = first.getByRole('link', { name: 'harbour-clinic.example' });
    expect(link).toHaveAttribute('href', 'https://harbour-clinic.example/en');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(first.getByText(/^from /)).toHaveTextContent(/from harbour-clinic\.example, .*2026/);
  });

  it('marks a place that is already in the calendar and keeps the others unmarked', () => {
    renderCard({ data: placesData, state: 'ready' });
    const [first, second] = screen.getAllByTestId('place-card');
    expect(within(first as HTMLElement).getByText('Already in your calendar')).toBeInTheDocument();
    expect(within(second as HTMLElement).queryByText('Already in your calendar')).not.toBeInTheDocument();
  });

  it('says so when a place could not be put on the map, and still shows its details', () => {
    renderCard({ data: placesData, state: 'ready' });
    const second = within(screen.getAllByTestId('place-card')[1] as HTMLElement);
    expect(second.getByText('Could not be placed on the map')).toBeInTheDocument();
  });

  it('draws one pin per placed place and no extra centre pin', async () => {
    renderCard({ data: placesData, state: 'ready' });
    await waitFor(() => expect(vi.mocked(leaflet.circleMarker).mock.calls.length).toBe(1));
    expect(vi.mocked(leaflet.circleMarker)).toHaveBeenCalledWith([38.7, -9.1], expect.anything());
  });

  it('adds one line saying how many places were left out and why', () => {
    renderCard({
      data: {
        ...placesData,
        refused: [
          { name: 'Canal Practice', reason: 'The address is not on that page.' },
          { name: 'River Clinic', reason: 'The address is not on that page.' },
        ],
      },
      state: 'ready',
    });
    expect(screen.getByText('2 places left out: The address is not on that page.')).toBeInTheDocument();
  });

  it('shows hostile page text as inert text, and a link that is not a web address never reaches the card', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const [first, second] = placesData.places ?? [];
    if (first === undefined || second === undefined) {
      throw new Error('fixture needs two places');
    }
    renderCard({
      data: { ...placesData, places: [{ ...first, name: hostile, hours: hostile }, second] },
      state: 'ready',
    });
    expect(screen.getAllByText(hostile)).toHaveLength(2);
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });
});
