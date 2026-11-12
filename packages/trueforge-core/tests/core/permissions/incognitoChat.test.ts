import { MEMORY_PAGES_SERVER_ID } from '../../../src/core/memory/pagesToolContract';
import { NOTES_FOLDER_SERVER_ID } from '../../../src/core/notes/toolContract';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import {
  defaultSentinelServices,
  forIncognitoChat,
  forUnattendedRun,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';
import { PERSONA_SERVER_ID } from '../../../src/core/personas/toolContract';
import { SCHEDULE_SERVER_ID } from '../../../src/core/schedules/toolContract';
import { SKILL_SERVER_ID } from '../../../src/core/skills/toolContract';
import { SPACE_SERVER_ID } from '../../../src/core/spaces/toolContract';

function makeCtx(services: SentinelServices): ClassifyContext {
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

const normalChat = (): ClassifyContext => makeCtx(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }));
const incognitoChat = (): ClassifyContext =>
  makeCtx(forIncognitoChat(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' })));

/** A call on one of the assistant's own tool sets. */
function ownTool(server: string, tool_name: string, canonical_params: Record<string, unknown> = {}): SentinelAction {
  return { tool_name, canonical_params, tool_type: 'truefoundry-system', mcp_server_name: server, mcp_hints: {} };
}

/** A call on a connector the person added, with whatever the connector says about the tool. */
function connectorTool(
  tool_name: string,
  mcp_hints: SentinelAction['mcp_hints'],
  canonical_params: Record<string, unknown> = {},
): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'mcp',
    mcp_server_name: 'notes-app',
    mcp_server_host: 'notes.example.com',
    mcp_hints,
  };
}

const REFUSED = { tier: 3, auto_deny: 'incognito_chat', card: null };
const SAYS_READ_ONLY = { read_only_hint: true, open_world_hint: false };

describe('an incognito chat makes or changes nothing that outlives it', () => {
  it.each([
    ['a new space', ownTool(SPACE_SERVER_ID, 'create_space', { name: 'Trip', body: 'Notes' })],
    ['an edit to a space', ownTool(SPACE_SERVER_ID, 'edit_space', { name: 'Trip', body: 'More' })],
    ['a new schedule', ownTool(SCHEDULE_SERVER_ID, 'create_schedule', { name: 'Brief', task: 'Brief me' })],
    ['a paused schedule', ownTool(SCHEDULE_SERVER_ID, 'pause_schedule', { name: 'Brief' })],
    ['a deleted schedule', ownTool(SCHEDULE_SERVER_ID, 'delete_schedule', { name: 'Brief' })],
    ['a new reminder', ownTool(SCHEDULE_SERVER_ID, 'set_reminder', { text: 'Call Grace', when: 'tomorrow 9am' })],
    ['a cancelled reminder', ownTool(SCHEDULE_SERVER_ID, 'cancel_reminder', { id: 'r1' })],
    ['a new persona', ownTool(PERSONA_SERVER_ID, 'create_persona', { name: 'Planner' })],
    ['a new skill', ownTool(SKILL_SERVER_ID, 'install_skill', { url: 'https://github.com/acme/skills' })],
    ['an entry in the notes inbox', ownTool(NOTES_FOLDER_SERVER_ID, 'append_to_inbox', { text: 'Buy milk' })],
    ['a new note', ownTool(NOTES_FOLDER_SERVER_ID, 'create_note', { path: 'ideas.md', text: 'An idea' })],
    [
      'a fact on a memory page',
      ownTool(MEMORY_PAGES_SERVER_ID, 'remember_fact', { about: 'Wendy', text: 'Likes tulips.' }),
    ],
    ['a tool these sets do not have', ownTool(SPACE_SERVER_ID, 'purge_spaces')],
  ])('refuses %s without a card', async (_label, action) => {
    const decision = await classifyTier(action, incognitoChat());
    expect(decision).toMatchObject(REFUSED);
    expect(decision.reason_detail).toContain('ask again in a normal chat');
  });

  it.each([
    ['its spaces', ownTool(SPACE_SERVER_ID, 'list_spaces')],
    ['one space', ownTool(SPACE_SERVER_ID, 'get_space', { name: 'Trip' })],
    ['its schedules', ownTool(SCHEDULE_SERVER_ID, 'list_schedules')],
    ['its reminders', ownTool(SCHEDULE_SERVER_ID, 'list_reminders')],
    ['its personas', ownTool(PERSONA_SERVER_ID, 'list_personas')],
    ['its skills', ownTool(SKILL_SERVER_ID, 'list_skills')],
    ['a note', ownTool(NOTES_FOLDER_SERVER_ID, 'read_note', { path: 'ideas.md' })],
    ['its notes', ownTool(NOTES_FOLDER_SERVER_ID, 'search_notes', { query: 'milk' })],
    ['a memory page', ownTool(MEMORY_PAGES_SERVER_ID, 'read_page', { about: 'Wendy' })],
  ])('still reads %s without a card', async (_label, action) => {
    expect(await classifyTier(action, incognitoChat())).toMatchObject({ tier: 1, card: null, auto_deny: null });
  });

  it('still switches this chat to a persona the person already has', async () => {
    const decision = await classifyTier(
      ownTool(PERSONA_SERVER_ID, 'use_persona', { name: 'Planner' }),
      incognitoChat(),
    );
    expect(decision).toMatchObject({ tier: 1, auto_deny: null });
  });

  it('refuses the same things in a scheduled run of an incognito chat', async () => {
    const services = forUnattendedRun(forIncognitoChat(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' })));
    const decision = await classifyTier(
      ownTool(SPACE_SERVER_ID, 'edit_space', { name: 'Trip', body: 'x' }),
      makeCtx(services),
    );
    expect(decision).toMatchObject(REFUSED);
  });

  it('leaves a normal chat as it was', async () => {
    const decision = await classifyTier(
      ownTool(NOTES_FOLDER_SERVER_ID, 'create_note', { path: 'a.md', text: 'x' }),
      normalChat(),
    );
    expect(decision).toMatchObject({ tier: 1, auto_deny: null });
  });
});

describe('a connector in an incognito chat may only read', () => {
  it.each([
    ['a write', connectorTool('create_page', {}, { title: 'Trip', body: 'Notes' })],
    ['a write the connector calls read-only', connectorTool('create_page', SAYS_READ_ONLY, { title: 'Trip' })],
    ['a delete', connectorTool('delete_page', { destructive_hint: true }, { page: 'Trip' })],
    ['a tool whose name says nothing, called read-only by the connector', connectorTool('sync', SAYS_READ_ONLY)],
  ])('refuses %s without a card', async (_label, action) => {
    expect(await classifyTier(action, incognitoChat())).toMatchObject(REFUSED);
  });

  it('still asks for a read the gate knows by its name, as in a normal chat', async () => {
    const action = connectorTool('search_messages', {}, { query: 'lease' });
    const incognito = await classifyTier(action, incognitoChat());
    const normal = await classifyTier(action, normalChat());
    expect(incognito.auto_deny).toBeNull();
    expect({ tier: incognito.tier, reason: incognito.reason }).toEqual({ tier: normal.tier, reason: normal.reason });
  });

  it("still runs a read-only tool on one of the host's own connectors", async () => {
    const action: SentinelAction = { ...connectorTool('lookup_record', SAYS_READ_ONLY), mcp_first_party: true };
    expect(await classifyTier(action, incognitoChat())).toMatchObject({ tier: 1, auto_deny: null });
  });

  it('gives a write in a normal chat its card, as before', async () => {
    const decision = await classifyTier(connectorTool('create_page', {}, { title: 'Trip' }), normalChat());
    expect(decision.auto_deny).toBeNull();
    expect(decision.tier).toBe(3);
  });
});
