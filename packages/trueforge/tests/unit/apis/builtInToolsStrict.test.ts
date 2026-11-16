/**
 * What the real server sends a model about its own tools. A provider that checks tool definitions
 * strictly refuses the whole request when a tool marked strict has an optional field, so every
 * tool marked strict must list all of its fields as required, at every depth.
 */
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import type { AdvertisedTool } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Answer the user.',
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The places in a schema where a field is optional, as paths, so a failure names them. */
function optionalFields({ schema, at }: { schema: unknown; at: string }): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((member, index) => optionalFields({ schema: member, at: `${at}[${String(index)}]` }));
  }
  if (!isRecord(schema)) {
    return [];
  }
  const found: string[] = [];
  const properties = schema['properties'];
  if (isRecord(properties)) {
    const required = Array.isArray(schema['required']) ? schema['required'] : [];
    found.push(
      ...Object.keys(properties)
        .filter(key => !required.includes(key))
        .map(key => `${at}.${key}`),
    );
  }
  for (const [key, child] of Object.entries(schema)) {
    if (key !== 'required' && (isRecord(child) || Array.isArray(child))) {
      found.push(...optionalFields({ schema: child, at: `${at}.${key}` }));
    }
  }
  return found;
}

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('the tools a chat offers the model', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer();
  }, 120_000);

  afterAll(async () => {
    await server.close();
  });

  async function toolsOfOneTurn(): Promise<AdvertisedTool[]> {
    const created = await server.request('/api/v1/sessions', json({ agent: { spec: AGENT_SPEC } }));
    expect(created.status).toBe(201);
    const body: unknown = await created.json();
    const data = isRecord(body) ? body['data'] : undefined;
    const chatId = isRecord(data) ? data['id'] : undefined;
    if (typeof chatId !== 'string') {
      throw new Error('the server made a chat but gave no id for it');
    }
    const from = server.model.requests().length;
    const turn = await server.request(
      `/api/v1/sessions/${chatId}/turns`,
      json({ input: [{ type: 'user.message', content: 'Hello' }], stream: true }),
    );
    expect(turn.status).toBe(200);
    await turn.text();
    const withTools = server.model
      .requests()
      .slice(from)
      .find(request => request.tools.length > 0);
    if (withTools === undefined) {
      throw new Error('no model request in the turn offered any tools');
    }
    return withTools.tools;
  }

  it(
    'marks a tool strict only when every field is required, and still marks the ones that are',
    async () => {
      const tools = await toolsOfOneTurn();
      const strict = tools.filter(tool => tool.function?.strict === true);
      const broken = strict.flatMap(tool =>
        optionalFields({ schema: tool.function?.parameters, at: String(tool.function?.name) }),
      );
      expect(broken).toEqual([]);
      expect(strict.length).toBeGreaterThan(0);
      const plainWithOptional = tools.filter(
        tool =>
          tool.function?.strict !== true &&
          optionalFields({ schema: tool.function?.parameters, at: String(tool.function?.name) }).length > 0,
      );
      expect(plainWithOptional.length).toBeGreaterThan(0);
    },
    TURN_TIMEOUT_MS,
  );
});
