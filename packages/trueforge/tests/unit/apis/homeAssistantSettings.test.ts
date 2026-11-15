/**
 * The Home Assistant preset over the HTTP surface: the catalog entry, the address rule on save,
 * the connection check against the stub (counts, and each failure's one fix), and the token
 * canary: the token the preset stores must never come back in any response.
 */
import { z } from 'zod';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { startHomeAssistantStub, type HomeAssistantStub } from '../../fixtures/homeAssistantMcpServer';

const CANARY_TOKEN = 'ha-canary-token-7f3d9a';
const TEST_TIMEOUT_MS = 60_000;

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function manifest(url: string, token: string) {
  return {
    manifest: {
      type: 'remote',
      name: 'home-assistant',
      url,
      description: 'See and control the Home Assistant devices you expose to voice assistants.',
      auth: { type: 'header', headers: { Authorization: `Bearer ${token}` } },
    },
  };
}

const CheckResultSchema = z.object({
  data: z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), tool_count: z.number(), entity_count: z.number().nullable() }),
    z.object({ status: z.literal('failed'), code: z.string(), reason: z.string() }),
  ]),
});

describe('Home Assistant preset', () => {
  let server: ApprovalTestServer;
  let stub: HomeAssistantStub;
  let missingStub: HomeAssistantStub;

  beforeAll(async () => {
    server = await startApprovalTestServer();
    stub = await startHomeAssistantStub({ token: CANARY_TOKEN });
    missingStub = await startHomeAssistantStub({ integrationInstalled: false });
    // The stubs run on this computer, which the address check refuses; the operator vouches for
    // them by listing their origins, as FIRST_PARTY_MCP_ORIGINS does for services of their own.
    server.setFirstPartyOrigins([
      server.mcp.origin,
      new URL(stub.url).origin,
      new URL(missingStub.url).origin,
      'http://127.0.0.1:1',
    ]);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await stub.stop();
    await missingStub.stop();
    await server.close();
  });

  it('ships home-assistant in the connector catalog', async () => {
    const response = await server.request('/api/v1/catalogs/mcp-servers');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { name: string; url: string }[] };
    const entry = body.data.find(serverEntry => serverEntry.name === 'home-assistant');
    expect(entry).toBeDefined();
    expect(entry?.url).toContain('/mcp_server/sse');
  });

  it('refuses a public address over http, and an address that is not the preset endpoint', async () => {
    const publicHttp = await server.request(
      '/api/v1/settings/mcp-servers',
      jsonInit('POST', manifest('http://ha.example.com:8123/mcp_server/sse', CANARY_TOKEN)),
    );
    expect(publicHttp.status).toBe(400);
    expect(JSON.stringify(await publicHttp.json())).toMatch(/needs https/);

    const wrongPath = await server.request(
      '/api/v1/settings/mcp-servers',
      jsonInit('POST', manifest('https://homeassistant.local:8123/api/mcp', CANARY_TOKEN)),
    );
    expect(wrongPath.status).toBe(400);
    expect(JSON.stringify(await wrongPath.json())).toMatch(/mcp_server\/sse/);
  });

  it(
    'saves the connector with the token redacted, and the check reports the counts',
    async () => {
      const created = await server.request(
        '/api/v1/settings/mcp-servers',
        jsonInit('POST', manifest(stub.url, CANARY_TOKEN)),
      );
      expect(created.status).toBe(201);
      const createdText = JSON.stringify(await created.json());
      expect(createdText).not.toContain(CANARY_TOKEN);

      const read = await server.request('/api/v1/settings/mcp-servers/home-assistant');
      expect(read.status).toBe(200);
      expect(JSON.stringify(await read.json())).not.toContain(CANARY_TOKEN);

      const check = await server.request('/api/v1/mcp-servers/home-assistant/home-assistant-check', { method: 'POST' });
      expect(check.status).toBe(200);
      const checkBody = CheckResultSchema.parse(await check.json());
      expect(checkBody.data).toEqual({ status: 'ok', tool_count: 6, entity_count: 5 });
      // The token travelled the only way it may: as the Authorization header on the dial.
      expect(stub.lastAuthorizationHeader()).toBe(`Bearer ${CANARY_TOKEN}`);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'says the token was refused when Home Assistant does not know it',
    async () => {
      const updated = await server.request(
        '/api/v1/settings/mcp-servers',
        jsonInit('PUT', manifest(stub.url, 'not-the-saved-token')),
      );
      expect(updated.status).toBe(200);
      const check = await server.request('/api/v1/mcp-servers/home-assistant/home-assistant-check', { method: 'POST' });
      const checkBody = CheckResultSchema.parse(await check.json());
      expect(checkBody.data.status).toBe('failed');
      if (checkBody.data.status === 'failed') {
        expect(checkBody.data.code).toBe('token_refused');
        expect(checkBody.data.reason).toMatch(/refused the token/);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'says the integration is missing when the endpoint answers 404',
    async () => {
      const updated = await server.request(
        '/api/v1/settings/mcp-servers',
        jsonInit('PUT', manifest(missingStub.url, CANARY_TOKEN)),
      );
      expect(updated.status).toBe(200);
      const check = await server.request('/api/v1/mcp-servers/home-assistant/home-assistant-check', { method: 'POST' });
      const checkBody = CheckResultSchema.parse(await check.json());
      expect(checkBody.data.status).toBe('failed');
      if (checkBody.data.status === 'failed') {
        expect(checkBody.data.code).toBe('integration_missing');
        expect(checkBody.data.reason).toMatch(/integration is not installed/);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'says nothing answered when the address refuses the connection',
    async () => {
      const updated = await server.request(
        '/api/v1/settings/mcp-servers',
        jsonInit('PUT', manifest('http://127.0.0.1:1/mcp_server/sse', CANARY_TOKEN)),
      );
      expect(updated.status).toBe(200);
      const check = await server.request('/api/v1/mcp-servers/home-assistant/home-assistant-check', { method: 'POST' });
      const checkBody = CheckResultSchema.parse(await check.json());
      expect(checkBody.data.status).toBe('failed');
      if (checkBody.data.status === 'failed') {
        expect(checkBody.data.code).toBe('unreachable');
        expect(checkBody.data.reason).toMatch(/Nothing answered at that address/);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it('answers 404 for a check on a connector that does not exist', async () => {
    const check = await server.request('/api/v1/mcp-servers/no_such_home/home-assistant-check', { method: 'POST' });
    expect(check.status).toBe(404);
  });
});
