/**
 * Walks Aman's safety rules through the real server, one chat at a time, with a scripted model.
 * Each test reads what the card offers and what was saved, never how the rule is built.
 */
import { z } from '@hono/zod-openapi';
import type { Turn, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { createServer, type Server } from 'node:http';
import configuration from '../../../src/config';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { INERT_GET_PAGE_TOOL, INERT_SERVER_NAME, INERT_WRITE_TOOL } from '../../fixtures/inertMcpServer';
import {
  RUN_DIRECTIVE_PREFIX,
  SCRIPTED_EVENT,
  SCRIPTED_PERSONA,
  SCRIPTED_SCHEDULE,
} from '../../fixtures/scriptedModelServer';
import { StandInSandbox } from '../../fixtures/standInSandbox';

const TURN_TIMEOUT_MS = 60_000;

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Do exactly what is asked.',
  mcp_servers: [
    { name: INERT_SERVER_NAME, preload: true, require_approval_for_tools: ['@write', '@destructive', '@unclassified'] },
  ],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createChat(server: ApprovalTestServer, spec: object = AGENT_SPEC): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

/** Sends one turn and returns the answer the server gave, so a refusal can be read too. */
async function sendTurn({
  server,
  chatId,
  input,
}: {
  server: ApprovalTestServer;
  chatId: string;
  input: TurnInputItem[];
}): Promise<Response> {
  return server.request(
    `/api/v1/sessions/${chatId}/turns`,
    jsonInit({ input, stream: true, client_timezone: 'Europe/London' }),
  );
}

/** Runs one turn to its end and returns the saved turn. */
async function runTurn({
  server,
  chatId,
  input,
}: {
  server: ApprovalTestServer;
  chatId: string;
  input: TurnInputItem[];
}): Promise<Turn> {
  const response = await sendTurn({ server, chatId, input });
  if (response.status !== 200) {
    throw new Error(`create turn failed (${String(response.status)}): ${await response.text()}`);
  }
  const created = (await response.text())
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length))))
    .find(event => event.type === 'turn.created');
  if (created === undefined) {
    throw new Error('the turn stream carried no turn.created event');
  }
  const saved = await server.request(`/api/v1/sessions/${chatId}/turns/${created.turn_id}`);
  return GetTurnResponseSchema.parse(await saved.json()).data;
}

function ask(tool: string): TurnInputItem[] {
  return [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${tool} please` }];
}

/** The cards a finished turn is waiting on. */
function cards(turn: Turn) {
  if (turn.state.status !== 'done') {
    throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
  }
  return turn.state.required_actions.flatMap(action =>
    action.type === 'tool.approval_required'
      ? action.tool_calls.map(call => ({ ...call, thread_id: action.thread_id }))
      : [],
  );
}

/** The one card a finished turn is waiting on. */
function onlyCard(turn: Turn) {
  const [card, ...others] = cards(turn);
  if (card === undefined || others.length > 0) {
    throw new Error(`expected one card, found ${String(cards(turn).length)}`);
  }
  return card;
}

function answer({ card, scope }: { card: { thread_id: string; id: string }; scope: 'once' | 'chat' }): TurnInputItem[] {
  return [
    {
      type: 'user.tool_approval',
      thread_id: card.thread_id,
      tool_call_id: card.id,
      approval: { status: 'allow', scope },
    },
  ];
}

async function draftCount(server: ApprovalTestServer): Promise<number> {
  return (await server.evalSources().gmail.listDrafts({ maxResults: 10, pageToken: undefined })).draftIds.length;
}

async function savedNames({ server, path }: { server: ApprovalTestServer; path: string }): Promise<string> {
  const response = await server.request(path);
  expect(response.status).toBe(200);
  return response.text();
}

describe('"Always allow this here" is offered only when the card names who or where the action goes', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it(
    'creating a schedule asks every time, and a chat-wide answer is refused',
    async () => {
      const chatId = await createChat(server);
      const first = onlyCard(await runTurn({ server, chatId, input: ask('create_schedule') }));
      expect(first.can_chat_allow).toBe(false);

      const refused = await sendTurn({ server, chatId, input: answer({ card: first, scope: 'chat' }) });
      expect(refused.status).toBe(422);
      expect(await savedNames({ server, path: '/api/v1/schedules' })).not.toContain(SCRIPTED_SCHEDULE.name);

      const allowed = await runTurn({ server, chatId, input: answer({ card: first, scope: 'once' }) });
      expect(cards(allowed)).toEqual([]);
      expect(await savedNames({ server, path: '/api/v1/schedules' })).toContain(SCRIPTED_SCHEDULE.name);

      const again = onlyCard(await runTurn({ server, chatId, input: ask('create_schedule') }));
      expect(again.can_chat_allow).toBe(false);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'creating a persona takes no chat-wide answer',
    async () => {
      const chatId = await createChat(server);
      const first = onlyCard(await runTurn({ server, chatId, input: ask('create_persona') }));
      expect(first.can_chat_allow).toBe(false);

      const refused = await sendTurn({ server, chatId, input: answer({ card: first, scope: 'chat' }) });
      expect(refused.status).toBe(422);
      expect(await savedNames({ server, path: '/api/v1/personas' })).not.toContain(SCRIPTED_PERSONA.name);

      await runTurn({ server, chatId, input: answer({ card: first, scope: 'once' }) });
      expect(await savedNames({ server, path: '/api/v1/personas' })).toContain(SCRIPTED_PERSONA.name);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'a connector change whose card names no place offers only Approve and Deny',
    async () => {
      const chatId = await createChat(server);
      const card = onlyCard(await runTurn({ server, chatId, input: ask(INERT_WRITE_TOOL) }));
      expect(card.can_chat_allow).toBe(false);
      expect(card.can_always_allow).toBe(false);

      const refused = await sendTurn({ server, chatId, input: answer({ card, scope: 'chat' }) });
      expect(refused.status).toBe(422);
      expect(server.mcp.writeInvocations()).toBe(0);
    },
    TURN_TIMEOUT_MS,
  );
});

describe('an email address the person never gave', () => {
  let server: ApprovalTestServer;
  const ADDRESS = 'dana.reyes@harbour.example';
  const DRAFT = { to: [ADDRESS], subject: 'Bread order', body: 'Hi Dana, could I order two loaves for Saturday?' };

  beforeAll(async () => {
    server = await startApprovalTestServer();
    server.setEvalMode(true);
  });

  afterAll(async () => {
    await server.close();
  });

  it(
    'a draft to an address only an earlier reply named says so on its card',
    async () => {
      const draftsBefore = await draftCount(server);
      const chatId = await createChat(server);
      server.model.next({ reply: `Dana Reyes runs the bakery. Her address is ${ADDRESS}.` });
      await runTurn({ server, chatId, input: [{ type: 'user.message', content: 'Who runs the bakery?' }] });

      server.model.next({ toolArguments: DRAFT });
      const card = onlyCard(await runTurn({ server, chatId, input: ask('draft_email') }));
      expect(card.tier3_card?.plain_what).toContain(
        `This goes to ${ADDRESS}, whose address was only in an earlier reply from Aman, not in your own words.`,
      );
      expect(card.can_chat_allow).toBe(false);
      expect(await draftCount(server)).toBe(draftsBefore);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'a draft to an address the person wrote themselves shows the plain card',
    async () => {
      const chatId = await createChat(server);
      server.model.next({ reply: `Dana Reyes runs the bakery. Her address is ${ADDRESS}.` });
      await runTurn({ server, chatId, input: [{ type: 'user.message', content: 'Who runs the bakery?' }] });

      server.model.next({ toolArguments: DRAFT });
      const card = onlyCard(
        await runTurn({
          server,
          chatId,
          input: [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}draft_email to ${ADDRESS} please` }],
        }),
      );
      expect(card.tier3_card?.plain_what).not.toContain('earlier reply');
    },
    TURN_TIMEOUT_MS,
  );
});

describe('an address with a sign-in name before the site', () => {
  let server: ApprovalTestServer;
  let browser: Server;
  const opened: string[] = [];
  const original = {
    BROWSER_ENABLED: configuration.BROWSER_ENABLED,
    BROWSER_URL: configuration.BROWSER_URL,
    BROWSER_SECRET: configuration.BROWSER_SECRET,
  };

  beforeAll(async () => {
    // Stands in for Aman's browser: it notes each address it is asked to open and returns a short page.
    browser = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = z
          .object({ url: z.string().optional() })
          .loose()
          .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (req.url === '/open' && body.url !== undefined) {
          opened.push(body.url);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', text: '# Account' }));
      });
    });
    await new Promise<void>(resolve => {
      browser.listen(0, '127.0.0.1', resolve);
    });
    const address = browser.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the stand-in browser did not bind a port');
    }
    Object.assign(configuration, {
      BROWSER_ENABLED: true,
      BROWSER_URL: `http://127.0.0.1:${String(address.port)}`,
      BROWSER_SECRET: 'stand-in-browser-secret-for-tests',
    });
    server = await startApprovalTestServer();
  });

  afterAll(async () => {
    await server.close();
    Object.assign(configuration, original);
    await new Promise<void>(resolve => {
      browser.close(() => resolve());
    });
  });

  it(
    'once a page has been read, the address the person gave still opens, and the same address with a sign-in name asks first',
    async () => {
      const chatId = await createChat(server);
      const askToOpen: TurnInputItem[] = [
        { type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}browser_open https://site.example/account` },
      ];

      server.model.next({ toolArguments: { url: 'https://site.example/account' } });
      expect(cards(await runTurn({ server, chatId, input: askToOpen }))).toEqual([]);
      expect(opened).toEqual(['https://site.example/account']);

      server.model.next({ toolArguments: { url: 'https://site.example/account' } });
      expect(cards(await runTurn({ server, chatId, input: askToOpen }))).toEqual([]);
      expect(opened).toHaveLength(2);

      server.model.next({ toolArguments: { url: 'https://sam@site.example/account' } });
      const card = onlyCard(await runTurn({ server, chatId, input: askToOpen }));
      expect(card.tier3_card?.destination).toBe('https://sam@site.example/account');
      expect(opened).toHaveLength(2);
    },
    TURN_TIMEOUT_MS,
  );
});

const SANDBOX_AGENT_SPEC = { ...AGENT_SPEC, config: { ...AGENT_SPEC.config, sandbox: { enabled: true } } };

describe('running code in the sandbox', () => {
  /** Asks for one piece of code to be run, and says whether a card came up and whether the run was let through. */
  async function runCode({ sandbox, withoutAsking }: { sandbox: StandInSandbox; withoutAsking: boolean }) {
    const server = await startApprovalTestServer({ sandboxProvider: sandbox });
    try {
      const saved = await server.request('/api/v1/user/settings/sentinel', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandbox_without_asking: withoutAsking }),
      });
      expect(saved.status).toBe(200);
      const chatId = await createChat(server, SANDBOX_AGENT_SPEC);
      server.model.next({ toolArguments: { code: 'print(1)', language: 'python' } });
      const turn = await runTurn({ server, chatId, input: ask('run_code') });
      return {
        asked: cards(turn).map(card => card.tier3_card?.plain_what),
        letThrough: turn.state.status === 'done' && turn.state.metrics?.tool_calls_by_tool?.['run_code'] === 1,
      };
    } finally {
      await server.close();
    }
  }

  it(
    'runs without a card when "run without asking" is on and the sandbox has no network',
    async () => {
      const ran = await runCode({ sandbox: new StandInSandbox('none'), withoutAsking: true });
      expect(ran).toEqual({ asked: [], letThrough: true });
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'asks first when "run without asking" is on and the sandbox can reach a network',
    async () => {
      const held = await runCode({ sandbox: new StandInSandbox(undefined), withoutAsking: true });
      expect(held).toEqual({ asked: ['Run code the assistant wrote in the sandbox?'], letThrough: false });
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'asks first when "run without asking" is off',
    async () => {
      const held = await runCode({ sandbox: new StandInSandbox('none'), withoutAsking: false });
      expect(held).toEqual({ asked: ['Run code the assistant wrote in the sandbox?'], letThrough: false });
    },
    TURN_TIMEOUT_MS,
  );
});

describe("an event on the person's own calendar", () => {
  let server: ApprovalTestServer;
  const GUEST = 'lin.park@harbour.example';

  /** How many events on the scripted day carry the scripted title. */
  async function savedEvents(): Promise<number> {
    const day = SCRIPTED_EVENT.start.slice(0, 10);
    const found = await server.evalSources().calendar.listEvents({
      timeMin: `${day}T00:00:00`,
      timeMax: `${day}T23:59:59`,
      query: SCRIPTED_EVENT.title,
      maxResults: 10,
      pageToken: undefined,
      timeZone: SCRIPTED_EVENT.time_zone,
    });
    return found.events.length;
  }

  beforeAll(async () => {
    server = await startApprovalTestServer();
    server.setEvalMode(true);
  });

  afterAll(async () => {
    await server.close();
  });

  it(
    'with no guests offers "Always allow this here", and the answer covers the next one in that chat only',
    async () => {
      const before = await savedEvents();
      const chatId = await createChat(server);
      const card = onlyCard(await runTurn({ server, chatId, input: ask('create_event') }));
      expect(card.can_chat_allow).toBe(true);

      await runTurn({ server, chatId, input: answer({ card, scope: 'chat' }) });
      expect(cards(await runTurn({ server, chatId, input: ask('create_event') }))).toEqual([]);
      expect(await savedEvents()).toBe(before + 2);

      const otherChatId = await createChat(server);
      onlyCard(await runTurn({ server, chatId: otherChatId, input: ask('create_event') }));
      expect(await savedEvents()).toBe(before + 2);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'with a guest asks every time, also after a chat-wide answer for events without guests',
    async () => {
      const before = await savedEvents();
      const chatId = await createChat(server);
      const plain = onlyCard(await runTurn({ server, chatId, input: ask('create_event') }));
      await runTurn({ server, chatId, input: answer({ card: plain, scope: 'chat' }) });

      server.model.next({ toolArguments: { ...SCRIPTED_EVENT, attendees: [GUEST], send_updates: 'none' } });
      const withGuest = onlyCard(
        await runTurn({
          server,
          chatId,
          input: [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}create_event and invite ${GUEST}` }],
        }),
      );
      expect(withGuest.can_chat_allow).toBe(false);
      const refused = await sendTurn({ server, chatId, input: answer({ card: withGuest, scope: 'chat' }) });
      expect(refused.status).toBe(422);
      expect(await savedEvents()).toBe(before + 1);
    },
    TURN_TIMEOUT_MS,
  );
});

describe('a connector read the person always allows', () => {
  let server: ApprovalTestServer;
  const PAGE_ID = '0f3a9c2e7b1d4e6f8a5b3c2d1e0f9a8b';
  const OTHER_ID = '7c1e5a9d3b2f4086a1c3e5d7f9b0a2c4';

  /** Asks for one page in a new chat, with these arguments, and returns the cards that came up. */
  async function readPage(toolArguments: Record<string, string>) {
    const chatId = await createChat(server);
    server.model.next({ toolArguments });
    return { chatId, cards: cards(await runTurn({ server, chatId, input: ask(INERT_GET_PAGE_TOOL) })) };
  }

  beforeAll(async () => {
    server = await startApprovalTestServer({ inertPageById: true });
    const first = await readPage({ page_id: 'welcome' });
    const [card] = first.cards;
    if (card === undefined) {
      throw new Error('a new connector tool did not ask before its first run');
    }
    expect(card.can_always_allow).toBe(true);
    const input: TurnInputItem[] = [
      {
        type: 'user.tool_approval',
        thread_id: card.thread_id,
        tool_call_id: card.id,
        approval: { status: 'allow', scope: 'always' },
      },
    ];
    await runTurn({ server, chatId: first.chatId, input });
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  });

  it(
    'runs without a card when it looks a page up by one short id',
    async () => {
      const before = server.mcp.getPageInvocations();
      expect((await readPage({ page_id: PAGE_ID })).cards).toEqual([]);
      expect(server.mcp.getPageInvocations()).toBe(before + 1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'asks first when the id is longer than one short id',
    async () => {
      const before = server.mcp.getPageInvocations();
      const held = (await readPage({ page_id: `${PAGE_ID}${PAGE_ID}` })).cards;
      expect(held.map(card => card.tier3_card?.plain_what)).toEqual([
        expect.stringContaining(`Look this up on ${INERT_SERVER_NAME}?`),
      ]);
      expect(server.mcp.getPageInvocations()).toBe(before);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'asks first when a second id field carries a short id too',
    async () => {
      const before = server.mcp.getPageInvocations();
      const held = (await readPage({ page_id: PAGE_ID, parent_id: OTHER_ID })).cards;
      expect(held.map(card => card.tier3_card?.plain_what)).toEqual([
        expect.stringContaining(`Look this up on ${INERT_SERVER_NAME}?`),
      ]);
      expect(server.mcp.getPageInvocations()).toBe(before);
    },
    TURN_TIMEOUT_MS,
  );
});

describe('reminders and schedules in a chat', () => {
  let server: ApprovalTestServer;
  const REMINDER = {
    what: 'Take the medicine',
    at: `${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T18:00:00+00:00`,
  };

  /** Asks for one tool with these arguments and returns the cards that came up. */
  async function call({ chatId, tool, toolArguments }: { chatId: string; tool: string; toolArguments: object }) {
    server.model.next({ toolArguments });
    return cards(await runTurn({ server, chatId, input: ask(tool) }));
  }

  beforeAll(async () => {
    server = await startApprovalTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it(
    'setting a reminder runs without a card, and cancelling it asks with no chat-wide answer',
    async () => {
      const chatId = await createChat(server);
      expect(await call({ chatId, tool: 'set_reminder', toolArguments: REMINDER })).toEqual([]);

      const [cancel, ...others] = await call({
        chatId,
        tool: 'cancel_reminder',
        toolArguments: { reminder: REMINDER.what },
      });
      expect(others).toEqual([]);
      expect(cancel?.tier3_card?.plain_what).toContain(REMINDER.what);
      expect(cancel?.can_chat_allow).toBe(false);
      expect(cancel?.can_always_allow).toBe(false);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'pausing a schedule asks, and resuming it asks again',
    async () => {
      const chatId = await createChat(server);
      const create = onlyCard(await runTurn({ server, chatId, input: ask('create_schedule') }));
      await runTurn({ server, chatId, input: answer({ card: create, scope: 'once' }) });

      const [pause] = await call({
        chatId,
        tool: 'pause_schedule',
        toolArguments: { schedule: SCRIPTED_SCHEDULE.name },
      });
      if (pause === undefined) {
        throw new Error('pausing the schedule showed no card');
      }
      expect(pause.can_chat_allow).toBe(false);
      expect(pause.can_always_allow).toBe(false);
      await runTurn({ server, chatId, input: answer({ card: pause, scope: 'once' }) });

      const [resume] = await call({
        chatId,
        tool: 'resume_schedule',
        toolArguments: { schedule: SCRIPTED_SCHEDULE.name },
      });
      expect(resume?.tier3_card?.plain_what).toContain('Resume the schedule');
      expect(resume?.can_chat_allow).toBe(false);
    },
    TURN_TIMEOUT_MS,
  );
});
