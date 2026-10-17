/**
 * Invented places for the grounded finder, in the response shapes Tavily's /search and /extract
 * and the Nominatim geocoder return (checked against the live services). No real business, person
 * or number appears here, and CI never calls the live services: `installRecordedTavily` answers
 * them from these recordings.
 */
export const FIND_PLACES_QUERY = 'English speaking doctor Lisbon';

export const HARBOUR_URL = 'https://harbour-clinic.example/en';
export const GARDEN_URL = 'https://garden-health.example/doctors';
export const CANAL_URL = 'https://canal-practice.example/about';

export const HARBOUR_ADDRESS = '12 Example Street, Lisbon 1100-000';
export const GARDEN_ADDRESS = '4 Sample Avenue, Lisbon 1200-000';

const HARBOUR_TEXT =
  'Harbour Family Clinic\n12 Example Street, Lisbon 1100-000\nLanguages: English, Portuguese\n' +
  'Opening hours: Mon-Fri 9:00-18:00\nConsultation 60 EUR\nPhone +351 210 000 111\n';
const GARDEN_TEXT =
  'Garden Health Centre, 4 Sample Avenue, Lisbon 1200-000. We speak English and French. Open daily 8:00-20:00.';

export const recordedSearch = {
  query: FIND_PLACES_QUERY,
  follow_up_questions: null,
  answer: null,
  images: [],
  results: [
    { url: HARBOUR_URL, title: 'Harbour Family Clinic', content: 'English speaking family doctors.', score: 0.86 },
    { url: GARDEN_URL, title: 'Garden Health Centre', content: 'Doctors who speak English.', score: 0.83 },
    { url: CANAL_URL, title: 'Canal Practice', content: 'A practice by the canal.', score: 0.8 },
  ],
  response_time: 1.2,
  request_id: 'recorded-search-1',
};

export const recordedExtract = {
  results: [
    { url: HARBOUR_URL, title: 'Harbour Family Clinic', raw_content: HARBOUR_TEXT, images: [] },
    { url: GARDEN_URL, title: 'Garden Health Centre', raw_content: GARDEN_TEXT, images: [] },
  ],
  failed_results: [],
  response_time: 0.9,
  request_id: 'recorded-extract-1',
};

const geocoderHits: Record<string, { lat: string; lon: string }> = {
  [HARBOUR_ADDRESS]: { lat: '38.7071', lon: '-9.1359' },
  [GARDEN_ADDRESS]: { lat: '38.7223', lon: '-9.1393' },
};

/** What the scripted model sends to render_places: the page text copied exactly, plus one invented price. */
export const scriptedPlaces = [
  {
    name: 'Harbour Family Clinic',
    address: HARBOUR_ADDRESS,
    languages: 'English, Portuguese',
    hours: 'Mon-Fri 9:00-18:00',
    price: 'Consultation 60 EUR',
    phone: '+351 210 000 111',
    source_url: HARBOUR_URL,
  },
  {
    name: 'Garden Health Centre',
    address: GARDEN_ADDRESS,
    languages: 'English and French',
    hours: 'Open daily 8:00-20:00',
    price: 'Free consultations',
    source_url: GARDEN_URL,
  },
];

export interface RecordedCall {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Routes calls to Tavily and the public geocoder to the recordings above and lets every other
 * request, such as the scripted model on localhost, through untouched.
 */
export function installRecordedTavily(): { calls: RecordedCall[]; restore: () => void } {
  const realFetch = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'api.tavily.com') {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({
        host: url.hostname,
        path: url.pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body,
      });
      return Promise.resolve(Response.json(url.pathname === '/search' ? recordedSearch : recordedExtract));
    }
    if (url.hostname === 'nominatim.openstreetmap.org') {
      const hit = geocoderHits[url.searchParams.get('q') ?? ''];
      return Promise.resolve(
        Response.json(
          hit === undefined
            ? []
            : [
                {
                  ...hit,
                  display_name: url.searchParams.get('q'),
                  address: {},
                  boundingbox: [hit.lat, hit.lat, hit.lon, hit.lon],
                },
              ],
        ),
      );
    }
    return realFetch(input, init);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}
