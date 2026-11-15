import type { TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { CancellationReason, EventType } from '@truefoundry/trueforge-core/agent-session';
import type { ILLM } from '@truefoundry/trueforge-core/core';
import type { Server } from 'node:http';
import winston from 'winston';
import { drainTurnEvents } from '../../../src/apis/turns';
import type { AppendPassthroughEventsInput, ICompletedTurnEventStore } from '../../../src/db/completedTurnEvents';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { IPersonalizationStore } from '../../../src/db/personalizationStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteTokenFactoryUsageStore } from '../../../src/db/sqlite/token-factory-usage-store/SqliteTokenFactoryUsageStore';
import {
  LEARNED_PROFILE_MAX_CHARACTERS,
  type PersonalizationProfileContent,
} from '../../../src/personalization/profile';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { type RetainOutcome } from '../../../src/runtime/memory/memoryClient';
import type { ProfileLineSuggestion } from '../../../src/runtime/memory/memorySummarize';
import {
  addLearnedLines,
  learnedProfileLines,
  PROFILE_LEARNING_ACTOR,
  submitProfileLearning,
  type ProfileLearningDrainMember,
} from '../../../src/runtime/profileLearning';
import { createTokenFactoryBudget } from '../../../src/runtime/tokenFactoryBudget';
import { ensureEnvManagedTokenFactoryProvider } from '../../../src/runtime/tokenFactoryProvider';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';
import { discardedModelUsage } from '../../fixtures/discardedModelUsage';
import { inMemoryGlobalSettingsStore } from '../../fixtures/inMemoryGlobalSettingsStore';
import { QuietMemoryClient } from '../../fixtures/memory/quietMemoryClient';
import { startModelEndpointStub } from '../../fixtures/modelEndpointStub';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

function makeLogger() {
  return winston.createLogger({ silent: true });
}

class RecordingEventStore implements ICompletedTurnEventStore {
  readonly appends: AppendPassthroughEventsInput[] = [];

  appendEventsToDoneTurn(input: AppendPassthroughEventsInput): Promise<void> {
    this.appends.push(input);
    return Promise.resolve();
  }
}

type CreateNonStreamMock = jest.Mock<ReturnType<ILLM['createNonStream']>, Parameters<ILLM['createNonStream']>>;

/** A complete ILLM: the pass only ever calls `createNonStream`, and streaming is refused loudly. */
function llmAnswering(text: string, onCall?: () => Promise<void>): { llm: ILLM; createNonStream: CreateNonStreamMock } {
  const createNonStream = jest.fn<ReturnType<ILLM['createNonStream']>, Parameters<ILLM['createNonStream']>>(
    async () => {
      await onCall?.();
      return {
        output: { role: 'assistant', content: text },
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        finish_reason: 'stop',
      };
    },
  );
  const llm: ILLM = {
    create(): ReturnType<ILLM['create']> {
      throw new Error('streaming is not used by the fact call');
    },
    createNonStream,
  };
  return { llm, createNonStream };
}

type DeleteDocumentSpy = jest.SpyInstance<Promise<RetainOutcome>, Parameters<QuietMemoryClient['deleteDocument']>>;
type RetainSpy = jest.SpyInstance<Promise<RetainOutcome>, Parameters<QuietMemoryClient['retain']>>;

/**
 * A real client with `retain` and `deleteDocument` scripted on the instance: the constructor and the method signature
 * are the client's own, so a change to either fails these tests at compile time. Its fetch is
 * wired to reject, which keeps an unscripted call from ever reaching the network.
 */
function retainingClient(outcome: RetainOutcome = { ok: true }): {
  client: QuietMemoryClient;
  retain: RetainSpy;
  deleteDocument: DeleteDocumentSpy;
} {
  const client = new QuietMemoryClient();
  const retain = jest.spyOn(client, 'retain').mockResolvedValue(outcome);
  const deleteDocument = jest.spyOn(client, 'deleteDocument').mockResolvedValue({ ok: true });
  return { client, retain, deleteDocument };
}

/**
 * Learning is the profile's own switch, so a pass only ever runs for a user whose row opted in.
 * Every harness starts from one, and tests that need different content go through here too.
 */
async function seedProfile(params: {
  store: IPersonalizationStore;
  updatedBy?: string;
  content?: Partial<PersonalizationProfileContent>;
}): Promise<void> {
  await params.store.upsertProfile({
    tenant_id: 'default',
    created_by: 'user-a',
    updated_by: params.updatedBy ?? 'user-a',
    assistant_name: null,
    assistant_identity: null,
    voice_guidance: null,
    user_name: null,
    address_as: null,
    user_profile: null,
    pinned_preferences: [],
    help_areas: [],
    learned_profile: null,
    learning_enabled: true,
    ...params.content,
  });
}

const RULE: ProfileLineSuggestion = { text: 'The person prefers plain English.', kind: 'rule' };
const LEARNED = '## How to work with me\n- The person prefers plain English.';
/** What the fact call answers for the turn "I prefer plain English.". */
const FACT_REPLY = JSON.stringify({
  facts: ['The person prefers plain English.'],
  profile: [{ fact: 1, kind: 'rule' }],
});

function food(n: number): string {
  return `The person likes food number ${String(n)}, with a comment about how they cook it.`;
}

describe('learnedProfileLines', () => {
  it('lists the lines without headings or bullets, in document order', () => {
    expect(
      learnedProfileLines('## How to work with me\n- Be brief.\n\n## About me\n- Lives in Pune.\nKeeps bees.'),
    ).toEqual(['Be brief.', 'Lives in Pune.', 'Keeps bees.']);
    expect(learnedProfileLines(null)).toEqual([]);
  });
});

describe('addLearnedLines', () => {
  it('starts the document with a rule under its heading, and a fact under its own', () => {
    const edit = addLearnedLines({
      document: null,
      lines: [RULE, { text: 'The person lives in Pune.', kind: 'fact' }],
      maxCharacters: 4000,
    });
    expect(edit).toEqual({
      document: `${LEARNED}\n\n## About me\n- The person lives in Pune.`,
      moved: [],
    });
  });

  it('adds below the lines already there and rewords none of them', () => {
    const before = '## How to work with me\n- Be brief.\n\n## About me\n- Lives in Pune.';
    const edit = addLearnedLines({
      document: before,
      lines: [
        { text: 'Never send mail without asking.', kind: 'rule' },
        { text: 'Keeps bees.', kind: 'fact' },
      ],
      maxCharacters: 4000,
    });
    expect(edit.document).toBe(
      '## How to work with me\n- Be brief.\n- Never send mail without asking.\n\n## About me\n- Lives in Pune.\n- Keeps bees.',
    );
    expect(edit.moved).toEqual([]);
  });

  it('keeps a document written before headings, or edited by hand, as it is and adds around it', () => {
    const before = '# Notes\nSam likes tea.\n\nSam works nights.';
    const edit = addLearnedLines({
      document: before,
      lines: [RULE, { text: 'Keeps bees.', kind: 'fact' }],
      maxCharacters: 4000,
    });
    expect(edit.document).toBe(
      `${LEARNED}\n\n# Notes\nSam likes tea.\n\nSam works nights.\n\n## About me\n- Keeps bees.`,
    );
  });

  it('returns the document untouched when it already holds every line', () => {
    const before = '## About me\n\n\n- Lives in Pune.';
    const edit = addLearnedLines({
      document: before,
      lines: [{ text: 'lives in pune.', kind: 'fact' }],
      maxCharacters: 4000,
    });
    expect(edit).toEqual({ document: before, moved: [] });
  });

  it('takes out the line a new one replaces and hands it back as written', () => {
    const edit = addLearnedLines({
      document: '## About me\n- Lives in Portland.\n- Keeps bees.',
      lines: [{ text: 'Lives in Seattle.', kind: 'fact', replaces: 'Lives in Portland.' }],
      maxCharacters: 4000,
    });
    expect(edit).toEqual({
      document: '## About me\n- Keeps bees.\n- Lives in Seattle.',
      moved: ['Lives in Portland.'],
    });
  });

  it('adds the line anyway when the line it names is no longer there', () => {
    const edit = addLearnedLines({
      document: '## About me\n- Keeps bees.',
      lines: [{ text: 'Lives in Seattle.', kind: 'fact', replaces: 'Lives in Portland.' }],
      maxCharacters: 4000,
    });
    expect(edit).toEqual({ document: '## About me\n- Keeps bees.\n- Lives in Seattle.', moved: [] });
  });

  it('makes room by moving the oldest fact out whole, never by shortening, and keeps every rule', () => {
    let document: string | null = '## How to work with me\n- Keep replies short.';
    const moved: string[] = [];
    for (let n = 1; n <= 500; n += 1) {
      const edit = addLearnedLines({ document, lines: [{ text: food(n), kind: 'fact' }], maxCharacters: 4000 });
      document = edit.document;
      moved.push(...edit.moved);
    }
    const kept = learnedProfileLines(document);
    expect((document ?? '').length).toBeLessThanOrEqual(4000);
    // The rule said first is still there after five hundred foods.
    expect(kept[0]).toBe('Keep replies short.');
    // The newest foods are in front, each with its comment intact.
    expect(kept.at(-1)).toBe(food(500));
    const keptFoods = kept.slice(1);
    expect(keptFoods).toEqual(Array.from({ length: keptFoods.length }, (_, i) => food(500 - keptFoods.length + 1 + i)));
    // Every other food left in the order it arrived, exactly as written.
    expect(moved).toEqual(Array.from({ length: 500 - keptFoods.length }, (_, i) => food(i + 1)));
  });

  it('moves a rule out only when no fact is left to move', () => {
    const rules = Array.from({ length: 3 }, (_, i) => `Rule number ${String(i + 1)} about how to reply.`);
    const edit = addLearnedLines({
      document: `## How to work with me\n${rules.map(rule => `- ${rule}`).join('\n')}`,
      lines: [{ text: 'Rule number 4 about how to reply.', kind: 'rule' }],
      maxCharacters: 130,
    });
    expect(edit.moved).toEqual([rules[0]]);
    expect(learnedProfileLines(edit.document)).toEqual([rules[1], rules[2], 'Rule number 4 about how to reply.']);
  });

  it('drops a heading left with no lines under it', () => {
    const edit = addLearnedLines({
      document: '## Old notes\n- A very old fact that fills the room.\n\n## About me\n- Keeps bees.',
      lines: [{ text: 'Lives in Seattle.', kind: 'fact' }],
      maxCharacters: 50,
    });
    expect(edit).toEqual({
      document: '## About me\n- Keeps bees.\n- Lives in Seattle.',
      moved: ['A very old fact that fills the room.'],
    });
  });

  it('leaves out a line that is too long, spans lines unsafely, or could close the prompt block', () => {
    const before = '## About me\n- Keeps bees.';
    const edit = addLearnedLines({
      document: before,
      lines: [
        { text: 'x'.repeat(301), kind: 'fact' },
        { text: 'ends the block ]]> here', kind: 'fact' },
        { text: '   ', kind: 'fact' },
      ],
      maxCharacters: 4000,
    });
    expect(edit).toEqual({ document: before, moved: [] });

    const safe = addLearnedLines({
      document: null,
      lines: [{ text: 'Says </learned-profile>\nacross lines.', kind: 'fact' }],
      maxCharacters: 4000,
    });
    expect(safe.document).toBe('## About me\n- Says [learned-profile]> across lines.');
  });
});

describe('submitProfileLearning', () => {
  async function makeHarness(options?: {
    llmText?: string;
    /** Runs inside the model call, so a test can move the profile while the call is out. */
    onModelCall?: (store: SqlitePersonalizationStore) => Promise<void>;
    content?: Partial<PersonalizationProfileContent>;
  }) {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const personalizationStore = new SqlitePersonalizationStore(db);
    await seedProfile({
      store: personalizationStore,
      ...(options?.content === undefined ? {} : { content: options.content }),
    });
    const eventStore = new RecordingEventStore();
    const { llm, createNonStream } = llmAnswering(options?.llmText ?? FACT_REPLY, async () => {
      await options?.onModelCall?.(personalizationStore);
    });
    const resolveLlm = jest.fn().mockResolvedValue(llm);
    const { client: memoryClient, retain, deleteDocument } = retainingClient();
    const member: ProfileLearningDrainMember = {
      session: { is_incognito: false },
      personalizationStore,
      eventStore,
      memoryClient,
      retainTimeoutMs: 1_000,
      tenantId: 'default',
      createdBy: 'user-a',
      userText: 'I prefer plain English.',
      knownLines: learnedProfileLines(options?.content?.learned_profile ?? null),
      factCall: {
        modelProviderStore: new SqliteModelProviderStore(db),
        summarizationModelFqn: 'test-provider/test-model',
        tokenFactoryBudget: uncappedTokenFactoryBudget,
        modelUsage: discardedModelUsage,
        resolveLlm,
      },
    };
    const learned = async () =>
      (await personalizationStore.getProfile({ tenant_id: 'default', created_by: 'user-a' }))?.learned_profile;
    return {
      db,
      personalizationStore,
      eventStore,
      createNonStream,
      resolveLlm,
      retain,
      deleteDocument,
      member,
      learned,
    };
  }

  /** A turn whose fact call already ran and suggested `suggestions`; undefined means no fact call ran. */
  function turnFields(suggestions?: readonly ProfileLineSuggestion[]) {
    return {
      sessionId: 's1',
      turnId: 't1',
      completedAt: '2026-09-01T12:00:00.000Z',
      assistantText: 'Noted.',
      suggestions,
      logger: makeLogger(),
    };
  }

  it('learns nothing from a private chat, and never calls the model', async () => {
    const harness = await makeHarness();
    await submitProfileLearning({ ...harness.member, session: { is_incognito: true }, ...turnFields() });

    expect(harness.resolveLlm).not.toHaveBeenCalled();
    expect(harness.retain).not.toHaveBeenCalled();
    expect(harness.deleteDocument).not.toHaveBeenCalled();
    expect(await harness.learned()).toBeNull();
    await harness.db.destroy();
  });

  it('adds what the turn’s fact call suggested without a model call of its own, and appends the audit event', async () => {
    const harness = await makeHarness();
    await submitProfileLearning({ ...harness.member, ...turnFields([RULE]) });

    expect(harness.resolveLlm).not.toHaveBeenCalled();
    const profile = await harness.personalizationStore.getProfile({ tenant_id: 'default', created_by: 'user-a' });
    expect(profile?.learned_profile).toBe(LEARNED);
    expect(profile?.updated_by).toBe(PROFILE_LEARNING_ACTOR);

    expect(harness.eventStore.appends).toHaveLength(1);
    const append = harness.eventStore.appends[0];
    expect(append?.session_id).toBe('s1');
    expect(append?.turn_id).toBe('t1');
    expect(append?.events[0]).toMatchObject({
      type: 'aman.profile.learned',
      previous: null,
      current: LEARNED,
      revision: 2,
    });

    expect(harness.retain).not.toHaveBeenCalled();
    expect(harness.deleteDocument).toHaveBeenCalledTimes(1);
    expect(harness.deleteDocument.mock.calls[0]?.[0]).toMatchObject({
      documentId: expect.stringMatching(/^aman-learned-profile-[0-9a-f]{16}$/),
      context: 'Learned user profile',
    });
    await harness.db.destroy();
  });

  it('learns a second thing said straight after the first: nothing holds learning back between turns', async () => {
    const harness = await makeHarness();
    await submitProfileLearning({ ...harness.member, ...turnFields([RULE]) });
    await submitProfileLearning({
      ...harness.member,
      ...turnFields([{ text: 'The person keeps bees.', kind: 'fact' }]),
      turnId: 't2',
    });

    expect(await harness.learned()).toBe(`${LEARNED}\n\n## About me\n- The person keeps bees.`);
    expect(harness.eventStore.appends).toHaveLength(2);
    await harness.db.destroy();
  });

  it('makes no model call and no write when the fact call ran and suggested nothing', async () => {
    const harness = await makeHarness();
    await submitProfileLearning({ ...harness.member, ...turnFields([]) });

    expect(harness.resolveLlm).not.toHaveBeenCalled();
    expect(await harness.learned()).toBeNull();
    expect(harness.eventStore.appends).toHaveLength(0);
    expect(harness.deleteDocument).toHaveBeenCalledTimes(1);
    await harness.db.destroy();
  });

  it('makes the fact call itself, once, when none ran for the turn', async () => {
    const harness = await makeHarness({
      content: { learned_profile: '## About me\n- The person keeps bees.' },
    });
    await submitProfileLearning({ ...harness.member, ...turnFields() });

    expect(harness.createNonStream).toHaveBeenCalledTimes(1);
    const sent = (harness.createNonStream.mock.calls[0]?.[0]?.messages ?? []).map(m => m.content).join('\n');
    expect(sent).toContain('<profile>\n1. The person keeps bees.\n</profile>');
    expect(sent).toContain('User: I prefer plain English.');
    expect(await harness.learned()).toBe(`${LEARNED}\n\n## About me\n- The person keeps bees.`);
    await harness.db.destroy();
  });

  it('writes nothing when the model answers garbage', async () => {
    const harness = await makeHarness({ llmText: 'not json at all' });
    await submitProfileLearning({ ...harness.member, ...turnFields() });

    expect(await harness.learned()).toBeNull();
    expect(harness.eventStore.appends).toHaveLength(0);
    await harness.db.destroy();
  });

  it('skips a turn that carried no user text before it touches the profile', async () => {
    const harness = await makeHarness();
    const getProfile = jest.spyOn(harness.personalizationStore, 'getProfile');
    await submitProfileLearning({ ...harness.member, userText: '   ', ...turnFields() });

    expect(getProfile).not.toHaveBeenCalled();
    expect(harness.resolveLlm).not.toHaveBeenCalled();
    await harness.db.destroy();
  });

  it('skips without a model call or a write when the profile has learning off', async () => {
    const harness = await makeHarness({ content: { learning_enabled: false, user_profile: 'Plain English.' } });
    await submitProfileLearning({ ...harness.member, ...turnFields() });
    await submitProfileLearning({ ...harness.member, ...turnFields([RULE]) });

    expect(harness.resolveLlm).not.toHaveBeenCalled();
    expect(await harness.learned()).toBeNull();
    expect(harness.deleteDocument).not.toHaveBeenCalled();
    await harness.db.destroy();
  });

  it('skips when the user has no profile row, which has never opted in', async () => {
    const harness = await makeHarness();
    await harness.personalizationStore.deleteProfile({ tenant_id: 'default', created_by: 'user-a' });
    await submitProfileLearning({ ...harness.member, ...turnFields([RULE]) });

    expect(
      await harness.personalizationStore.getProfile({ tenant_id: 'default', created_by: 'user-a' }),
    ).toBeUndefined();
    expect(harness.deleteDocument).not.toHaveBeenCalled();
    await harness.db.destroy();
  });

  it('writes nothing when the user turns learning off during the model call', async () => {
    const harness = await makeHarness({
      onModelCall: async store => {
        await seedProfile({ store, content: { learning_enabled: false, user_profile: 'Plain English.' } });
      },
    });
    await submitProfileLearning({ ...harness.member, ...turnFields() });

    expect(await harness.learned()).toBeNull();
    expect(harness.eventStore.appends).toHaveLength(0);
    expect(harness.deleteDocument).not.toHaveBeenCalled();
    await harness.db.destroy();
  });

  it('adds to the user’s own edit when they change the profile during the model call', async () => {
    const harness = await makeHarness({
      onModelCall: async store => {
        await seedProfile({
          store,
          content: { user_profile: 'Edited meanwhile.', learned_profile: '## About me\n- Typed by hand.' },
        });
      },
    });
    await submitProfileLearning({ ...harness.member, ...turnFields() });

    const profile = await harness.personalizationStore.getProfile({ tenant_id: 'default', created_by: 'user-a' });
    expect(profile?.user_profile).toBe('Edited meanwhile.');
    expect(profile?.learned_profile).toBe(`${LEARNED}\n\n## About me\n- Typed by hand.`);
    await harness.db.destroy();
  });

  it('reads the profile again and adds to it when a save lands between its read and its write', async () => {
    const harness = await makeHarness();
    const upsert = harness.personalizationStore.upsertProfile.bind(harness.personalizationStore);
    let raced = false;
    jest.spyOn(harness.personalizationStore, 'upsertProfile').mockImplementation(async input => {
      if (!raced) {
        raced = true;
        await seedProfile({
          store: {
            ...harness.personalizationStore,
            upsertProfile: upsert,
            getProfile: harness.personalizationStore.getProfile.bind(harness.personalizationStore),
            deleteProfile: harness.personalizationStore.deleteProfile.bind(harness.personalizationStore),
          },
          content: { learned_profile: '## About me\n- Typed by hand.' },
        });
      }
      return upsert(input);
    });
    await submitProfileLearning({ ...harness.member, ...turnFields([RULE]) });

    expect(await harness.learned()).toBe(`${LEARNED}\n\n## About me\n- Typed by hand.`);
    expect(harness.eventStore.appends).toHaveLength(1);
    await harness.db.destroy();
  });

  describe('a full profile', () => {
    const rule = '- Keep replies short.';
    const head = `## How to work with me\n${rule}\n\n## About me`;
    // As many foods as fit under the limit, so the document has no room for one more line.
    let full = head;
    for (let n = 1; `${full}\n- ${food(n)}`.length <= LEARNED_PROFILE_MAX_CHARACTERS; n += 1) {
      full = `${full}\n- ${food(n)}`;
    }
    const newest: ProfileLineSuggestion = {
      text: 'The person is allergic to peanuts and carries an injector everywhere they go, even on short walks.',
      kind: 'fact',
    };

    it('is full to within one line, so the next line needs room', () => {
      expect(full.length).toBeLessThanOrEqual(LEARNED_PROFILE_MAX_CHARACTERS);
      expect(full.length + newest.text.length + 3).toBeGreaterThan(LEARNED_PROFILE_MAX_CHARACTERS);
    });

    it('moves the oldest fact into memory exactly as written, as the person’s own words, and adds the new line', async () => {
      const harness = await makeHarness({ content: { learned_profile: full } });
      await submitProfileLearning({ ...harness.member, ...turnFields([newest]) });

      const lines = learnedProfileLines((await harness.learned()) ?? null);
      expect(lines[0]).toBe('Keep replies short.');
      expect(lines).not.toContain(food(1));
      expect(lines[1]).toBe(food(2));
      expect(lines.at(-1)).toBe(newest.text);

      expect(harness.retain).toHaveBeenCalledTimes(1);
      const saved = harness.retain.mock.calls[0]?.[0];
      expect(saved?.items).toEqual([
        {
          content: food(1),
          timestamp: '2026-09-01T12:00:00.000Z',
          document_id: expect.stringMatching(/^aman-profile-line-[0-9a-f]{24}$/),
          metadata: { source: 'aman-profile-line', origin: 'tool_ingested' },
        },
      ]);
      await harness.db.destroy();
    });

    it('leaves the profile as it was when memory does not take the line', async () => {
      const harness = await makeHarness({ content: { learned_profile: full } });
      harness.retain.mockResolvedValue({ ok: false, reason: 'memory is down' });
      await submitProfileLearning({ ...harness.member, ...turnFields([newest]) });

      expect(await harness.learned()).toBe(full);
      expect(harness.eventStore.appends).toHaveLength(0);
      await harness.db.destroy();
    });

    it('leaves the profile as it was when there is no memory to move a line into', async () => {
      const harness = await makeHarness({ content: { learned_profile: full } });
      await submitProfileLearning({ ...harness.member, memoryClient: undefined, ...turnFields([newest]) });

      expect(await harness.learned()).toBe(full);
      await harness.db.destroy();
    });
  });

  it('does not fail the pass when removing the old copy fails', async () => {
    const harness = await makeHarness();
    harness.deleteDocument.mockRejectedValue(new Error('memory is down'));
    await submitProfileLearning({ ...harness.member, ...turnFields([RULE]) });

    expect(await harness.learned()).toBe(LEARNED);
    await harness.db.destroy();
  });

  describe('on Token Factory', () => {
    const NOW = new Date('2026-10-15T09:00:00.000Z');
    const TODAY = '2026-10-15';
    const CAP = 1000;
    const servers: Server[] = [];

    afterEach(() => {
      for (const server of servers.splice(0)) {
        server.close();
      }
    });

    async function tokenFactoryHarness(providerType: 'tokenfactory' | 'custom') {
      const harness = await makeHarness();
      const stub = await startModelEndpointStub({
        usage: { prompt_tokens: 400, completion_tokens: 60 },
        content: FACT_REPLY,
      });
      servers.push(stub.server);
      const modelProviderStore = new SqliteModelProviderStore(harness.db);
      if (providerType === 'tokenfactory') {
        await ensureEnvManagedTokenFactoryProvider({
          store: modelProviderStore,
          tenant_id: 'default',
          settings: {
            apiKey: 'sk-nebius',
            baseUrl: stub.baseUrl,
            model: 'nvidia/nemotron-3-super-120b-a12b',
          },
          catalogModels: [],
          logger: makeLogger(),
        });
      } else {
        await modelProviderStore.upsertProvider({
          tenant_id: 'default',
          name: 'local-vllm',
          manifest: {
            type: 'custom',
            name: 'local-vllm',
            base_url: stub.baseUrl,
            models: [{ model_id: 'local-model', name: 'local-model', properties: {} }],
          },
        });
      }
      const usageStore = new SqliteTokenFactoryUsageStore(harness.db);
      const submit = () =>
        submitProfileLearning({
          ...harness.member,
          factCall: {
            modelProviderStore,
            tokenFactoryBudget: createTokenFactoryBudget({ store: usageStore, cap: CAP, now: () => NOW }),
            modelUsage: discardedModelUsage,
            summarizationModelFqn:
              providerType === 'tokenfactory' ? 'tokenfactory/nemotron-3-super-120b-a12b' : 'local-vllm/local-model',
          },
          ...turnFields(),
        });
      return { harness, submit, usageStore };
    }

    it('counts the tokens its own fact call reports', async () => {
      const { harness, submit, usageStore } = await tokenFactoryHarness('tokenfactory');

      await submit();

      expect((await usageStore.getUsage({ usage_date: TODAY }))?.used_tokens).toBe(460);
      expect(harness.eventStore.appends).toHaveLength(1);
      await harness.db.destroy();
    });

    it('skips the call once the cap is reached', async () => {
      const { harness, submit, usageStore } = await tokenFactoryHarness('tokenfactory');
      await usageStore.addUsage({
        usage_date: TODAY,
        model_id: 'nvidia/nemotron-3-super-120b-a12b',
        input_tokens: CAP,
        output_tokens: 0,
      });

      await submit();

      expect((await usageStore.getUsage({ usage_date: TODAY }))?.used_tokens).toBe(CAP);
      expect(harness.eventStore.appends).toHaveLength(0);
      await harness.db.destroy();
    });

    it('counts nothing on another provider', async () => {
      const { harness, submit, usageStore } = await tokenFactoryHarness('custom');

      await submit();

      expect(await usageStore.getUsage({ usage_date: TODAY })).toBeUndefined();
      expect(harness.eventStore.appends).toHaveLength(1);
      await harness.db.destroy();
    });
  });

  it('appends the audit event on the retry after one transient store failure', async () => {
    const harness = await makeHarness();
    const append = jest
      .spyOn(harness.eventStore, 'appendEventsToDoneTurn')
      .mockRejectedValueOnce(new Error('database is busy'));

    await submitProfileLearning({ ...harness.member, ...turnFields([RULE]) });

    expect(append).toHaveBeenCalledTimes(2);
    expect(harness.eventStore.appends).toHaveLength(1);
    await harness.db.destroy();
  });

  it('keeps the profile write when the audit append fails twice', async () => {
    const harness = await makeHarness();
    const append = jest
      .spyOn(harness.eventStore, 'appendEventsToDoneTurn')
      .mockRejectedValue(new Error('database is gone'));

    await submitProfileLearning({ ...harness.member, ...turnFields([RULE]) });

    expect(append).toHaveBeenCalledTimes(2);
    // The profile row is authoritative; a lost event never rolls it back.
    const profile = await harness.personalizationStore.getProfile({ tenant_id: 'default', created_by: 'user-a' });
    expect(profile?.learned_profile).toBe(LEARNED);
    expect(harness.deleteDocument).toHaveBeenCalledTimes(1);
    await harness.db.destroy();
  });

  it('echoes the persisted audit event onto the turn stream', async () => {
    const harness = await makeHarness();
    const registry = new EventSubscriptionRegistry<TurnStreamingEvent>(undefined);
    const turnEventStream = registry.get('stream-learned');

    await submitProfileLearning({ ...harness.member, ...turnFields([RULE]), turnEventStream });

    const streamed: TurnStreamingEvent[] = [];
    for await (const event of turnEventStream.poll(0)) {
      streamed.push(event);
      break;
    }
    expect(streamed[0]).toMatchObject({
      type: 'aman.profile.learned',
      previous: null,
      current: LEARNED,
      revision: 2,
    });
    await harness.db.destroy();
  });

  it('never streams an audit event it could not persist', async () => {
    const harness = await makeHarness();
    jest.spyOn(harness.eventStore, 'appendEventsToDoneTurn').mockRejectedValue(new Error('database is gone'));
    const registry = new EventSubscriptionRegistry<TurnStreamingEvent>(undefined);
    const turnEventStream = registry.get('stream-unpersisted');
    const put = jest.spyOn(turnEventStream, 'put');

    await submitProfileLearning({ ...harness.member, ...turnFields([RULE]), turnEventStream });

    expect(put).not.toHaveBeenCalled();
    await harness.db.destroy();
  });

  it('survives a turn stream that refuses the echo', async () => {
    const harness = await makeHarness();
    const registry = new EventSubscriptionRegistry<TurnStreamingEvent>(undefined);
    const turnEventStream = registry.get('stream-broken');
    jest.spyOn(turnEventStream, 'put').mockRejectedValue(new Error('stream gone'));

    await submitProfileLearning({ ...harness.member, ...turnFields([RULE]), turnEventStream });

    const profile = await harness.personalizationStore.getProfile({ tenant_id: 'default', created_by: 'user-a' });
    expect(profile?.learned_profile).toBe(LEARNED);
    expect(harness.eventStore.appends).toHaveLength(1);
    expect(harness.deleteDocument).toHaveBeenCalledTimes(1);
    await harness.db.destroy();
  });
});

describe('drainTurnEvents profile learning trigger', () => {
  function turnDoneEvent(state: 'done' | 'cancelled', assistantText?: string): TurnStreamingEvent {
    if (state === 'done') {
      return {
        type: EventType.TURN_DONE,
        id: 'evt_done',
        created_at: '2026-09-01T12:00:00.000Z',
        state: {
          status: 'done',
          output:
            assistantText === undefined
              ? null
              : {
                  type: 'model.message',
                  id: 'evt_model_message',
                  thread_id: 'main',
                  created_at: '2026-09-01T12:00:00.000Z',
                  content: assistantText,
                },
          required_actions: [],
          completed_at: '2026-09-01T12:00:00.000Z',
        },
        thread_id: null,
      };
    }
    return {
      type: EventType.TURN_DONE,
      id: 'evt_cancelled',
      created_at: '2026-09-01T12:00:00.000Z',
      state: {
        status: 'cancelled',
        reason: CancellationReason.ClientCancelled,
        completed_at: '2026-09-01T12:00:00.000Z',
      },
      thread_id: null,
    };
  }

  async function drainOnce(params: {
    member: ProfileLearningDrainMember;
    state: 'done' | 'cancelled';
    assistantText?: string;
    memory?: NonNullable<Parameters<typeof drainTurnEvents>[0]['memory']>;
  }) {
    async function* stream(): AsyncGenerator<TurnStreamingEvent, void, unknown> {
      yield turnDoneEvent(params.state, params.assistantText);
    }
    const registry = new EventSubscriptionRegistry<TurnStreamingEvent>(undefined);
    const executionDeadline = new TurnExecutionDeadline({
      abortController: new AbortController(),
      default_timeout_ms: 60_000,
      finalization_buffer_ms: 1_000,
    });
    executionDeadline.arm();
    const turnDrains = new TurnDrainRegistry();
    await drainTurnEvents({
      trackedStream: stream(),
      turnEventStream: registry.get('stream-1'),
      sessionId: 's1',
      turnId: 't1',
      executionDeadline,
      logger: makeLogger(),
      turnDrains,
      profileLearning: params.member,
      ...(params.memory === undefined ? {} : { memory: params.memory }),
    });
    // The drain awaits profile learning, so by the time it resolves the write (and its
    // audit event) has finished.
  }

  async function makeMember() {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const { llm, createNonStream } = llmAnswering(FACT_REPLY);
    const personalizationStore = new SqlitePersonalizationStore(db);
    await seedProfile({ store: personalizationStore });
    const resolveLlm = jest.fn().mockResolvedValue(llm);
    const member: ProfileLearningDrainMember = {
      session: { is_incognito: false },
      personalizationStore,
      eventStore: new RecordingEventStore(),
      memoryClient: undefined,
      retainTimeoutMs: 1_000,
      tenantId: 'default',
      createdBy: 'user-a',
      userText: 'I prefer plain English.',
      knownLines: [],
      factCall: {
        modelProviderStore: new SqliteModelProviderStore(db),
        summarizationModelFqn: 'test-provider/test-model',
        tokenFactoryBudget: uncappedTokenFactoryBudget,
        modelUsage: discardedModelUsage,
        resolveLlm,
      },
    };
    return { db, member, createNonStream, resolveLlm };
  }

  it('runs the pass when the turn completes with status done', async () => {
    const { db, member } = await makeMember();
    await drainOnce({ member, state: 'done' });
    const profile = await member.personalizationStore.getProfile({ tenant_id: 'default', created_by: 'user-a' });
    expect(profile?.learned_profile).toBe(LEARNED);
    await db.destroy();
  });

  it('never runs the pass for a cancelled turn', async () => {
    const { db, member, resolveLlm } = await makeMember();
    await drainOnce({ member, state: 'cancelled' });
    expect(resolveLlm).not.toHaveBeenCalled();
    expect(
      (await member.personalizationStore.getProfile({ tenant_id: 'default', created_by: 'user-a' }))?.learned_profile,
    ).toBeNull();
    await db.destroy();
  });

  it('never forwards the assistant reply to the model, so a name the assistant wrote about the user cannot enter the learned profile', async () => {
    const { db, member, createNonStream } = await makeMember();
    // A regression case: the assistant's own answer once asserted a wrong name for the user
    // ("Prepared for: Aman (QA tester)"), and the pass learned it as fact. Even though the turn's
    // reply carries that text here, it must never reach the model call.
    await drainOnce({ member, state: 'done', assistantText: 'Prepared for: Aman (QA tester).' });

    expect(createNonStream).toHaveBeenCalledTimes(1);
    const sentMessages = createNonStream.mock.calls[0]?.[0]?.messages ?? [];
    const sentText = sentMessages.map(message => message.content).join('\n');
    expect(sentText).not.toContain('Aman (QA tester)');
    expect(sentText).not.toContain('Prepared for');
    expect(sentText).toContain('I prefer plain English.');

    const profile = await member.personalizationStore.getProfile({ tenant_id: 'default', created_by: 'user-a' });
    expect(profile?.learned_profile).toBe(LEARNED);
    await db.destroy();
  });
  it('learns from the one call that also decides what to remember, and makes no call of its own', async () => {
    const { db, member, createNonStream, resolveLlm } = await makeMember();
    const { client, retain } = retainingClient();
    jest.spyOn(client, 'getOperation').mockResolvedValue({ ok: true, status: 'completed' });

    await drainOnce({
      member,
      state: 'done',
      assistantText: 'Noted.',
      memory: {
        client,
        session: { is_incognito: false },
        userText: member.userText,
        attachedFiles: false,
        summarize: {
          tenantId: 'default',
          modelProviderStore: member.factCall.modelProviderStore,
          summarizationModelFqn: 'test-provider/test-model',
          tokenFactoryBudget: uncappedTokenFactoryBudget,
          globalSettingsStore: inMemoryGlobalSettingsStore(),
          modelUsage: discardedModelUsage,
          resolveLlm,
        },
      },
    });

    // One model call for the whole turn: its facts went to memory and its profile line to the profile.
    expect(createNonStream).toHaveBeenCalledTimes(1);
    expect(retain.mock.calls[0]?.[0].items[0]?.content).toBe('The person prefers plain English.');
    const profile = await member.personalizationStore.getProfile({ tenant_id: 'default', created_by: 'user-a' });
    expect(profile?.learned_profile).toBe(LEARNED);
    await db.destroy();
  });

  it('makes no call of its own when the turn’s fact call failed', async () => {
    const { db, member, createNonStream } = await makeMember();
    const { client } = retainingClient();
    jest.spyOn(client, 'getOperation').mockResolvedValue({ ok: true, status: 'completed' });
    const failing = jest.fn().mockRejectedValue(new Error('model is down'));

    await drainOnce({
      member,
      state: 'done',
      memory: {
        client,
        session: { is_incognito: false },
        userText: member.userText,
        attachedFiles: false,
        summarize: {
          tenantId: 'default',
          modelProviderStore: member.factCall.modelProviderStore,
          summarizationModelFqn: 'test-provider/test-model',
          tokenFactoryBudget: uncappedTokenFactoryBudget,
          globalSettingsStore: inMemoryGlobalSettingsStore(),
          modelUsage: discardedModelUsage,
          resolveLlm: failing,
        },
      },
    });

    expect(failing).toHaveBeenCalledTimes(1);
    expect(createNonStream).not.toHaveBeenCalled();
    expect(
      (await member.personalizationStore.getProfile({ tenant_id: 'default', created_by: 'user-a' }))?.learned_profile,
    ).toBeNull();
    await db.destroy();
  });
});
