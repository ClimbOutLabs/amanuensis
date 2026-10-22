import { FetchedPageStore, type FetchedPageScope } from '@truefoundry/trueforge-core/core';
import { isCallToolResponseResult, type CallToolResponse } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { createLogger } from 'winston';
import { mapsCapability, MapsService, PlaceRefusalLedger, renderPlaces } from '../../../src/runtime/mapsCapability';
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

const SCOPE: FetchedPageScope = { tenant_id: 'tenant-1', conversation_id: 'chat-a' };
const OTHER_SCOPE: FetchedPageScope = { tenant_id: 'tenant-1', conversation_id: 'chat-b' };
const AREA_REASON =
  'The place the map found is in a different area. Try again with a fuller address, adding the town or postcode.';

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
  pages.remember({ scope: SCOPE, url: HARBOUR_URL, text: HARBOUR_TEXT });
  pages.remember({ scope: SCOPE, url: GARDEN_URL, text: GARDEN_TEXT });
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
      await renderPlaces({
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
        input: { places: [harbour], calendar_locations: [] },
      }),
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
      retries: new PlaceRefusalLedger(),
      service,
      pages,
      scope: SCOPE,
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
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
        input: { places: [harbour, { ...garden, source_url: 'https://elsewhere.example/' }], calendar_locations: [] },
      }),
    );
    expect(asked).toEqual(['12 Example Street, Lisbon 1100-000']);
    expect(body['places']).toHaveLength(1);
    expect(body['refused']).toEqual([
      {
        name: 'Garden Health Centre',
        reason: 'Aman has not read that page, so the details cannot be checked. Read that page first, then try again.',
      },
    ]);
  });

  it('refuses a place whose source page was read in a different chat, with the plain not read reason', async () => {
    const { service, pages, asked } = setup(query => hit('38.7', '-9.1', query));
    pages.remember({ scope: OTHER_SCOPE, url: 'https://elsewhere.example/', text: HARBOUR_TEXT });
    const { body } = bodyOf(
      await renderPlaces({
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
        input: { places: [{ ...harbour, source_url: 'https://elsewhere.example/' }], calendar_locations: [] },
      }),
    );
    expect(asked).toEqual([]);
    expect(body).toMatchObject({ status: 'error', code: 'not_grounded' });
    expect(body['refused']).toEqual([
      {
        name: 'Harbour Family Clinic',
        reason: 'Aman has not read that page, so the details cannot be checked. Read that page first, then try again.',
      },
    ]);
  });

  it('says plainly when nothing could be checked', async () => {
    const { service, pages, asked } = setup(query => hit('38.7', '-9.1', query));
    const { body, isError } = bodyOf(
      await renderPlaces({
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
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
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
        input: { places: [{ ...harbour, name: 'Invented Clinic' }], calendar_locations: [] },
      }),
    );
    expect(isError).toBe(true);
    expect(body['refused']).toEqual([
      {
        name: 'Invented Clinic',
        reason: 'The name is not on that page. Copy it word for word from the page and try again.',
      },
    ]);
  });

  it('pins a place read from a page whose address uses abbreviations', async () => {
    const { service, pages } = setup(() => hit('29.9', '-90.1', '916 St Andrew Street, New Orleans'));
    pages.remember({
      scope: SCOPE,
      url: 'https://hope-house.example/',
      text: 'Hope House\n916 St. Andrew Street, New Orleans\nA food pantry open to everyone.',
    });
    const { body, isError } = bodyOf(
      await renderPlaces({
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
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
      await renderPlaces({
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
        input: { places: [harbour], calendar_locations: [] },
      }),
    );
    expect(isError).toBe(true);
    expect(body).toMatchObject({ status: 'error', code: 'not_grounded' });
    expect(body['refused']).toEqual([{ name: 'Harbour Family Clinic', reason: AREA_REASON }]);
  });

  it('refuses the place whose geocoder hit landed in a different state, and keeps the one in the state asked for', async () => {
    const moUrl = 'https://springfield-clinic-mo.example/';
    const ilUrl = 'https://springfield-clinic-il.example/';
    const illinoisHit = 'Springfield Clinic, 102 Main St, Springfield, Illinois, United States';
    const service = new MapsService({
      geocoder_url: 'https://geocode.example',
      road_providers: unusedRoadProviders(),
      transit_provider: unusedTransitProvider(),
      logger: createLogger({ silent: true }),
      // The geocoder's best hit for both addresses is the Illinois clinic of the same name.
      fetch_limited: () => Promise.resolve(new Response(JSON.stringify(hit('39.7', '-89.6', illinoisHit)))),
    });
    const pages = new FetchedPageStore({ now: () => Date.parse('2026-10-17T10:00:00Z'), ttlMs: 60_000, maxPages: 10 });
    pages.remember({ scope: SCOPE, url: moUrl, text: 'Springfield Clinic\n102 Main St, Springfield, Missouri' });
    pages.remember({ scope: SCOPE, url: ilUrl, text: 'Springfield Clinic\n102 Main St, Springfield, Illinois' });
    const { body, isError } = bodyOf(
      await renderPlaces({
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
        input: {
          places: [
            { name: 'Springfield Clinic', address: '102 Main St, Springfield, Missouri', source_url: moUrl },
            { name: 'Springfield Clinic', address: '102 Main St, Springfield, Illinois', source_url: ilUrl },
          ],
          calendar_locations: [],
        },
      }),
    );
    expect(isError).toBe(false);
    expect(body['places']).toEqual([
      expect.objectContaining({ name: 'Springfield Clinic', address: '102 Main St, Springfield, Illinois' }),
    ]);
    expect(body['refused']).toEqual([{ name: 'Springfield Clinic', reason: AREA_REASON }]);
  });

  it('keeps the good places and refuses only the one the map put in a different city', async () => {
    const { service, pages } = setup(query =>
      query.includes('Sample')
        ? hit('38.7', '-9.1', query)
        : hit('40.6', '-73.9', 'Harbour Family Clinic, Brooklyn, New York'),
    );
    const { body } = bodyOf(
      await renderPlaces({
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
        input: { places: [harbour, garden], calendar_locations: [] },
      }),
    );
    expect(body['places']).toEqual([expect.objectContaining({ name: 'Garden Health Centre' })]);
    expect(body['refused']).toEqual([{ name: 'Harbour Family Clinic', reason: AREA_REASON }]);
  });

  it('marks a place already in the calendar and keeps it', async () => {
    const { service, pages } = setup(query => hit('38.7', '-9.1', query));
    const { body } = bodyOf(
      await renderPlaces({
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
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
      await renderPlaces({
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
        input: { places: [harbour], calendar_locations: [] },
      }),
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
    pages.remember({ scope: SCOPE, url: HARBOUR_URL, text: HARBOUR_TEXT });
    const { body, isError } = bodyOf(
      await renderPlaces({
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
        input: { places: [harbour], calendar_locations: [] },
      }),
    );
    expect(isError).toBe(true);
    expect(body).toMatchObject({ status: 'error', code: 'service_unavailable', service: 'geocoder' });
  });
});

describe('render_places tool definition', () => {
  async function tool() {
    const server = mapsCapability({
      tracing: NOOP_AGENT_TRACING,
      logger: createLogger({ silent: true }),
      pages_scope: SCOPE,
      starts_answer: true,
    }).systemToolSets?.[0];
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

describe('render_places with search results and the retry limit', () => {
  const SEARCH_URL = 'https://listings.example/harbour-clinic';
  const ledgerRun = (
    retries: PlaceRefusalLedger,
    service: MapsService,
    pages: FetchedPageStore,
    claim: typeof harbour,
  ) =>
    renderPlaces({ service, pages, scope: SCOPE, retries, input: { places: [claim], calendar_locations: [] } }).then(
      bodyOf,
    );

  it('pins a place whose name and address are in one search result', async () => {
    const { service, pages, asked } = setup(query => hit('38.7', '-9.1', query));
    pages.rememberQuery({ scope: SCOPE, query: 'English speaking doctor Lisbon' });
    pages.rememberSnippet({
      scope: SCOPE,
      url: SEARCH_URL,
      text: 'Harbour Family Clinic\nRated 4.5. 12 Example Street, Lisbon 1100-000.',
    });
    const { body } = await bodyOf(
      await renderPlaces({
        retries: new PlaceRefusalLedger(),
        service,
        pages,
        scope: SCOPE,
        input: {
          places: [{ name: harbour.name, address: harbour.address, source_url: SEARCH_URL }],
          calendar_locations: [],
        },
      }),
    );
    expect(body).toMatchObject({ status: 'ok', places: [{ name: 'Harbour Family Clinic', source_url: SEARCH_URL }] });
    expect(asked).toHaveLength(1);
  });

  it('lets a refused place go once more, then tells the model to stop trying the map', async () => {
    const { service, pages, asked } = setup(query => hit('38.7', '-9.1', query));
    const retries = new PlaceRefusalLedger();
    const claim = { ...harbour, name: 'Harbour Clinic Lisbon' };
    const first = await ledgerRun(retries, service, pages, claim);
    expect(first.body).toMatchObject({ status: 'error', refused: [{ name: claim.name }] });
    expect(first.body).not.toHaveProperty('stop');
    const second = await ledgerRun(retries, service, pages, claim);
    expect(second.body).toHaveProperty('stop');
    const third = await ledgerRun(retries, service, pages, claim);
    expect(third.body).toMatchObject({
      refused: [
        { name: claim.name, reason: 'This place was refused twice in this answer. Stop trying the map for it.' },
      ],
    });
    expect(third.body).toHaveProperty('stop');
    expect(asked).toHaveLength(0);
  });

  it('starts a new answer with a fresh retry for the same place', async () => {
    const { service, pages } = setup(query => hit('38.7', '-9.1', query));
    const retries = new PlaceRefusalLedger();
    const claim = { ...harbour, name: 'Harbour Clinic Lisbon' };
    await ledgerRun(retries, service, pages, claim);
    await ledgerRun(retries, service, pages, claim);
    retries.startAnswer(SCOPE);
    const next = await ledgerRun(retries, service, pages, claim);
    expect(next.body).not.toHaveProperty('stop');
    expect(next.body).toMatchObject({ refused: [{ reason: expect.stringContaining('not on that page') }] });
  });

  it('counts refusals by place, so a new link or address each time still runs out', async () => {
    const { service, pages, asked } = setup(query => hit('38.7', '-9.1', query));
    const retries = new PlaceRefusalLedger();
    const bodies = [];
    for (let at = 0; at < 5; at += 1) {
      const claim = { ...harbour, address: `${at} Example Street, Lisbon`, source_url: `${HARBOUR_URL}/${at}` };
      bodies.push((await ledgerRun(retries, service, pages, claim)).body);
    }
    expect(bodies[0]).not.toHaveProperty('stop');
    for (const body of bodies.slice(1)) {
      expect(body).toHaveProperty('stop');
    }
    expect(asked).toHaveLength(0);
  });

  it('keeps the count across an approval that resumes the same answer', async () => {
    const scope: FetchedPageScope = { tenant_id: 'tenant-1', conversation_id: 'chat-approval' };
    const call = async (starts_answer: boolean) => {
      const server = mapsCapability({
        tracing: NOOP_AGENT_TRACING,
        logger: createLogger({ silent: true }),
        pages_scope: scope,
        starts_answer,
      }).systemToolSets?.[0];
      if (server === undefined) {
        throw new Error('maps is not offered');
      }
      const claim = { ...harbour, source_url: 'https://never-read.example/clinic' };
      return bodyOf(
        await server.callTool(
          { name: 'render_places', arguments: { places: [claim], calendar_locations: [] } },
          { status: 'allow' },
        ),
      ).body;
    };
    expect(await call(true)).not.toHaveProperty('stop');
    // The approved retry arrives as a new request with no new message from the person.
    expect(await call(false)).toHaveProperty('stop');
    expect(await call(true)).not.toHaveProperty('stop');
  });
});
