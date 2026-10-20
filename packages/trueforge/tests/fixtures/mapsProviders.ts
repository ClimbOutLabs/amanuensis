import type { MapsRoadMode, MapsRoutingProvider } from '../../src/runtime/mapsCapability';
import type { MapsTransitProvider } from '../../src/runtime/mapsTransit';

/** Road providers for a test that only geocodes: any route request fails. */
export function unusedRoadProviders(): Record<MapsRoadMode, MapsRoutingProvider> {
  const unused: MapsRoutingProvider = {
    provider_id: 'unused',
    route: () => Promise.reject(new Error('unused')),
  };
  return { walking: unused, cycling: unused, driving: unused };
}

/** Transit provider for a test that never plans a public transport trip. */
export function unusedTransitProvider(): MapsTransitProvider {
  return { plan: () => Promise.reject(new Error('unused')) };
}
