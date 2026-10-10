import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { extractCardFields } from '../../../src/core/permissions/extractorRegistry';

function makeCtx(overrides?: { services?: SentinelServices }): ClassifyContext {
  return {
    services: overrides?.services ?? defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: null,
    agent_intent: null,
  };
}

function action(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'mcp',
    mcp_hints: {},
  };
}

describe('outbound payload extractors', () => {
  test('search tool shows the query', () => {
    const result = extractCardFields({
      tool_name: 'web_search',
      canonical_params: { query: 'best pizza near me' },
    });
    expect(result.fields.outbound_text).toBe('best pizza near me');
    expect(result.fields.destination).toBe('web search');
  });

  test('exa search tool shows the query', () => {
    const result = extractCardFields({
      tool_name: 'exa_search',
      canonical_params: { query: 'typescript generics' },
    });
    expect(result.fields.outbound_text).toBe('typescript generics');
  });

  test('tavily search tool shows the query', () => {
    const result = extractCardFields({
      tool_name: 'tavily_search',
      canonical_params: { query: 'climate data' },
    });
    expect(result.fields.outbound_text).toBe('climate data');
  });

  test('fetch tool shows the URL and host', () => {
    const result = extractCardFields({
      tool_name: 'web_fetch',
      canonical_params: { url: 'https://example.com/article?id=123' },
    });
    expect(result.fields.outbound_text).toBe('https://example.com/article?id=123');
    expect(result.fields.destination_host).toBe('example.com');
    expect(result.fields.destination).toBe('https://example.com/article?id=123');
  });

  test('fetch tool handles protocol-relative URLs', () => {
    const result = extractCardFields({
      tool_name: 'fetch_url',
      canonical_params: { url: '//cdn.example.com/lib.js' },
    });
    expect(result.fields.destination_host).toBe('cdn.example.com');
  });

  test('github push_files shows owner/repo, branch, and files', () => {
    const result = extractCardFields({
      tool_name: 'push_files',
      canonical_params: {
        owner: 'acme',
        repo: 'website',
        branch: 'main',
        files: [{ path: 'index.html', content: '<h1>hi</h1>' }],
      },
    });
    expect(result.fields.destination).toBe('acme/website');
    expect(result.fields.destination_host).toBe('github.com');
    expect(result.fields.outbound_text).toContain('acme/website');
    expect(result.fields.outbound_text).toContain('main');
  });

  test('github create_repository shows visibility', () => {
    const result = extractCardFields({
      tool_name: 'create_repository',
      canonical_params: { owner: 'acme', repo: 'new-project', private: 'true' },
    });
    expect(result.fields.outbound_text).toContain('acme/new-project');
  });

  test('gmail send shows recipients, subject, and body preview', () => {
    const result = extractCardFields({
      tool_name: 'gmail_send',
      canonical_params: {
        to: 'alice@example.com',
        cc: 'bob@example.com',
        subject: 'Meeting notes',
        body: 'Here are the notes from today...',
      },
    });
    expect(result.fields.recipient).toContain('alice@example.com');
    expect(result.fields.recipient).toContain('bob@example.com');
    expect(result.fields.outbound_text).toContain('alice@example.com');
    expect(result.fields.outbound_text).toContain('Meeting notes');
    expect(result.fields.outbound_text).toContain('Here are the notes');
  });

  test('gmail draft follows the same rules', () => {
    const result = extractCardFields({
      tool_name: 'gmail_draft',
      canonical_params: {
        to: 'carol@example.com',
        subject: 'Draft subject',
        body: 'Draft body content',
      },
    });
    expect(result.fields.outbound_text).toContain('carol@example.com');
    expect(result.fields.outbound_text).toContain('Draft subject');
  });

  test('long outbound text is truncated at 500 characters with a marker', () => {
    const longQuery = 'x'.repeat(600);
    const result = extractCardFields({
      tool_name: 'web_search',
      canonical_params: { query: longQuery },
    });
    expect(result.fields.outbound_text).not.toBeNull();
    const text = result.fields.outbound_text as string;
    expect(text.length).toBeLessThanOrEqual(520);
    expect(text).toContain('(truncated)');
    expect(text.startsWith('x'.repeat(500))).toBe(true);
  });

  test('exactly 500 characters is not truncated', () => {
    const query = 'y'.repeat(500);
    const result = extractCardFields({
      tool_name: 'web_search',
      canonical_params: { query },
    });
    expect(result.fields.outbound_text).toBe(query);
  });
});

describe('unrecognized_tool card shows extracted fields', () => {
  test('unrecognized tool with a URL fills destination from the extractor', async () => {
    const decision = await classifyTier(
      action('my_custom_tool', { url: 'https://api.example.com/data' }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('unrecognized_tool');
    expect(decision.card).not.toBeNull();
    expect(decision.card?.destination).toBe('https://api.example.com/data');
  });

  test('unrecognized tool with a recipient fills recipient from the extractor', async () => {
    const decision = await classifyTier(action('my_custom_tool', { to: 'dave@example.com' }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('unrecognized_tool');
    expect(decision.card?.recipient).toContain('dave@example.com');
  });

  test('search tool is Tier 3 with the query on the card', async () => {
    const decision = await classifyTier(action('web_search', { query: 'sensitive internal project name' }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.card).not.toBeNull();
    expect(decision.card?.outbound_text).toBe('sensitive internal project name');
  });

  test('fetch tool card shows the host', async () => {
    const decision = await classifyTier(action('web_fetch', { url: 'https://attacker.example/p.png' }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.card?.destination_host).toBe('attacker.example');
    expect(decision.card?.outbound_text).toBe('https://attacker.example/p.png');
  });

  test('outbound fields do not change the tier: still Tier 3', async () => {
    const decision = await classifyTier(action('web_search', { query: 'hello' }), makeCtx());
    expect(decision.tier).toBe(3);
    // The card carries display-only fields; the tier comes from the classifier.
    expect(decision.card?.outbound_text).not.toBeNull();
  });

  test('non-connector Tier 3 cards have null outbound fields', async () => {
    const decision = await classifyTier(action('exec', { command: 'curl https://example.com' }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.card).not.toBeNull();
    expect(decision.card?.outbound_text).toBeNull();
    expect(decision.card?.destination_host).toBeNull();
  });
});
