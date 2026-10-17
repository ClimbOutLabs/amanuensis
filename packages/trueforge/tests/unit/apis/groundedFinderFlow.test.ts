/**
 * The grounded finder over the real server path: a scripted model searches with Tavily, reads two
 * result pages, and asks to pin what it found. Tavily and the geocoder answer from recordings, so
 * the test sees exactly what the approval cards say and what the pins carry.
 */
import { z } from '@hono/zod-openapi';
import { type Turn, type TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { ListSessionEventsResponseSchema, TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import {
  FIND_PLACES_QUERY,
  GARDEN_ADDRESS,
  GARDEN_URL,
  HARBOUR_ADDRESS,
  HARBOUR_URL,
  installRecordedTavily,
} from '../../fixtures/groundedFinderFixtures';
import { FIND_PLACES_DIRECTIVE, RUN_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;
const TAVILY_SERVER_NAME = 'tavily';

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Find places with Tavily and pin them.',
  mcp_servers: [{ name: TAVILY_SERVER_NAME, preload: true }],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createSession(server: ApprovalTestServer): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

async function runTurn({
  server,
  sessionId,
  input,
  previousTurnId,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  input: TurnInputItem[];
  previousTurnId?: string;
}): Promise<Turn> {
  const response = await server.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit({ input, stream: true, ...(previousTurnId === undefined ? {} : { previous_turn_id: previousTurnId }) }),
  );
  if (response.status !== 200) {
    throw new Error(`create turn failed (${String(response.status)}): ${JSON.stringify(await response.json())}`);
  }
  let turnId: string | undefined;
  for (const line of (await response.text()).split('\n')) {
    if (line.startsWith('data: ')) {
      const event = TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length)));
      if (event.type === 'turn.created') {
        turnId = event.turn_id;
      }
    }
  }
  if (turnId === undefined) {
    throw new Error('turn stream carried no turn.created event');
  }
  const turn = await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`);
  return GetTurnResponseSchema.parse(await turn.json()).data;
}

type RequiredAction = Extract<Turn['state'], { status: 'done' }>['required_actions'][number];
type PendingCall = Extract<RequiredAction, { type: 'tool.approval_required' }>['tool_calls'][number];

/** The one call a paused turn waits on, with the thread it belongs to. */
function pendingCall(turn: Turn): { thread_id: string; call: PendingCall } | undefined {
  if (turn.state.status !== 'done') {
    throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
  }
  for (const action of turn.state.required_actions) {
    if (action.type === 'tool.approval_required' && action.tool_calls[0] !== undefined) {
      return { thread_id: action.thread_id, call: action.tool_calls[0] };
    }
  }
  return undefined;
}

async function approve({
  server,
  sessionId,
  paused,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  paused: Turn;
}): Promise<Turn> {
  const pending = pendingCall(paused);
  if (pending === undefined) {
    throw new Error('expected the turn to wait for approval');
  }
  return runTurn({
    server,
    sessionId,
    previousTurnId: paused.id,
    input: [
      {
        type: 'user.tool_approval',
        thread_id: pending.thread_id,
        tool_call_id: pending.call.id,
        approval: { status: 'allow' },
      },
    ],
  });
}

const ToolResponseSchema = z.object({
  type: z.enum(['tool.response', 'tool.response.v2']),
  tool_call_id: z.string(),
  content: z.string(),
});

async function toolResponseTexts(server: ApprovalTestServer, sessionId: string): Promise<string[]> {
  const response = await server.request(`/api/v1/sessions/${sessionId}/events`);
  const events = ListSessionEventsResponseSchema.parse(await response.json()).data;
  return events.flatMap(item => {
    const parsed = ToolResponseSchema.safeParse(item.event);
    return parsed.success ? [parsed.data.content] : [];
  });
}

/** The payload of the pin tool's result, unwrapped from the host's response envelope. */
function placesPayload(texts: readonly string[]): { places: Record<string, unknown>[] } {
  const found = texts.find(text => text.includes('already_in_calendar'));
  if (found === undefined) {
    throw new Error('no pin result in the session');
  }
  const envelope: unknown = JSON.parse(found);
  const result = z.object({ result: z.unknown() }).loose().safeParse(envelope);
  const inner = result.success ? result.data.result : envelope;
  const payload: unknown = typeof inner === 'string' ? JSON.parse(inner) : inner;
  return z
    .object({ places: z.array(z.record(z.string(), z.unknown())) })
    .loose()
    .parse(payload);
}

describe('grounded finder over the real server path', () => {
  let server: ApprovalTestServer;
  let recorded: ReturnType<typeof installRecordedTavily>;

  async function setSearchWithoutAsking(value: boolean) {
    const response = await server.request(
      '/api/v1/user/settings/sentinel',
      jsonInit({ search_without_asking: value }, 'PATCH'),
    );
    expect(response.status).toBe(200);
  }

  beforeAll(async () => {
    server = await startApprovalTestServer();
    recorded = installRecordedTavily();
    // Picking the Tavily preset as the web search provider, as the settings page does. The key is
    // the preset's untouched placeholder, so the finder goes keyless.
    const saved = await server.request(
      '/api/v1/settings/mcp-servers',
      jsonInit(
        {
          manifest: {
            type: 'remote',
            name: TAVILY_SERVER_NAME,
            url: 'https://mcp.tavily.com/mcp',
            description: 'Search the web, extract page content, and crawl sites.',
            search_provider: true,
            auth: { type: 'header', headers: { Authorization: 'Bearer YOUR_TAVILY_API_KEY' } },
          },
        },
        'PUT',
      ),
    );
    expect(saved.status).toBe(200);
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    recorded.restore();
    await server.close();
  });

  beforeEach(async () => {
    recorded.calls.length = 0;
    await setSearchWithoutAsking(true);
  });

  it(
    'searches, reads two pages, asks before pinning, then pins only the details the pages state, with sources',
    async () => {
      const sessionId = await createSession(server);
      const paused = await runTurn({
        server,
        sessionId,
        input: [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${FIND_PLACES_DIRECTIVE} please` }],
      });

      // One search then one batched extract, keyless because no key was saved.
      expect(recorded.calls.map(call => call.path)).toEqual(['/search', '/extract']);
      expect(recorded.calls[0]?.headers['x-tavily-access-mode']).toBe('keyless');
      expect(recorded.calls[0]?.headers['authorization']).toBeUndefined();
      expect(recorded.calls[0]?.body).toMatchObject({ query: FIND_PLACES_QUERY, search_depth: 'advanced' });
      expect(recorded.calls[1]?.body).toMatchObject({ urls: [HARBOUR_URL, GARDEN_URL] });

      // The pin call waits for the user, naming the addresses and where they go.
      const pending = pendingCall(paused);
      expect(pending?.call.tier3_card?.plain_what).toContain(`"${HARBOUR_ADDRESS}"`);
      expect(pending?.call.tier3_card?.plain_what).toContain(`"${GARDEN_ADDRESS}"`);
      expect(pending?.call.tier3_card?.destination_host).toContain('nominatim.openstreetmap.org');

      const done = await approve({ server, sessionId, paused });
      expect(pendingCall(done)).toBeUndefined();
      const { places } = placesPayload(await toolResponseTexts(server, sessionId));
      expect(places).toHaveLength(2);
      expect(places[0]).toMatchObject({
        name: 'Harbour Family Clinic',
        languages: 'English, Portuguese',
        price: 'Consultation 60 EUR',
        phone: '+351 210 000 111',
        source_site: 'harbour-clinic.example',
        lat: 38.7071,
        already_in_calendar: false,
      });
      // The invented price on the second place is not on its page, so it is left out.
      expect(places[1]).toMatchObject({ name: 'Garden Health Centre', price: null, phone: null });
      expect(typeof places[1]?.['fetched_at']).toBe('string');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'asks before the search when searches are set to Ask, with the words, host, endpoint and credits',
    async () => {
      await setSearchWithoutAsking(false);
      const sessionId = await createSession(server);
      const first = await runTurn({
        server,
        sessionId,
        input: [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${FIND_PLACES_DIRECTIVE} please` }],
      });
      expect(recorded.calls).toEqual([]);
      const searchCard = pendingCall(first)?.call.tier3_card;
      expect(searchCard?.plain_what).toContain(FIND_PLACES_QUERY);
      expect(searchCard?.plain_what).toContain('api.tavily.com');
      expect(searchCard?.plain_what).toContain('/search');
      expect(searchCard?.plain_what).toContain('2 Tavily credits');

      const second = await approve({ server, sessionId, paused: first });
      expect(recorded.calls.map(call => call.path)).toEqual(['/search']);
      const extractCard = pendingCall(second)?.call.tier3_card;
      expect(extractCard?.plain_what).toContain(HARBOUR_URL);
      expect(extractCard?.plain_what).toContain(GARDEN_URL);
      expect(extractCard?.plain_what).toContain('/extract');
      expect(extractCard?.plain_what).toContain('1 Tavily credit');
    },
    TURN_TIMEOUT_MS,
  );
});
