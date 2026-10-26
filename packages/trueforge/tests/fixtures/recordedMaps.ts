/**
 * Answers the default maps upstreams from invented recordings: the geocoder's place search and the driving
 * router's route. Every other request reaches whatever fetch was installed before it.
 */
import configuration from '../../src/config';

/** Coarse coordinates of the invented home city, as a forecast page link carries them. */
export const HOME_CITY = { name: 'San Diego, California', lat: '32.72', lon: '-117.16' };
export const AIRPORT = { name: 'San Diego International Airport', lat: '32.73', lon: '-117.19' };

/** A 12-minute, 8 km drive. The geometry is a valid two-point polyline. */
const ROUTE = { code: 'Ok', routes: [{ distance: 8_000, duration: 720, geometry: '_p~iF~ps|U_ulLnnqC' }] };

export function installRecordedMaps(): { routeCalls: () => number; restore: () => void } {
  const previous = globalThis.fetch;
  const geocoder = new URL(configuration.MAPS_GEOCODER_URL);
  const router = new URL(configuration.MAPS_ROUTER_URL);
  let routes = 0;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.host === geocoder.host && url.pathname.endsWith('/search')) {
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      const hit = query.includes('airport') ? AIRPORT : query.includes('san diego') ? HOME_CITY : undefined;
      return Promise.resolve(
        Response.json(
          hit === undefined
            ? []
            : [
                {
                  lat: hit.lat,
                  lon: hit.lon,
                  display_name: hit.name,
                  address: {},
                  boundingbox: [hit.lat, hit.lat, hit.lon, hit.lon],
                },
              ],
        ),
      );
    }
    if (url.host === router.host && url.pathname.includes('/route/v1/')) {
      routes += 1;
      return Promise.resolve(Response.json(ROUTE));
    }
    return previous(input, init);
  };
  return {
    routeCalls: () => routes,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}
