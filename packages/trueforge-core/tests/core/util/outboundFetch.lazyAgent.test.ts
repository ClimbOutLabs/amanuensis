const agentConstructed = jest.fn();
const undiciFetch = jest.fn(async (..._args: unknown[]): Promise<Response> => new Response('ok', { status: 200 }));

jest.mock('undici', () => ({
  Agent: class {
    constructor(options: unknown) {
      agentConstructed(options);
    }
    async close(): Promise<void> {}
  },
  fetch: async (...args: unknown[]): Promise<Response> => undiciFetch(...args),
}));

describe('outbound fetch Agents', () => {
  beforeEach(() => {
    jest.resetModules();
    agentConstructed.mockClear();
    undiciFetch.mockClear();
  });

  it('builds no Agent when the module is imported', async () => {
    await import('../../../src/core/util/outboundFetch');
    expect(agentConstructed).not.toHaveBeenCalled();
  });

  it('builds each Agent once, on first use, with the configured timeouts', async () => {
    const outbound = await import('../../../src/core/util/outboundFetch');
    const model = { connectTimeoutMs: 1, headersTimeoutMs: 2, bodyTimeoutMs: 3, maxRetries: 0 };
    const mcp = { connectTimeoutMs: 4, headersTimeoutMs: 5, bodyTimeoutMs: 6, maxRetries: 0 };
    outbound.configureOutboundFetches({ model, mcp });
    expect(agentConstructed).not.toHaveBeenCalled();

    await outbound.modelOutboundFetch('https://model.example/v1');
    await outbound.modelOutboundFetch('https://model.example/v1');
    await outbound.mcpOutboundBaseFetch('https://mcp.example/mcp');
    await outbound.mcpOutboundBaseFetch('https://mcp.example/mcp');

    expect(agentConstructed.mock.calls).toEqual([
      [{ connectTimeout: 1, headersTimeout: 2, bodyTimeout: 3 }],
      [{ connectTimeout: 4, headersTimeout: 5, bodyTimeout: 6 }],
    ]);
    expect(undiciFetch).toHaveBeenCalledTimes(4);
  });
});
