import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MapCard, type MapCardData } from '@/components/MapCard.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';

type MapCardProps = Parameters<typeof MapCard>[0];

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
  address: 'Eiffel Tower, Paris, France',
  pins: [{ name: 'Cafe Paris', lat: 48.86, lng: 2.295 }],
  attribution: '© OpenStreetMap contributors',
};

describe('MapCard', () => {
  it('renders the place name and attribution', () => {
    renderCard({ data: placeData, state: 'ready', cardId: 'call-1' });
    expect(screen.getByTestId('map-card')).toBeInTheDocument();
    expect(screen.getAllByText('Eiffel Tower, Paris, France')).toHaveLength(2);
    expect(screen.getByText('© OpenStreetMap contributors')).toBeInTheDocument();
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

  it('renders the blocked state with a message', () => {
    renderCard({ data: null, state: 'blocked', cardId: 'call-3', blockedMessage: 'Rate limited.' });
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('Map unavailable')).toBeInTheDocument();
    expect(screen.getByText('Rate limited.')).toBeInTheDocument();
  });

  it('renders the unavailable state', () => {
    renderCard({ data: null, state: 'unavailable', cardId: 'call-4' });
    expect(screen.getByText('Map could not load')).toBeInTheDocument();
  });

  it('renders blocked when data is null even in ready state', () => {
    renderCard({ data: null, state: 'ready', cardId: 'call-5' });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
