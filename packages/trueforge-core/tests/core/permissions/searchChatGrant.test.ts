import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { type ChatPrivateFingerprints } from '../../../src/core/permissions/privateTextCheck';
import {
  chatFingerprintsAfterTurn,
  createWebSearchTurnState,
  markPrivateDataRead,
  markPrivateDataReadFromHistory,
  recordPrivateReadText,
  SILENT_SEARCH_LIMIT,
  type WebSearchTurnState,
} from '../../../src/core/permissions/webSearch';

const MAIL = JSON.stringify({
  from: 'Maria Costa <maria.costa@harbour-clinic.example>',
  body: 'Please bring your booking reference 4417829 before Friday.',
});

const MAPS_HOSTS = {
  geocoder: 'https://nominatim.openstreetmap.org',
  router: 'https://router.project-osrm.org',
  walking: 'https://foot.example.test/routed-foot',
  cycling: 'https://bike.example.test/routed-bike',
  transit: 'https://transit.example.test/api/v6',
  tile: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
};

function makeCtx(
  input: { conversation_id?: string | undefined; services?: Partial<SentinelServices> } = {},
): ClassifyContext {
  return {
    services: { ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }), ...input.services },
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: input.conversation_id ?? 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

const SEARCH: SentinelAction = {
  tool_name: 'web_search',
  canonical_params: { query: 'best coffee shops in Lisbon' },
  tool_type: 'mcp',
  mcp_server_name: 'search',
  mcp_search_provider: true,
  mcp_search_tool: true,
  mcp_hints: { read_only_hint: true, open_world_hint: true },
};

function searchFor(query: string): SentinelAction {
  return { ...SEARCH, canonical_params: { query } };
}

const MAIL_READ: SentinelAction = {
  tool_name: 'read_email',
  canonical_params: { message_id: 'm1' },
  tool_type: 'truefoundry-system',
  mcp_server_name: 'gmail',
  mcp_hints: { read_only_hint: true, open_world_hint: true },
};

/** A private read whose result text the chat keeps, as the post-call step records it. */
async function readMail(ctx: ClassifyContext): Promise<void> {
  await classifyTier(MAIL_READ, ctx);
  markPrivateDataRead(ctx.web_search);
  recordPrivateReadText({ state: ctx.web_search, text: MAIL });
}

/** The chat's state at the end of a turn, as the store keeps it for the chat's next turn. */
function savedAfter(state: WebSearchTurnState): ChatPrivateFingerprints {
  return chatFingerprintsAfterTurn(state);
}

/**
 * A later turn of the chat: the saved fingerprints are loaded and the saved private-read flag is restored from
 * the history, as the turn start does. The turn's own text is not held.
 */
function nextTurn(input: {
  saved: ChatPrivateFingerprints | null;
  conversation_id?: string | undefined;
}): ClassifyContext {
  const ctx = makeCtx({ conversation_id: input.conversation_id });
  ctx.web_search.chatFingerprints = input.saved ?? {
    complete: false,
    has_text: false,
    secret: false,
    entries: [],
  };
  ctx.web_search.savedFingerprintsLoaded = input.saved !== null;
  markPrivateDataReadFromHistory(ctx.web_search);
  return ctx;
}

/** The chat's saved grant, as the session hands it to a turn that starts after the owner allowed it. */
function grantChat(ctx: ClassifyContext): void {
  ctx.web_search.searchChatGranted = true;
}

/** Turn one reads an email and ends. Turn two starts with the chat's saved state. */
async function chatWithEmailReadInEarlierTurn(
  input: { conversation_id?: string | undefined } = {},
): Promise<ClassifyContext> {
  const first = makeCtx({ conversation_id: input.conversation_id });
  await readMail(first);
  return nextTurn({ saved: savedAfter(first.web_search), conversation_id: input.conversation_id });
}

describe('a held search after a private read offers the chat choice', () => {
  it('holds a search after a private read in an earlier turn, with the private-read reason', async () => {
    const ctx = await chatWithEmailReadInEarlierTurn();
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });
});

describe('a chat grant from "Allow searches in this chat"', () => {
  it('runs a plain search silently in a later turn after an email read', async () => {
    const ctx = await chatWithEmailReadInEarlierTurn();
    grantChat(ctx);
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({
      tier: 1,
      reason: 'mcp_search_chat_granted',
      silent_search_query: 'best coffee shops in Lisbon',
    });
  });

  it('still holds a search that quotes the email, from its saved fingerprints', async () => {
    const ctx = await chatWithEmailReadInEarlierTurn();
    grantChat(ctx);
    expect(await classifyTier(searchFor('Maria Costa clinic reviews'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('still holds a search that copies a phrase of the email from its saved fingerprints', async () => {
    const ctx = await chatWithEmailReadInEarlierTurn();
    grantChat(ctx);
    expect(await classifyTier(searchFor('Please bring your booking reference today'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('still holds a search that names a URL the search never returned', async () => {
    const ctx = await chatWithEmailReadInEarlierTurn();
    grantChat(ctx);
    expect(await classifyTier(searchFor('https://example.test/unseen-page'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_unreturned_url',
    });
  });

  it('still holds a search that carries a key', async () => {
    const ctx = await chatWithEmailReadInEarlierTurn();
    grantChat(ctx);
    expect(await classifyTier(searchFor('wsk-live-synthetic000111222333'), ctx)).toMatchObject({
      tier: 3,
      reason: 'mcp_search_guard',
    });
  });

  it('still holds once the chat has used its silent searches', async () => {
    const ctx = await chatWithEmailReadInEarlierTurn();
    grantChat(ctx);
    ctx.web_search.silentSearches = SILENT_SEARCH_LIMIT;
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({ tier: 3, reason: 'mcp_search_limit' });
  });

  it('holds when the chat has no saved fingerprints to check against, as for a chat from before them', async () => {
    const ctx = nextTurn({ saved: null });
    grantChat(ctx);
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
  });

  it('keeps asking in a chat that read a secret or key file, even with the grant', async () => {
    const ctx = await chatWithEmailReadInEarlierTurn();
    ctx.web_search.chatFingerprints.secret = true;
    grantChat(ctx);
    const decision = await classifyTier(SEARCH, ctx);
    expect(decision).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
    expect(decision.card?.plain_what).toContain(
      'This chat opened a file with passwords or keys, so Aman asks before every search.',
    );
  });

  it('does not lift the private-read hold for a map after a private read', async () => {
    const ctx = await chatWithEmailReadInEarlierTurn();
    ctx.services.mapsWithoutAsking = () => Promise.resolve(true);
    grantChat(ctx);
    const decision = await classifyTier(
      {
        tool_name: 'render_map',
        canonical_params: { place_name: '12 Example Street, Lisbon 1100-000' },
        tool_type: 'truefoundry-system',
        mcp_server_name: 'maps',
        mcp_first_party: true,
        mcp_hints: {},
        maps_hosts: MAPS_HOSTS,
      },
      ctx,
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).not.toMatch(/^mcp_maps.*silent/);
  });

  it('does not reach another chat', async () => {
    const chatA = await chatWithEmailReadInEarlierTurn({ conversation_id: 'chat-a' });
    const chatB = await chatWithEmailReadInEarlierTurn({ conversation_id: 'chat-b' });
    grantChat(chatA);
    expect(await classifyTier(SEARCH, chatA)).toMatchObject({ tier: 1, reason: 'mcp_search_chat_granted' });
    expect(await classifyTier(SEARCH, chatB)).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
  });
});

describe('the held search card folds the search service fields', () => {
  it('names the service fields separately so the card can fold them, while still listing every argument', async () => {
    const ctx = await chatWithEmailReadInEarlierTurn();
    const decision = await classifyTier(
      {
        ...SEARCH,
        canonical_params: {
          query: 'best coffee shops in Lisbon',
          session_id: 'sess-123',
          model_name: 'search-model-1',
        },
        mcp_search_plumbing_fields: ['session_id', 'model_name'],
      },
      ctx,
    );
    expect(decision).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
    expect(decision.card?.outbound_text).toContain('best coffee shops in Lisbon');
    expect(decision.card?.outbound_text).toContain('sess-123');
    expect(decision.card?.outbound_plumbing_text).not.toContain('best coffee shops in Lisbon');
    expect(decision.card?.outbound_plumbing_text).toContain('sess-123');
    expect(decision.card?.outbound_plumbing_text).toContain('search-model-1');
  });
});
