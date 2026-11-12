import { McpConnectionError } from '@truefoundry/trueforge-core/core';
import {
  buildHomeAssistantEndpoint,
  checkHomeAssistant,
  classifyHomeAssistantFailure,
  countHomeAssistantEntities,
  homeAssistantUrlProblem,
  type HomeAssistantProbeClient,
} from '../../../src/mcp/homeAssistant';

describe('buildHomeAssistantEndpoint', () => {
  it('builds the SSE endpoint from an https address', () => {
    expect(buildHomeAssistantEndpoint('https://homeassistant.local:8123')).toEqual({
      url: 'https://homeassistant.local:8123/mcp_server/sse',
    });
  });

  it('builds it from an http address on the home network', () => {
    expect(buildHomeAssistantEndpoint('http://192.168.1.20:8123')).toEqual({
      url: 'http://192.168.1.20:8123/mcp_server/sse',
    });
    expect(buildHomeAssistantEndpoint('homeassistant.local:8123')).toEqual({
      url: 'http://homeassistant.local:8123/mcp_server/sse',
    });
    expect(buildHomeAssistantEndpoint('http://localhost:8123')).toEqual({
      url: 'http://localhost:8123/mcp_server/sse',
    });
  });

  it('keeps an address that already names the endpoint, and trims a trailing slash', () => {
    expect(buildHomeAssistantEndpoint('https://example.ts.net:8123/mcp_server/sse')).toEqual({
      url: 'https://example.ts.net:8123/mcp_server/sse',
    });
    expect(buildHomeAssistantEndpoint('https://homeassistant.local:8123/')).toEqual({
      url: 'https://homeassistant.local:8123/mcp_server/sse',
    });
  });

  it('refuses http for a public address', () => {
    const built = buildHomeAssistantEndpoint('http://ha.example.com:8123');
    expect('problem' in built && built.problem).toMatch(/needs https/);
  });

  it('refuses an address with a login or a query', () => {
    expect('problem' in buildHomeAssistantEndpoint('https://user:secret@homeassistant.local:8123')).toBe(true);
    expect('problem' in buildHomeAssistantEndpoint('https://homeassistant.local:8123/?x=1')).toBe(true);
    expect('problem' in buildHomeAssistantEndpoint('')).toBe(true);
  });
});

describe('homeAssistantUrlProblem', () => {
  it('accepts the endpoint the preset builds', () => {
    expect(homeAssistantUrlProblem('https://homeassistant.local:8123/mcp_server/sse')).toBeNull();
    expect(homeAssistantUrlProblem('http://192.168.1.20:8123/mcp_server/sse')).toBeNull();
  });

  it('refuses a public http endpoint and a wrong path', () => {
    expect(homeAssistantUrlProblem('http://ha.example.com:8123/mcp_server/sse')).toMatch(/needs https/);
    expect(homeAssistantUrlProblem('https://homeassistant.local:8123/api/mcp')).toMatch(/mcp_server\/sse/);
  });
});

describe('countHomeAssistantEntities', () => {
  it('counts one line per exposed entity', () => {
    const text = ['The current state of the home is:', '- Living room lamp: off', '- Hallway thermostat: 22', ''].join(
      '\n',
    );
    expect(countHomeAssistantEntities(text)).toBe(2);
    expect(countHomeAssistantEntities('')).toBe(0);
  });
});

function probeClient(overrides: Partial<HomeAssistantProbeClient>): HomeAssistantProbeClient {
  return {
    listTools: async () => ({ tools: [{ name: 'GetLiveContext' }, { name: 'HassTurnOn' }, { name: 'HassTurnOff' }] }),
    callTool: async () => ({ texts: ['- Living room lamp: off\n- Hallway thermostat: heating'] }),
    ...overrides,
  };
}

describe('checkHomeAssistant', () => {
  it('reports tool and entity counts on success', async () => {
    const outcome = await checkHomeAssistant(probeClient({}));
    expect(outcome).toEqual({ status: 'ok', tool_count: 3, entity_count: 2 });
  });

  it('reports the counts when the live-context tool carries a prefix', async () => {
    const outcome = await checkHomeAssistant(
      probeClient({
        listTools: async () => ({ tools: [{ name: 'homeassistant__GetLiveContext' }, { name: 'intent__HassTurnOn' }] }),
      }),
    );
    expect(outcome).toEqual({ status: 'ok', tool_count: 2, entity_count: 2 });
  });

  it('says the token was refused when the server asks for authentication', async () => {
    const outcome = await checkHomeAssistant(probeClient({ listTools: async () => ({ authRequired: true }) }));
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.code).toBe('token_refused');
      expect(outcome.reason).toMatch(/refused the token/);
    }
  });

  it('says the integration is missing on a 404', async () => {
    const outcome = await checkHomeAssistant(
      probeClient({
        listTools: async () => {
          throw new McpConnectionError('Failed to connect: 404', 404);
        },
      }),
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.code).toBe('integration_missing');
      expect(outcome.reason).toMatch(/Model Context Protocol Server integration is not installed/);
    }
  });

  it('gives the certificate guidance for a self-signed certificate', async () => {
    const outcome = await checkHomeAssistant(
      probeClient({
        listTools: async () => {
          throw new McpConnectionError('Failed to connect: self signed certificate in chain', 502);
        },
      }),
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.code).toBe('certificate');
      expect(outcome.reason).toMatch(/http address on your home network/);
      expect(outcome.reason).toMatch(/Tailscale/);
    }
  });

  it('says nothing answered for a refused connection', async () => {
    const outcome = await checkHomeAssistant(
      probeClient({
        listTools: async () => {
          throw new McpConnectionError('Failed to connect: connect ECONNREFUSED', 502);
        },
      }),
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.code).toBe('unreachable');
      expect(outcome.reason).toMatch(/Nothing answered at that address/);
    }
  });
});

describe('classifyHomeAssistantFailure', () => {
  it('maps a 401 to the token fix', () => {
    expect(classifyHomeAssistantFailure(new McpConnectionError('nope', 401)).code).toBe('token_refused');
    expect(classifyHomeAssistantFailure(new Error('boom')).code).toBe('error');
  });

  it('reads the HTTP status out of the wrapped both-transports failure', () => {
    // The MCP client wraps a both-transports failure into one 502 whose message carries each
    // transport's status; the classification must still name the one fix.
    const wrapped404 = new McpConnectionError(
      'failed to connect (tried streamable-http, sse): [{"transport":"streamable-http","error":"Streamable HTTP error: Error POSTing to endpoint (HTTP 404)"},{"transport":"sse","error":"SSE error: Non-200 status code (404)"}]',
      502,
    );
    expect(classifyHomeAssistantFailure(wrapped404).code).toBe('integration_missing');
    const wrapped401 = new McpConnectionError(
      'failed to connect (tried streamable-http, sse): [{"transport":"sse","error":"SSE error: Non-200 status code (401)"}]',
      502,
    );
    expect(classifyHomeAssistantFailure(wrapped401).code).toBe('token_refused');
  });
});
