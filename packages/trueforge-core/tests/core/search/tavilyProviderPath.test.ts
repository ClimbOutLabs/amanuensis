import {
  ToolSet,
  createSentinelHostContext,
  createWebSearchTurnState,
  defaultSentinelServices,
  type SentinelHostContext,
} from '../../../src/core';
import { isCallToolResponseResult, type CallToolResponse } from '../../../src/core/mcp/IMCPServer';
import type { AuditRecordInput } from '../../../src/core/permissions/audit';
import type { SentinelServices } from '../../../src/core/permissions/context';
import { isSearchHoldCardText } from '../../../src/core/permissions/searchHoldText';
import { FetchedPageStore } from '../../../src/core/search/fetchedPages';
import { TAVILY_SOURCE_TOOLS, TavilyClient } from '../../../src/core/search/TavilyClient';
import { TavilySource } from '../../../src/core/search/TavilySource';
import { CANAL_URL, GARDEN_URL, HARBOUR_URL, extractResponse, searchResponse } from './tavilyFixtures';

function harness(options: { searchWithoutAsking: boolean; secrets?: readonly string[] }) {
  const audit: AuditRecordInput[] = [];
  const sent: { url: string; body: unknown }[] = [];
  const services: SentinelServices = {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    audit: {
      record: input => {
        audit.push(input);
        return Promise.resolve();
      },
    },
    searchWithoutAsking: () => Promise.resolve(options.searchWithoutAsking),
    outboundSecrets: () => Promise.resolve(options.secrets ?? []),
  };
  const host: SentinelHostContext = createSentinelHostContext({
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    services,
    web_search: createWebSearchTurnState(),
  });
  const client = new TavilyClient({
    auth: { kind: 'keyless' },
    fetchImpl: (url, init) => {
      const body: unknown = JSON.parse(String(init.body));
      sent.push({ url, body });
      return Promise.resolve(new Response(JSON.stringify(url.endsWith('/search') ? searchResponse : extractResponse)));
    },
  });
  const source = new TavilySource({
    id: 'tavily',
    name: 'tavily',
    client,
    pages: new FetchedPageStore({ now: Date.now, ttlMs: 60_000, maxPages: 10 }),
  });
  const toolSet = new ToolSet({
    source,
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: undefined },
    preload: false,
    sentinel: host,
    searchProvider: { tools: [...TAVILY_SOURCE_TOOLS], plumbing_fields: [] },
  });
  return { toolSet, audit, sent };
}

/** A call the turn loop could not take an approval for does not run; it comes back as a plain error. */
async function refusedWithoutSending(call: Promise<CallToolResponse>): Promise<boolean> {
  const response = await call;
  return isCallToolResponseResult(response) && response.result.isError === true;
}

const search = { name: 'tavily_search', arguments: { query: 'English speaking doctor Lisbon' } };
const extract = { name: 'tavily_extract', arguments: { urls: [HARBOUR_URL, GARDEN_URL] } };

describe('Tavily through the designated search provider path', () => {
  it('runs both tools without asking when searches run without asking, one request each', async () => {
    const h = harness({ searchWithoutAsking: true });
    const searchInfo = await h.toolSet.toolCallInfo(search);
    expect(searchInfo.tier).toBe(1);
    // Open-world is what sends a result through the host's read-content screen.
    expect(searchInfo.open_world_hint).toBe(true);
    expect((await h.toolSet.toolCallInfo(extract)).open_world_hint).toBe(true);
    expect(searchInfo.silent_search_query).toBe('English speaking doctor Lisbon');
    expect(isCallToolResponseResult(await h.toolSet.callTool(search))).toBe(true);

    const extractInfo = await h.toolSet.toolCallInfo(extract);
    expect(extractInfo.tier).toBe(1);
    expect(isCallToolResponseResult(await h.toolSet.callTool(extract))).toBe(true);
    expect(h.sent.map(call => call.url)).toEqual(['https://api.tavily.com/search', 'https://api.tavily.com/extract']);
    expect(h.audit.map(row => row.tool_name)).toEqual(['tavily_search', 'tavily_extract']);
  });

  it('asks for a search with the query, host and credits, without naming the endpoint, and sends nothing until approved', async () => {
    const h = harness({ searchWithoutAsking: false });
    const info = await h.toolSet.toolCallInfo(search);
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
    const card = info.tier3_card;
    expect(card?.plain_what).toContain('English speaking doctor Lisbon');
    expect(card?.plain_what).toContain('api.tavily.com');
    expect(card?.plain_what).not.toMatch(/endpoint/);
    expect(card?.plain_what).not.toContain('/search');
    expect(card?.plain_what).not.toMatch(/keyless|free allowance|not added a Tavily key/i);
    expect(card?.plain_what).toMatch(/uses 2 Tavily credits\.$/);
    expect(card?.destination_host).toBe('api.tavily.com');
    expect(card?.outbound_text).toContain('English speaking doctor Lisbon');
    expect(await refusedWithoutSending(h.toolSet.callTool(search))).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it('asks for an extract before any search, listing the exact links, host and credit without the endpoint', async () => {
    const h = harness({ searchWithoutAsking: true });
    const info = await h.toolSet.toolCallInfo(extract);
    expect(info.tier).toBe(3);
    expect(info.tier3_card?.plain_what).toContain(HARBOUR_URL);
    expect(info.tier3_card?.plain_what).toContain(GARDEN_URL);
    expect(info.tier3_card?.plain_what).toContain('api.tavily.com');
    expect(info.tier3_card?.plain_what).not.toMatch(/endpoint/);
    expect(info.tier3_card?.plain_what).not.toContain('/extract');
    expect(info.tier3_card?.plain_what).not.toMatch(/keyless|free allowance|not added a Tavily key/i);
    expect(info.tier3_card?.plain_what).toContain('1 Tavily credit');
    expect(info.tier3_card?.destination_host).toBe('api.tavily.com');
    expect(info.tier3_card?.plain_what).toMatch(
      /Held because it names a link that no search result this turn returned\.$/,
    );
    expect(info.tier3_card?.why_asked_again).toBeNull();
    expect(isSearchHoldCardText(info.tier3_card?.plain_what ?? '')).toBe(true);
  });

  it('shows a hidden character in the query as a visible token on the card', async () => {
    const h = harness({ searchWithoutAsking: false });
    const hidden = { name: 'tavily_search', arguments: { query: 'doctor\u202Elisbon' } };
    const card = (await h.toolSet.toolCallInfo(hidden)).tier3_card;
    expect(card?.plain_what).toContain('doctor\\u{202E}lisbon');
    expect(card?.plain_what).not.toContain('\u202E');
    expect(isSearchHoldCardText(card?.plain_what ?? '')).toBe(true);
  });

  it("lets an extract name only links that this turn's search returned", async () => {
    const h = harness({ searchWithoutAsking: true });
    await h.toolSet.callTool(search);
    expect((await h.toolSet.toolCallInfo(extract)).tier).toBe(1);
    const composed = { name: 'tavily_extract', arguments: { urls: ['https://made-up.example/page'] } };
    expect((await h.toolSet.toolCallInfo(composed)).tier).toBe(3);
    const modified = { name: 'tavily_extract', arguments: { urls: [`${CANAL_URL}?x=1`] } };
    expect((await h.toolSet.toolCallInfo(modified)).tier).toBe(3);
  });

  it('holds a search that carries a secret and says why, without sending it', async () => {
    const h = harness({ searchWithoutAsking: true, secrets: ['server-held-secret-value'] });
    const leaking = { name: 'tavily_search', arguments: { query: 'doctor server-held-secret-value' } };
    const info = await h.toolSet.toolCallInfo(leaking);
    expect(info.tier).toBe(3);
    const card = info.tier3_card;
    expect(card?.plain_what).toContain('2 Tavily credits');
    expect(card?.plain_what).toMatch(/Held because it contains one of this computer's keys\.$/);
    expect(card?.why_asked_again).toBeNull();
    // The UI shows the masked outbound text instead of the model's raw arguments only for a card it recognizes.
    expect(isSearchHoldCardText(card?.plain_what ?? '')).toBe(true);
    for (const text of [card?.plain_what, card?.outbound_text, info.audit_description]) {
      expect(text ?? '').not.toContain('server-held-secret-value');
    }
    expect(await refusedWithoutSending(h.toolSet.callTool(leaking))).toBe(true);
    expect(h.sent).toEqual([]);
  });
});
