import type { TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { EventType, InMemorySessionStore, Sessions } from '@truefoundry/trueforge-core/agent-session';
import type { ILLM } from '@truefoundry/trueforge-core/core';
import winston from 'winston';
import { drainTurnEvents } from '../../../src/apis/turns';
import type { AppendPassthroughEventsInput, ICompletedTurnEventStore } from '../../../src/db/completedTurnEvents';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { IPersonalizationStore } from '../../../src/db/personalizationStore';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteTurnArtifactStore } from '../../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import type { PersonalizationProfileContent } from '../../../src/personalization/profile';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { HindsightClient } from '../../../src/runtime/memory/hindsightClient';
import type { ProfileLearningDrainMember, ProfileLearningPassConfig } from '../../../src/runtime/profileLearning';
import { resolveSandboxProvider } from '../../../src/runtime/sessionResources';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 25));
}

async function waitFor(condition: () => boolean): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 5000) {
      throw new Error('timed out waiting for the drain to reach the expected step');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function passConfig(): ProfileLearningPassConfig {
  return { modelFqn: '', minIntervalMs: 3_600_000, retainTimeoutMs: 1_000 };
}

class RecordingEventStore implements ICompletedTurnEventStore {
  readonly appends: AppendPassthroughEventsInput[] = [];

  appendEventsToDoneTurn(input: AppendPassthroughEventsInput): Promise<void> {
    this.appends.push(input);
    return Promise.resolve();
  }
}

/** Distillation LLM whose answer blocks until the caller releases the gate. */
function gatedLlm(gate: Promise<void>): {
  llm: ILLM;
  createNonStream: jest.Mock<ReturnType<ILLM['createNonStream']>, Parameters<ILLM['createNonStream']>>;
} {
  const createNonStream = jest.fn<ReturnType<ILLM['createNonStream']>, Parameters<ILLM['createNonStream']>>(
    async () => {
      await gate;
      return {
        output: { role: 'assistant', content: '{"learned_profile": "# Learned"}' },
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        finish_reason: 'stop',
      };
    },
  );
  const llm: ILLM = {
    create(): ReturnType<ILLM['create']> {
      throw new Error('streaming is not used by the distillation pass');
    },
    createNonStream,
  };
  return { llm, createNonStream };
}

async function seedProfile(params: {
  store: IPersonalizationStore;
  content?: Partial<PersonalizationProfileContent>;
}): Promise<void> {
  await params.store.upsertProfile({
    tenant_id: 'default',
    created_by: 'user-a',
    updated_by: 'user-a',
    assistant_name: null,
    assistant_identity: null,
    voice_guidance: null,
    user_profile: null,
    pinned_preferences: [],
    learned_profile: null,
    learning_enabled: true,
    ...params.content,
  });
}

describe('drainTurnEvents awaits the TURN_DONE submissions', () => {
  it('does not resolve until memory retain, profile learning, and artifact persistence all finish', async () => {
    const retainGate = Promise.withResolvers<void>();
    const profileGate = Promise.withResolvers<void>();
    const artifactsGate = Promise.withResolvers<void>();

    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    try {
      // Memory retain: the submission blocks on its gate; the verification check reads completed.
      const memoryClient = new HindsightClient({
        apiBase: 'https://hindsight.test.example',
        bank: 'aman',
        headers: {},
        fetchImpl: () => Promise.reject(new Error('drain tests must not reach the network')),
      });
      const retain = jest.spyOn(memoryClient, 'retain').mockImplementation(async () => {
        await retainGate.promise;
        return { ok: true };
      });
      jest.spyOn(memoryClient, 'getOperation').mockResolvedValue({ ok: true, status: 'completed' });

      // Profile learning: the distillation LLM blocks on its gate.
      const { llm, createNonStream } = gatedLlm(profileGate.promise);
      const personalizationStore = new SqlitePersonalizationStore(db);
      await seedProfile({ store: personalizationStore });
      const profileLearning: ProfileLearningDrainMember = {
        config: passConfig(),
        personalizationStore,
        eventStore: new RecordingEventStore(),
        modelProviderStore: new SqliteModelProviderStore(db),
        tokenFactoryBudget: uncappedTokenFactoryBudget,
        memoryClient: undefined,
        tenantId: 'default',
        createdBy: 'user-a',
        userText: 'I prefer plain English.',
        turnModelFqn: 'test-provider/test-model',
        resolveLlm: jest.fn().mockResolvedValue(llm),
      };

      // Artifact persistence: the session lookup blocks on its gate, then resolves to no
      // session, which takes the early-return path inside the persistence step.
      const sessions = new Sessions<SessionCustom, TurnCustom>({
        sessionStore: new InMemorySessionStore<SessionCustom, TurnCustom>(),
      });
      const sessionsGet = jest.spyOn(sessions, 'get').mockImplementation(async () => {
        await artifactsGate.promise;
        return undefined;
      });

      async function* stream(): AsyncGenerator<TurnStreamingEvent> {
        yield {
          type: EventType.TURN_DONE,
          id: 'evt_done',
          created_at: '2026-09-01T12:00:00.000Z',
          state: {
            status: 'done',
            output: {
              type: 'model.message',
              id: 'evt_model_message',
              thread_id: 'main',
              created_at: '2026-09-01T12:00:00.000Z',
              content: 'Done.',
            },
            required_actions: [],
            completed_at: '2026-09-01T12:00:00.000Z',
          },
          thread_id: null,
        };
      }

      const registry = new EventSubscriptionRegistry<TurnStreamingEvent>(undefined);
      const executionDeadline = new TurnExecutionDeadline({
        abortController: new AbortController(),
        default_timeout_ms: 60_000,
        finalization_buffer_ms: 1_000,
      });
      executionDeadline.arm();

      const turnDrains = new TurnDrainRegistry();
      let drainSettled = false;
      const drainPromise = drainTurnEvents({
        trackedStream: stream(),
        turnEventStream: registry.get('stream-1'),
        sessionId: 's1',
        turnId: 't1',
        executionDeadline,
        logger: winston.createLogger({ silent: true }),
        turnDrains,
        memory: { client: memoryClient, userText: 'hi', attachedFiles: false, sessionTitle: undefined },
        profileLearning,
        artifacts: {
          turnArtifactStore: new SqliteTurnArtifactStore(db),
          sandboxProviderStore: new SqliteSandboxProviderStore(db),
          sandboxProviderResolver: resolveSandboxProvider,
          sessions,
          tenantId: 'test-tenant',
        },
      }).then(() => {
        drainSettled = true;
      });

      // The drain reaches the retain submission and waits on its gate.
      await waitFor(() => retain.mock.calls.length > 0);
      await tick();
      expect(drainSettled).toBe(false);

      // Releasing retain lets profile learning start; the drain still waits.
      retainGate.resolve();
      await waitFor(() => createNonStream.mock.calls.length > 0);
      await tick();
      expect(drainSettled).toBe(false);

      // Releasing profile learning lets artifact persistence start; the drain still waits.
      profileGate.resolve();
      await waitFor(() => sessionsGet.mock.calls.length > 0);
      await tick();
      expect(drainSettled).toBe(false);

      // Releasing artifact persistence lets the drain finish and unregister.
      artifactsGate.resolve();
      await drainPromise;
      expect(drainSettled).toBe(true);
      expect(turnDrains.size).toBe(0);
    } finally {
      await db.destroy();
    }
  });
});
