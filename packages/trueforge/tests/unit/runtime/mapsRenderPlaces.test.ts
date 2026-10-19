import { FetchedPageStore } from '@truefoundry/trueforge-core/core';
import { isCallToolResponseResult, type CallToolResponse } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { createLogger } from 'winston';
import { MapsService, mapsCapability, renderPlaces } from '../../../src/runtime/mapsCapability';
import { unusedRoadProviders, unusedTransitProvider } from '../../fixtures/mapsProviders';

const HARBOUR_URL = 'https://harbour-clinic.example/en';
const GARDEN_URL = 'https://garden-health.example/doctors';
const HARBOUR_TEXT =
  'Harbour Family Clinic\n12 Example Street, Lisbon 1100-000\nLanguages: English, Portuguese\n' +
  'Opening hours: Mon-Fri 9:00-18:00\nConsultation 60 EUR\nPhone +351 210 000 111\n';
const GARDEN_TEXT = 'Garden Health Centre, 4 Sample Avenue, Lisbon 1200-000. We speak English and French.';

const harbour = {
  name: 'Harbour Family Clinic',
  address: '12 Example Street, Lisbon 1100-000',
  languages: 'English, Portuguese',
  hours: 'Mon-Fri 9:00-18:00',
  price: 'Consultation 60 EUR',
  phone: '+351 210 000 111',
  source_url: HARBOUR_URL,
};
const garden = {
  name: 'Garden Health Centre',
  address: '4 Sample Avenue, Lisbon 1200-000',
  languages: 'English and French',
  source_url: GARDEN_URL,
};

function setup(geocode: (query: string) => unknown[]) {
  const asked: string[] = [];
  const service = new MapsService({
    geocoder_url: 'https://geocode.example',
    road_providers: unusedRoadProviders(),
    transit_provider: unusedTransitProvider(),
    logger: createLogger({ silent: true }),
    fetch_limited: url => {
      const query = new URL(url).searchParams.get('q') ?? '';
      asked.push(query);
      return Promise.resolve(new Response(JSON.stringify(geocode(query))));
    },
  });
  const pages = new FetchedPageStore({ now: () => Date.parse('2026-10-17T10:00:00Z'), ttlMs: 60_000, maxPages: 10 });
  pages.remember({ url: HARBOUR_URL, text: HARBOUR_TEXT });
  pages.remember({ url: GARDEN_URL, text: GARDEN_TEXT });
  return { service, pages, asked };
}

const hit = (lat: string, lon: string, name: string) => [
  { lat, lon, display_name: name, address: {}, boundingbox: [lat, lat, lon, lon] },
];

function bodyOf(response: CallToolResponse): { body: Record<string, unknown>; isError: boolean } {
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a tool result');
  }
  const block = response.result.content?.[0];
  const parsed: unknown = JSON.parse(block?.type === 'text' ? block.text : '{}');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected an object');
  }
  return { body: Object.fromEntries(Object.entries(parsed)), isError: response.result.isError === true };
}

describe('render_places', () => {
  it('pins each grounded place with its checked details, source, server fetch time and no calendar mark', async () => {
    const { service, pages, asked } = setup(query => hit('38.7', '-9.1', query));
    const { body, isError } = bodyOf(
      await renderPlaces({ service, pages, input: { places: [harbour], calendar_locations: [] } }),
    );
    expect(isError).toBe(false);
    expect(asked).toEqual(['12 Example Street, Lisbon 1100-000']);
    expect(body['status']).toBe('ok');
    expect(body['attribution']).toBe('© OpenStreetMap contributors');
    expect(body['places']).toEqual([
      {
        ...harbour,
        source_site: 'harbour-clinic.example',
        fetched_at: '2026-10-17T10:00:00.000Z',
        lat: 38.7,
        lng: -9.1,
        already_in_calendar: false,
      },
    ]);
  });

  it('leaves out a detail the page does not state, and never shows the invented one', async () => {
    const { service, pages } = setup(query => hit('38.7', '-9.1', query));
    const response = await renderPlaces({
      service,
      pages,
      input: { places: [{ ...harbour, price: 'Always free', phone: '+351 999 999 999' }], calendar_locations: [] },
    });
    const { body } = bodyOf(response);
    expect(body['places']).toEqual([
      expect.objectContaining({ price: null, phone: null, hours: 'Mon-Fri 9:00-18:00' }),
    ]);
    expect(JSON.stringify(body)).not.toContain('Always free');
    expect(JSON.stringify(body)).not.toContain('999');
  });

  it('refuses a place whose source page was never read, and sends nothing to the geocoder for it', async () => {
    const { service, pages, asked } = setup(query => hit('38.7', '-9.1', query));
    const { body } = bodyOf(
      await renderPlaces({
        service,
        pages,
        input: { places: [harbour, { ...garden, source_url: 'https://elsewhere.example/' }], calendar_locations: [] },
      }),
    );
    expect(asked).toEqual(['12 Example Street, Lisbon 1100-000']);
    expect(body['places']).toHaveLength(1);
    expect(body['refused']).toEqual([
      { name: 'Garden Health Centre', reason: 'Aman has not read that page, so the details cannot be checked.' },
    ]);
  });

  it('says plainly when nothing could be checked', async () => {
    const { service, pages, asked } = setup(query => hit('38.7', '-9.1', query));
    const { body, isError } = bodyOf(
      await renderPlaces({
        service,
        pages,
        input: { places: [{ ...harbour, name: 'Invented Clinic' }], calendar_locations: [] },
      }),
    );
    expect(isError).toBe(true);
    expect(body).toMatchObject({ status: 'error', code: 'not_grounded' });
    expect(asked).toEqual([]);
  });

  it('names every refused place and its reason when nothing could be checked', async () => {
    const { service, pages } = setup(query => hit('38.7', '-9.1', query));
    const { body, isError } = bodyOf(
      await renderPlaces({
        service,
        pages,
        input: { places: [{ ...harbour, name: 'Invented Clinic' }], calendar_locations: [] },
      }),
    );
    expect(isError).toBe(true);
    expect(body['refused']).toEqual([{ name: 'Invented Clinic', reason: 'The name is not on that page.' }]);
  });

  it('pins a place read from a page whose address uses abbreviations', async () => {
    const { service, pages } = setup(query => hit('29.9', '-90.1', '916 St Andrew Street, New Orleans'));
    pages.remember({
      url: 'https://hope-house.example/',
      text: 'Hope House\n916 St. Andrew Street, New Orleans\nA food pantry open to everyone.',
    });
    const { body, isError } = bodyOf(
      await renderPlaces({
        service,
        pages,
        input: {
          places: [
            {
              name: 'Hope House',
              address: '916 St Andrew St, New Orleans',
              source_url: 'http://hope-house.example',
            },
          ],
          calendar_locations: [],
        },
      }),
    );
    expect(isError).toBe(false);
    expect(body['places']).toEqual([expect.objectContaining({ name: 'Hope House', lat: 29.9, lng: -90.1 })]);
  });

  it('refuses a geocoder result in a different city than the address', async () => {
    const { service, pages } = setup(() => hit('40.6', '-73.9', 'Harbour Family Clinic, Brooklyn, New York'));
    const { body, isError } = bodyOf(
      await renderPlaces({ service, pages, input: { places: [harbour], calendar_locations: [] } }),
    );
    expect(isError).toBe(true);
    expect(body).toMatchObject({ status: 'error', code: 'not_grounded' });
    expect(body['refused']).toEqual([
      { name: 'Harbour Family Clinic', reason: 'The place the map found is in a different area.' },
    ]);
  });

  it('keeps the good places and refuses only the one the map put in a different city', async () => {
    const { service, pages } = setup(query =>
      query.includes('Sample')
        ? hit('38.7', '-9.1', query)
        : hit('40.6', '-73.9', 'Harbour Family Clinic, Brooklyn, New York'),
    );
    const { body } = bodyOf(
      await renderPlaces({ service, pages, input: { places: [harbour, garden], calendar_locations: [] } }),
    );
    expect(body['places']).toEqual([expect.objectContaining({ name: 'Garden Health Centre' })]);
    expect(body['refused']).toEqual([
      { name: 'Harbour Family Clinic', reason: 'The place the map found is in a different area.' },
    ]);
  });

  it('marks a place already in the calendar and keeps it', async () => {
    const { service, pages } = setup(query => hit('38.7', '-9.1', query));
    const { body } = bodyOf(
      await renderPlaces({
        service,
        pages,
        input: { places: [harbour, garden], calendar_locations: ['Harbour Family Clinic, Lisbon'] },
      }),
    );
    expect(body['places']).toEqual([
      expect.objectContaining({ name: 'Harbour Family Clinic', already_in_calendar: true }),
      expect.objectContaining({ name: 'Garden Health Centre', already_in_calendar: false }),
    ]);
  });

  it('keeps a place the geocoder cannot find, without a pin', async () => {
    const { service, pages } = setup(() => []);
    const { body } = bodyOf(
      await renderPlaces({ service, pages, input: { places: [harbour], calendar_locations: [] } }),
    );
    expect(body['places']).toEqual([expect.objectContaining({ name: 'Harbour Family Clinic', lat: null, lng: null })]);
  });

  it('reports an unreachable geocoder as a maps error', async () => {
    const service = new MapsService({
      geocoder_url: 'https://geocode.example',
      road_providers: unusedRoadProviders(),
      transit_provider: unusedTransitProvider(),
      logger: createLogger({ silent: true }),
      fetch_limited: () => Promise.reject(new Error('down')),
    });
    const pages = new FetchedPageStore({ now: Date.now, ttlMs: 60_000, maxPages: 10 });
    pages.remember({ url: HARBOUR_URL, text: HARBOUR_TEXT });
    const { body, isError } = bodyOf(
      await renderPlaces({ service, pages, input: { places: [harbour], calendar_locations: [] } }),
    );
    expect(isError).toBe(true);
    expect(body).toMatchObject({ status: 'error', code: 'service_unavailable', service: 'geocoder' });
  });
});

describe('render_places tool definition', () => {
  async function tool() {
    const server = mapsCapability({ tracing: NOOP_AGENT_TRACING, logger: createLogger({ silent: true }) })
      .systemToolSets?.[0];
    const listed = await server?.listTools();
    const tools = listed !== undefined && 'result' in listed ? listed.result.tools : [];
    const found = tools.find(candidate => candidate.name === 'render_places');
    if (server === undefined || found === undefined) {
      throw new Error('render_places is not offered');
    }
    return { server, found };
  }

  it('is offered with every bound at or under 128 and no pattern', async () => {
    const { found } = await tool();
    const schema = JSON.stringify(found.inputSchema);
    expect(schema).not.toMatch(/"pattern"/);
    for (const [, value] of schema.matchAll(/"(?:maxLength|maxItems|minLength|minItems)"\s*:\s*(\d+)/g)) {
      expect(Number(value)).toBeLessThanOrEqual(128);
    }
    expect(schema).toContain('"maxItems":3');
  });

  it('rejects more than three places, an unknown field and an over-long value before doing anything', async () => {
    const { server } = await tool();
    const four = Array.from({ length: 4 }, () => harbour);
    for (const args of [
      { places: four },
      { places: [{ ...harbour, extra: 1 }] },
      { places: [{ ...harbour, hours: 'x'.repeat(129) }] },
      { places: [] },
    ]) {
      const { isError } = bodyOf(await server.callTool({ name: 'render_places', arguments: args }));
      expect(isError).toBe(true);
    }
  });
});
