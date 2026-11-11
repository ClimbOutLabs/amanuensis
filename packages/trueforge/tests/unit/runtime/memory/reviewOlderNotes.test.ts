import { InMemorySessionStore, type PersistedTurnEvent } from '@truefoundry/trueforge-core/agent-session';
import { EventType, newEventId } from '@truefoundry/trueforge-core/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeTurnCreatedEvent,
  makeTurnDoneEvent,
} from '../../../../../trueforge-core/tests/agent-session/testHelpers';
import type { SessionCustom, TurnCustom } from '../../../../src/db/sessionCustom';
import { appendVaultTombstone } from '../../../../src/runtime/memory/markdownMemoryFiles';
import { markReviewedNotesFromYou } from '../../../../src/runtime/memory/memorySourceLines';
import {
  checkReviewIds,
  findReviewCandidates,
  type ReviewScope,
} from '../../../../src/runtime/memory/reviewOlderNotes';

const TENANT = 'default';
const ME = 'alice';
const SAVED_AT = '2026-10-02T10:00:00.000Z';
const NO_RECORD = '> External source: no record';

type Store = InMemorySessionStore<SessionCustom, TurnCustom>;

function note({
  at = SAVED_AT,
  chat = 'chat-1',
  text = 'Likes tea.',
  extra = [],
  closing = NO_RECORD,
}: { at?: string; chat?: string | null; text?: string; extra?: string[]; closing?: string | null } = {}): string {
  return [
    `## ${at}`,
    text,
    ...(chat === null ? [] : [`<!-- session_id: ${chat} -->`]),
    ...extra,
    ...(closing === null ? [] : [closing]),
  ].join('\n\n');
}

async function writeDay({
  baseDir,
  namespace,
  day,
  notes,
}: {
  baseDir: string;
  namespace: string;
  day: string;
  notes: string[];
}) {
  const dir = path.join(baseDir, namespace, 'memory');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${day}.md`), `${notes.map(entry => `${entry}\n`).join('\n')}\n`, 'utf8');
}

function toolCall(name: string) {
  return {
    id: 'call-1',
    type: 'function' as const,
    function: { name, arguments: '{}' },
    tool_info: { type: 'truefoundry-system' as const, name },
  };
}

interface TurnSeed {
  turnId: string;
  previousTurnId?: string;
  completedAt: string;
  withFile?: boolean;
  readsOutside?: boolean;
  persona?: string;
}

async function seedChat({
  store,
  sessionId,
  creator = ME,
  title = 'Tea chat',
  turns,
}: {
  store: Store;
  sessionId: string;
  creator?: string;
  title?: string;
  turns: TurnSeed[];
}): Promise<void> {
  await store.createSession({
    tenant_id: TENANT,
    session_id: sessionId,
    created_by_subject: { subject_id: creator, subject_type: 'user', subject_display_name: creator },
    agent: { type: 'inline', spec: makeAgentSpec() },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
    is_incognito: false,
    private_expires_at: null,
  });
  for (const seed of turns) {
    const base = makeCreateTurnInput<TurnCustom>({
      sessionId,
      turnId: seed.turnId,
      ...(seed.previousTurnId === undefined
        ? {}
        : { previousTurnId: seed.previousTurnId, firstTurnId: turns[0]?.turnId ?? seed.turnId }),
      update_session_title_if_not_exist: title,
    });
    await store.createTurn({
      ...base,
      turn: {
        ...base.turn,
        input:
          seed.withFile === true
            ? [
                {
                  type: EventType.USER_MESSAGE,
                  content: [
                    { type: 'text', text: 'see this' },
                    { type: 'file', name: 'a.pdf', data: 'AAAA' },
                  ],
                },
              ]
            : [{ type: EventType.USER_MESSAGE, content: 'hello' }],
        custom:
          seed.persona === undefined
            ? null
            : { persona: { persona_id: 'p1', persona_name: seed.persona, model_name: 'm', source: 'sticky' } },
      },
    });
    const events: PersistedTurnEvent[] = [makeTurnCreatedEvent(seed.turnId)];
    if (seed.readsOutside === true) {
      events.push(
        {
          type: EventType.MODEL_MESSAGE,
          id: newEventId(),
          created_at: seed.completedAt,
          thread_id: 'main',
          content: null,
          tool_calls: [toolCall('web_fetch')],
        },
        {
          type: EventType.TOOL_RESPONSE,
          id: newEventId(),
          created_at: seed.completedAt,
          thread_id: 'main',
          tool_call_id: 'call-1',
          content: 'text from a page',
        },
      );
    }
    await store.appendToEvents({ session_id: sessionId, turn_id: seed.turnId, events });
    const state = { status: 'done' as const, output: null, required_actions: [], completed_at: seed.completedAt };
    await store.updateTurnState({
      session_id: sessionId,
      turn_id: seed.turnId,
      state,
      turn_done_event: makeTurnDoneEvent(state),
    });
  }
}

describe('finding older notes that may become "From you"', () => {
  let baseDir: string;
  let store: Store;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'review-notes-'));
    store = new InMemorySessionStore<SessionCustom, TurnCustom>();
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const scope = (overrides: Partial<ReviewScope> = {}): ReviewScope => ({
    baseDir,
    tenantNamespace: TENANT,
    vaultNamespace: TENANT,
    tenantId: TENANT,
    subjectId: ME,
    sessionStore: store,
    ...overrides,
  });

  const quietChat = (overrides: Partial<Parameters<typeof seedChat>[0]> = {}) =>
    seedChat({ store, sessionId: 'chat-1', turns: [{ turnId: 't1', completedAt: SAVED_AT }], ...overrides });

  async function candidates(overrides: Partial<ReviewScope> = {}) {
    const found = await findReviewCandidates({ scope: scope(overrides), cursor: 0, now: Date.now });
    return found.candidates.map(candidate => candidate.entryId);
  }

  const ID = `md:${TENANT}:2026-10-02.md#0`;

  async function oneNote(entry: string): Promise<void> {
    await writeDay({ baseDir, namespace: TENANT, day: '2026-10-02', notes: [entry] });
  }

  it('offers a note from a chat that read nothing from outside, with its day, text and chat title', async () => {
    await quietChat();
    await oneNote(note());
    const found = await findReviewCandidates({ scope: scope(), cursor: 0, now: Date.now });
    expect(found).toEqual({
      candidates: [
        { entryId: ID, day: '2026-10-02', text: 'Likes tea.\n\n> External source: no record', chatTitle: 'Tea chat' },
      ],
      nextCursor: null,
    });
  });

  it('refuses a note when a tool result from outside came in the turn that saved it', async () => {
    await quietChat({ turns: [{ turnId: 't1', completedAt: SAVED_AT, readsOutside: true }] });
    await oneNote(note());
    expect(await candidates()).toEqual([]);
    expect((await checkReviewIds({ scope: scope(), entryIds: [ID] })).refused).toEqual([
      { entryId: ID, reason: 'read_outside' },
    ]);
  });

  it('refuses a note when an earlier turn of the same chat read from outside', async () => {
    await quietChat({
      turns: [
        { turnId: 't1', completedAt: '2026-10-01T10:00:00.000Z', readsOutside: true },
        { turnId: 't2', previousTurnId: 't1', completedAt: SAVED_AT },
      ],
    });
    await oneNote(note());
    expect(await candidates()).toEqual([]);
  });

  it('refuses a note when a turn up to the saving turn attached a file', async () => {
    await quietChat({
      turns: [
        { turnId: 't1', completedAt: '2026-10-01T10:00:00.000Z', withFile: true },
        { turnId: 't2', previousTurnId: 't1', completedAt: SAVED_AT },
      ],
    });
    await oneNote(note());
    expect(await candidates()).toEqual([]);
  });

  it('still offers a note when a later turn of the chat read from outside', async () => {
    await quietChat({
      turns: [
        { turnId: 't1', completedAt: SAVED_AT },
        {
          turnId: 't2',
          previousTurnId: 't1',
          completedAt: '2026-10-03T10:00:00.000Z',
          readsOutside: true,
          withFile: true,
        },
      ],
    });
    await oneNote(note());
    expect(await candidates()).toEqual([ID]);
  });

  it('refuses a note whose chat is gone', async () => {
    await oneNote(note({ chat: 'chat-missing' }));
    expect(await candidates()).toEqual([]);
  });

  it('refuses a note whose saving turn is not in the chat', async () => {
    await quietChat();
    await oneNote(note({ at: '2026-10-02T10:00:01.000Z' }));
    expect(await candidates()).toEqual([]);
  });

  it('refuses a note with no chat id and a note that carries a note marker', async () => {
    await quietChat();
    await writeDay({
      baseDir,
      namespace: TENANT,
      day: '2026-10-02',
      notes: [note({ chat: null }), note({ extra: ['<!-- note: email 2026-09-30 -->'] })],
    });
    expect(await candidates()).toEqual([]);
  });

  it.each([
    ['From you', '> From you'],
    ['another external source', '> External source: email'],
    ['no source line', null],
  ])('refuses a note whose closing line is %s', async (_name, closing) => {
    await quietChat();
    await oneNote(note({ closing }));
    expect(await candidates()).toEqual([]);
  });

  it('refuses a note whose chat belongs to someone else', async () => {
    await quietChat({ creator: 'bob' });
    await oneNote(note());
    expect(await candidates()).toEqual([]);
  });

  it('refuses a note saved in one vault by a chat turn that ran under another persona', async () => {
    await quietChat({ turns: [{ turnId: 't1', completedAt: SAVED_AT, persona: 'Maya' }] });
    await oneNote(note());
    expect(await candidates()).toEqual([]);
    const mayaVault = 'default__persona_Maya';
    await writeDay({ baseDir, namespace: mayaVault, day: '2026-10-02', notes: [note()] });
    expect(await candidates({ vaultNamespace: mayaVault })).toEqual([`md:${mayaVault}:2026-10-02.md#0`]);
  });

  it('refuses a deleted note and an edited note', async () => {
    await quietChat();
    await writeDay({
      baseDir,
      namespace: TENANT,
      day: '2026-10-02',
      notes: [note(), note({ text: 'Likes coffee.' })],
    });
    await appendVaultTombstone({
      baseDir,
      namespace: TENANT,
      tombstone: { entryId: ID, action: 'deleted', text: undefined, timestamp: SAVED_AT },
    });
    expect(await candidates()).toEqual([`md:${TENANT}:2026-10-02.md#1`]);
    await appendVaultTombstone({
      baseDir,
      namespace: TENANT,
      tombstone: {
        entryId: `md:${TENANT}:2026-10-02.md#1`,
        action: 'updated',
        text: 'Likes mate.',
        timestamp: SAVED_AT,
      },
    });
    expect(await candidates()).toEqual([]);
  });

  it('stops offering a note once it was marked, and looks at no more than a bounded number of notes', async () => {
    await quietChat();
    await oneNote(note());
    await markReviewedNotesFromYou({ baseDir, namespace: TENANT, entryIds: [ID] });
    expect(await candidates()).toEqual([]);
  });

  it('pages through the older notes with a cursor', async () => {
    await quietChat();
    const notes = Array.from({ length: 3 }, (_unused, index) => note({ text: `Fact ${String(index)}.` }));
    await oneNote(notes.join('\n\n'));
    const found = await findReviewCandidates({ scope: scope(), cursor: 0, now: Date.now });
    expect(found.candidates).toHaveLength(3);
    expect(found.nextCursor).toBeNull();
    const later = await findReviewCandidates({ scope: scope(), cursor: 2, now: Date.now });
    expect(later.candidates).toHaveLength(1);
  });
});
