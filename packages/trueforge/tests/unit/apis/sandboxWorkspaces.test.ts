import { OpenAPIHono } from '@hono/zod-openapi';
import type { ISessionStore, SessionRecord, TurnRecord } from '@truefoundry/trueforge-core/agent-session';
import { SandboxWorkspaceListingSchema } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';
import { z } from 'zod';
import { createSandboxWorkspacesRouter } from '../../../src/apis/sandboxWorkspaces';
import { resolveRequestContext } from '../../../src/auth/identity';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import { disableOidcAuth } from '../../../src/auth/oidc';
import { StandaloneAuthenticator } from '../../../src/auth/standaloneAuthenticator';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import type { SlotWorkspaceSessions } from '../../../src/sandbox/slotBackend';

const SLOT_ONE_SESSION = 'a'.repeat(32);
const SLOT_ONE_ORPHAN = 'c'.repeat(32);
const SLOT_TWO_SESSION = 'b'.repeat(32);

/** The person the standalone sign-in makes every request as. */
const YOU = 'trueforge-default';

function chatRecord(
  sessionId: string,
  title: string | null,
  lastTurnId: string | null,
  owner: string = YOU,
  privateChat = false,
): SessionRecord<SessionCustom> {
  return {
    tenant_id: 'default',
    session_id: sessionId,
    created_by_subject: { subject_id: owner, subject_type: 'user', subject_display_name: owner },
    agent: { type: 'reference', id: 'agent-1', name: 'test-agent' },
    title,
    folder_id: null,
    repository_id: null,
    workspace_cwd: null,
    external_id: null,
    source: null,
    last_turn_id: lastTurnId,
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    updated_at: new Date('2026-10-01T00:00:00.000Z'),
    last_activity_timestamp_ms: 0,
    approval_grants: [],
    task_checklist: { revision: 0, items: [] },
    metrics: { total_duration_ms: 0, total_turns: 0 },
    metadata: {},
    custom: null,
    is_incognito: privateChat,
    private_expires_at: privateChat ? new Date('2026-10-02T00:00:00.000Z') : null,
  };
}

function turnRecord(sessionId: string, turnId: string, sandboxId: string | null): TurnRecord<TurnCustom> {
  return {
    turn_id: turnId,
    session_id: sessionId,
    first_turn_id: turnId,
    ancestor_ids: [],
    previous_turn_id: null,
    state: { status: 'running' },
    input: [],
    snapshot: { threads: {}, mcp_servers: null, sandbox_info: sandboxId === null ? null : { sandbox_id: sandboxId } },
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    updated_at: new Date('2026-10-01T00:00:00.000Z'),
    custom: null,
  };
}

type WorkspacesStore = Pick<ISessionStore<SessionCustom, TurnCustom>, 'findChatsBySandboxIds'>;

/** Answers the one store read the route makes, from chats and the latest turn each recorded. */
function fakeStore(
  chats: SessionRecord<SessionCustom>[],
  turns: TurnRecord<TurnCustom>[],
): WorkspacesStore & {
  reads: string[][];
} {
  const turnById = new Map(turns.map(turn => [turn.turn_id, turn]));
  const reads: string[][] = [];
  return {
    reads,
    findChatsBySandboxIds: ({ sandbox_ids }) => {
      reads.push([...sandbox_ids]);
      const wanted = new Set(sandbox_ids);
      return Promise.resolve(
        chats.flatMap(chat => {
          const sandboxId =
            chat.last_turn_id === null ? undefined : turnById.get(chat.last_turn_id)?.snapshot.sandbox_info?.sandbox_id;
          return sandboxId !== undefined && wanted.has(sandboxId)
            ? [
                {
                  session_id: chat.session_id,
                  title: chat.title,
                  created_by_subject_id: chat.created_by_subject.subject_id,
                  is_private: chat.is_incognito,
                  sandbox_id: sandboxId,
                },
              ]
            : [];
        }),
      );
    },
  };
}

const ResponseSchema = z.object({ data: SandboxWorkspaceListingSchema });
type Listing = z.infer<typeof ResponseSchema>['data'];

async function listWorkspaces(input: {
  sessionStore: WorkspacesStore;
  listSlotWorkspaces: () => Promise<SlotWorkspaceSessions[]>;
}): Promise<{ status: number; listing: Listing }> {
  disableOidcAuth();
  const shell = new OpenAPIHono();
  shell.use('*', createAuthMiddleware(new StandaloneAuthenticator()));
  shell.route(
    '/',
    createSandboxWorkspacesRouter({
      sessionStore: input.sessionStore,
      logger: createLogger({ silent: true }),
      resolveRequestContext,
      listSlotWorkspaces: input.listSlotWorkspaces,
    }),
  );
  const response = await shell.request('/');
  return { status: response.status, listing: ResponseSchema.parse(await response.json()).data };
}

describe('sandbox workspaces listing', () => {
  it('joins each slot session to the chat whose last turn used it, across slots', async () => {
    const store = fakeStore(
      [
        chatRecord('chat-1', 'Trip planning', 'turn-1'),
        // A chat with no title, holding its workspace by the id in its older, unprefixed form.
        chatRecord('chat-2', null, 'turn-2'),
        // A chat that never ran code holds no workspace and joins nothing.
        chatRecord('chat-3', 'No sandbox', 'turn-3'),
      ],
      [
        turnRecord('chat-1', 'turn-1', `v1:slots:s1-${SLOT_ONE_SESSION}`),
        turnRecord('chat-2', 'turn-2', `s2-${SLOT_TWO_SESSION}`),
        turnRecord('chat-3', 'turn-3', null),
      ],
    );
    const { status, listing } = await listWorkspaces({
      sessionStore: store,
      listSlotWorkspaces: () =>
        Promise.resolve([
          {
            slot: 1,
            storeFreeBytes: 1000,
            sessions: [
              { session_id: SLOT_ONE_SESSION, bytes: 4096, entries: 12, last_used: '2026-11-01T10:00:00.000Z' },
              { session_id: SLOT_ONE_ORPHAN, bytes: 2048, entries: 3, last_used: '2026-10-20T09:00:00.000Z' },
            ],
          },
          {
            slot: 2,
            storeFreeBytes: 2000,
            sessions: [
              { session_id: SLOT_TWO_SESSION, bytes: 8192, entries: 30, last_used: '2026-11-02T08:00:00.000Z' },
            ],
          },
        ]),
    });
    expect(status).toBe(200);
    expect(listing.slots).toEqual([
      { slot: 1, workspace_count: 2, total_bytes: 6144, store_free_bytes: 1000 },
      { slot: 2, workspace_count: 1, total_bytes: 8192, store_free_bytes: 2000 },
    ]);
    expect(listing.workspaces).toEqual([
      {
        holder: 'you',
        chat_id: 'chat-1',
        chat_title: 'Trip planning',
        chat_private: false,
        sandbox_id: `s1-${SLOT_ONE_SESSION}`,
        slot: 1,
        bytes: 4096,
        entries: 12,
        last_used: '2026-11-01T10:00:00.000Z',
      },
      {
        // No chat holds this workspace: it is listed honestly, with no chat attached.
        holder: 'none',
        chat_id: null,
        chat_title: null,
        chat_private: false,
        sandbox_id: `s1-${SLOT_ONE_ORPHAN}`,
        slot: 1,
        bytes: 2048,
        entries: 3,
        last_used: '2026-10-20T09:00:00.000Z',
      },
      {
        holder: 'you',
        chat_id: 'chat-2',
        chat_title: null,
        chat_private: false,
        sandbox_id: `s2-${SLOT_TWO_SESSION}`,
        slot: 2,
        bytes: 8192,
        entries: 30,
        last_used: '2026-11-02T08:00:00.000Z',
      },
    ]);
  });

  it("names only your own chats, and shows another person's workspace as theirs with no title", async () => {
    const store = fakeStore(
      [
        chatRecord('chat-mine', 'My plans', 'turn-mine'),
        chatRecord('chat-theirs', 'Their private chat', 'turn-theirs', 'someone-else'),
      ],
      [
        turnRecord('chat-mine', 'turn-mine', `s1-${SLOT_ONE_SESSION}`),
        turnRecord('chat-theirs', 'turn-theirs', `s2-${SLOT_TWO_SESSION}`),
      ],
    );
    const { listing } = await listWorkspaces({
      sessionStore: store,
      listSlotWorkspaces: () =>
        Promise.resolve([
          {
            slot: 1,
            storeFreeBytes: 1000,
            sessions: [{ session_id: SLOT_ONE_SESSION, bytes: 1, entries: 1, last_used: '2026-11-01T10:00:00.000Z' }],
          },
          {
            slot: 2,
            storeFreeBytes: 1000,
            sessions: [{ session_id: SLOT_TWO_SESSION, bytes: 1, entries: 1, last_used: '2026-11-01T10:00:00.000Z' }],
          },
        ]),
    });

    expect(listing.workspaces.map(w => [w.holder, w.chat_id, w.chat_title])).toEqual([
      ['you', 'chat-mine', 'My plans'],
      ['someone_else', null, null],
    ]);
    expect(JSON.stringify(listing)).not.toContain('Their private chat');
  });

  it('shows your own private chat as private, with no title', async () => {
    const store = fakeStore(
      [chatRecord('chat-private', 'Doctor visit notes', 'turn-private', YOU, true)],
      [turnRecord('chat-private', 'turn-private', `s1-${SLOT_ONE_SESSION}`)],
    );
    const { listing } = await listWorkspaces({
      sessionStore: store,
      listSlotWorkspaces: () =>
        Promise.resolve([
          {
            slot: 1,
            storeFreeBytes: 1000,
            sessions: [{ session_id: SLOT_ONE_SESSION, bytes: 1, entries: 1, last_used: '2026-11-01T10:00:00.000Z' }],
          },
        ]),
    });

    expect(listing.workspaces.map(w => [w.holder, w.chat_id, w.chat_title, w.chat_private])).toEqual([
      ['you', 'chat-private', null, true],
    ]);
    expect(JSON.stringify(listing)).not.toContain('Doctor visit notes');
  });

  it('looks up every reported workspace in one read, in both forms a chat may have stored', async () => {
    const store = fakeStore([], []);
    await listWorkspaces({
      sessionStore: store,
      listSlotWorkspaces: () =>
        Promise.resolve([
          {
            slot: 1,
            storeFreeBytes: 1000,
            sessions: [
              { session_id: SLOT_ONE_SESSION, bytes: 1, entries: 1, last_used: '2026-11-01T10:00:00.000Z' },
              { session_id: SLOT_ONE_ORPHAN, bytes: 1, entries: 1, last_used: '2026-11-01T10:00:00.000Z' },
            ],
          },
        ]),
    });

    expect(store.reads).toEqual([
      [
        `s1-${SLOT_ONE_SESSION}`,
        `v1:slots:s1-${SLOT_ONE_SESSION}`,
        `s1-${SLOT_ONE_ORPHAN}`,
        `v1:slots:s1-${SLOT_ONE_ORPHAN}`,
      ],
    ]);
  });

  it('answers an empty listing when the slots backend is off', async () => {
    const { status, listing } = await listWorkspaces({
      sessionStore: fakeStore([], []),
      listSlotWorkspaces: () => Promise.resolve([]),
    });
    expect(status).toBe(200);
    expect(listing).toEqual({ slots: [], workspaces: [] });
  });

  it('lists a slot that holds no workspaces, with its free room', async () => {
    const { status, listing } = await listWorkspaces({
      sessionStore: fakeStore([], []),
      listSlotWorkspaces: () => Promise.resolve([{ slot: 1, storeFreeBytes: 42, sessions: [] }]),
    });
    expect(status).toBe(200);
    expect(listing).toEqual({
      slots: [{ slot: 1, workspace_count: 0, total_bytes: 0, store_free_bytes: 42 }],
      workspaces: [],
    });
  });

  it('answers 500 with the next step when a slot cannot be asked, rather than a partial list', async () => {
    disableOidcAuth();
    const shell = new OpenAPIHono();
    shell.use('*', createAuthMiddleware(new StandaloneAuthenticator()));
    shell.route(
      '/',
      createSandboxWorkspacesRouter({
        sessionStore: fakeStore([], []),
        logger: createLogger({ silent: true }),
        resolveRequestContext,
        listSlotWorkspaces: () => Promise.reject(new Error('socket gone')),
      }),
    );
    const response = await shell.request('/');
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('could not be asked');
  });
});
