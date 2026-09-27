import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import type { HostToolCallPolicyCall } from '@truefoundry/trueforge-core/core';

const EMBEDDING_DIMENSIONS = 384;

function unitVector(): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 1;
  return vector;
}

const mockModel = {
  currentPhase: 'ready' as const,
  ensureReady: async () => true,
  embedQueries: async (texts: string[]) => texts.map(() => unitVector()),
  embedPassages: async (texts: string[]) => texts.map(() => unitVector()),
};

jest.mock('../../../src/runtime/memory/embeddingModel', () => ({
  EMBEDDING_DIMENSIONS: 384,
  getSharedEmbeddingModel: () => mockModel,
  isEmbeddingModelCached: () => false,
}));

import { personaKnowledgeLocation } from '../../../src/personaKnowledge/knowledgePaths';
import {
  extractHistoryKnowledgeQuery,
  resolvePersonaKnowledgeBlock,
} from '../../../src/personaKnowledge/knowledgeTurnContext';
import { openPersonaKnowledgeRepository } from '../../../src/personaKnowledge/sqliteKnowledgeRepository';
import type { KnowledgeRelevanceJudge } from '../../../src/personaKnowledge/knowledgeRelevanceJudge';
import {
  buildInternalSourceToolPolicy,
  createInternalSourceState,
  PERSONA_LIBRARY_NEAR_MISS_MARKER,
} from '../../../src/runtime/internalSourceGuard';

const logger = { warn: () => undefined };

function seedLibrary(knowledgeDir: string, personaId: string, chunks: { text: string; title: string }[]) {
  const { dbPath } = personaKnowledgeLocation({ knowledgeDir, tenantId: 'default', personaId });
  const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: EMBEDDING_DIMENSIONS });
  const document = repo.createDocument({
    title: chunks[0]?.title ?? 'Doc',
    titleExplicit: true,
    source_kind: 'text',
    source_label: 'Pasted text',
    source_url: null,
  });
  repo.setDocumentChunks({
    documentId: document.id,
    chunks: chunks.map(chunk => ({
      text: chunk.text,
      embedding: Float32Array.from(unitVector()),
    })),
  });
  repo.updateDocumentStatus({ documentId: document.id, status: 'ready' });
  repo.close();
}

function userMessage(text: string): TurnInputItem {
  return { type: 'user.message', content: text };
}

function toolApprovalItem(): TurnInputItem {
  return {
    type: 'user.tool_approval',
    thread_id: 'thread-1',
    tool_call_id: 'call-1',
    approval: { status: 'allow' },
  };
}

function webSearchCall(query: string): HostToolCallPolicyCall {
  return {
    functionName: 'mcp__web__web_search',
    underlyingToolName: 'web_search',
    args: { query },
  };
}

const QUESTION = 'What did the solo bakery project sell for?';

async function resolveWithJudge(judge: KnowledgeRelevanceJudge | undefined) {
  const knowledgeDir = mkdtempSync(path.join(tmpdir(), 'pk-turnctx-'));
  seedLibrary(knowledgeDir, 'zara', [
    { text: 'The solo project sold for twenty million dollars.', title: 'Exit story' },
    { text: 'Negotiations took three months.', title: 'Exit story' },
  ]);
  const sourceState = createInternalSourceState();
  const block = await resolvePersonaKnowledgeBlock({
    personaId: 'zara',
    tenantId: 'default',
    turnInput: [userMessage(QUESTION)],
    knowledgeDir,
    modelDir: path.join(knowledgeDir, 'models'),
    logger,
    judge,
    sourceState,
  });
  return { block, sourceState };
}

describe('resolvePersonaKnowledgeBlock near-miss wiring', () => {
  it('makes the judge-reject-all near-miss observable end-to-end: consulted, unanswered, blocked', async () => {
    // The judge rejects every floor candidate: the unit-vector mock makes
    // both chunks clear the floor, so this is the genuine near-miss shape.
    const { block, sourceState } = await resolveWithJudge(async () => []);

    // The turn's wiring: an undefined block plus consulted-without-answer is
    // what arms the PERSONA_LIBRARY_NEAR_MISS_MARKER injection in turns.ts.
    expect(block).toBeUndefined();
    expect(sourceState.libraryConsulted).toBe(true);
    expect(sourceState.libraryAnswered).toBe(false);
    expect(sourceState.libraryQuery).toBe(QUESTION);
    const markerFires = block === undefined && sourceState.libraryConsulted && !sourceState.libraryAnswered;
    expect(markerFires).toBe(true);
    expect(PERSONA_LIBRARY_NEAR_MISS_MARKER).toContain('knowledge library');

    // And the policy built from the same state instance the lookup recorded
    // blocks a web_search about the question. Pre-fix this stayed green:
    // consulted was always false on the near-miss path, so nothing blocked.
    const policy = buildInternalSourceToolPolicy(sourceState);
    const blocked = policy(webSearchCall('solo bakery project sale price'));
    expect(blocked).toBeDefined();
    expect(blocked?.message).toContain('knowledge library');
    // Unrelated open-web questions still pass on the armed turn.
    expect(policy(webSearchCall('weather in Madrid tomorrow'))).toBeUndefined();
  });

  it('binds the policy to the recorded state instance, not a copy', async () => {
    const { sourceState } = await resolveWithJudge(async () => []);
    const policy = buildInternalSourceToolPolicy(sourceState);
    // A policy built from a different (fresh) state instance does not block:
    // the turn's wiring must pass the same instance the lookup wrote.
    const otherPolicy = buildInternalSourceToolPolicy(createInternalSourceState());
    expect(policy(webSearchCall('solo bakery project sale price'))).toBeDefined();
    expect(otherPolicy(webSearchCall('solo bakery project sale price'))).toBeUndefined();
  });

  it('records answered when the judge keeps a passage, leaving web_search alone', async () => {
    const { block, sourceState } = await resolveWithJudge(async () => [0]);

    expect(block).toContain('twenty million dollars');
    expect(sourceState.libraryConsulted).toBe(true);
    expect(sourceState.libraryAnswered).toBe(true);

    const policy = buildInternalSourceToolPolicy(sourceState);
    expect(policy(webSearchCall('solo bakery project sale price'))).toBeUndefined();
  });

  it('records nothing when no persona is active', async () => {
    const knowledgeDir = mkdtempSync(path.join(tmpdir(), 'pk-turnctx-'));
    const sourceState = createInternalSourceState();
    const block = await resolvePersonaKnowledgeBlock({
      personaId: undefined,
      tenantId: 'default',
      turnInput: [userMessage(QUESTION)],
      knowledgeDir,
      modelDir: path.join(knowledgeDir, 'models'),
      logger,
      sourceState,
    });

    expect(block).toBeUndefined();
    expect(sourceState.libraryConsulted).toBe(false);
    expect(sourceState.libraryAnswered).toBe(false);
    expect(sourceState.libraryQuery).toBeUndefined();
  });
});

describe('approval-resubmission fallback', () => {
  async function nearMissTurn(judge: KnowledgeRelevanceJudge | undefined) {
    const knowledgeDir = mkdtempSync(path.join(tmpdir(), 'pk-resubmit-'));
    seedLibrary(knowledgeDir, 'zara', [
      { text: 'The solo project sold for twenty million dollars.', title: 'Exit story' },
      { text: 'Negotiations took three months.', title: 'Exit story' },
    ]);
    const turn1Input = [userMessage(QUESTION)];
    const turn1State = createInternalSourceState();
    const block = await resolvePersonaKnowledgeBlock({
      personaId: 'zara',
      tenantId: 'default',
      turnInput: turn1Input,
      knowledgeDir,
      modelDir: path.join(knowledgeDir, 'models'),
      logger,
      judge,
      sourceState: turn1State,
    });
    return { knowledgeDir, turn1Input, turn1State, block };
  }

  async function resolveResubmission(input: {
    knowledgeDir: string;
    turn1Input: TurnInputItem[];
    previousTurnNearMiss: boolean | undefined;
    judge: KnowledgeRelevanceJudge | undefined;
    historyInputs?: TurnInputItem[][] | undefined;
  }) {
    const turn2State = createInternalSourceState();
    const block = await resolvePersonaKnowledgeBlock({
      personaId: 'zara',
      tenantId: 'default',
      turnInput: [toolApprovalItem()],
      historyInputs: input.historyInputs ?? [input.turn1Input],
      previousTurnNearMiss: input.previousTurnNearMiss,
      knowledgeDir: input.knowledgeDir,
      modelDir: path.join(input.knowledgeDir, 'models'),
      logger,
      judge: input.judge,
      sourceState: turn2State,
    });
    return { block, turn2State };
  }

  it('keeps the near-miss block across an approval resubmission without re-running retrieval', async () => {
    const { knowledgeDir, turn1Input, turn1State } = await nearMissTurn(async () => []);
    expect(turn1State.libraryConsulted).toBe(true);
    expect(turn1State.libraryAnswered).toBe(false);

    // The turn boundary, as turns.ts persists it: only the outcome crosses.
    const previousTurnNearMiss = turn1State.libraryConsulted && !turn1State.libraryAnswered;
    expect(previousTurnNearMiss).toBe(true);

    // The counting judge proves retrieval does not re-run on this path: a
    // re-run would consult the judge (and, failing open, record answered).
    let judgeCalls = 0;
    const countingJudge: KnowledgeRelevanceJudge = async () => {
      judgeCalls += 1;
      return [];
    };
    const { block, turn2State } = await resolveResubmission({
      knowledgeDir,
      turn1Input,
      previousTurnNearMiss,
      judge: countingJudge,
    });

    expect(block).toBeUndefined();
    expect(judgeCalls).toBe(0);
    expect(turn2State.libraryConsulted).toBe(true);
    expect(turn2State.libraryAnswered).toBe(false);
    expect(turn2State.libraryQuery).toBe(QUESTION);

    // The policy built from the resubmission turn's state still blocks a
    // web_search about the original question, and still allows unrelated ones.
    const policy = buildInternalSourceToolPolicy(turn2State);
    const blocked = policy(webSearchCall('solo bakery project sale price'));
    expect(blocked).toBeDefined();
    expect(blocked?.message).toContain('knowledge library');
    expect(policy(webSearchCall('weather in Madrid tomorrow'))).toBeUndefined();
  });

  it('does not arm the resubmission when the previous turn was not a near-miss', async () => {
    // The judge kept a passage: the library answered the question.
    const { knowledgeDir, turn1Input, turn1State } = await nearMissTurn(async () => [0]);
    expect(turn1State.libraryAnswered).toBe(true);
    const previousTurnNearMiss = turn1State.libraryConsulted && !turn1State.libraryAnswered;

    const { turn2State } = await resolveResubmission({
      knowledgeDir,
      turn1Input,
      previousTurnNearMiss,
      judge: async () => [],
    });

    expect(turn2State.libraryConsulted).toBe(false);
    const policy = buildInternalSourceToolPolicy(turn2State);
    expect(policy(webSearchCall('solo bakery project sale price'))).toBeUndefined();
  });

  it('does not arm the resubmission without both a carried near-miss and a history question', async () => {
    const { knowledgeDir, turn1Input } = await nearMissTurn(async () => []);

    // Near-miss recorded but no history to re-derive the question from.
    const noHistory = await resolveResubmission({
      knowledgeDir,
      turn1Input,
      previousTurnNearMiss: true,
      judge: async () => [],
      historyInputs: [],
    });
    expect(noHistory.turn2State.libraryConsulted).toBe(false);

    // History present but nothing carried across the turn boundary.
    const noCarry = await resolveResubmission({
      knowledgeDir,
      turn1Input,
      previousTurnNearMiss: undefined,
      judge: async () => [],
    });
    expect(noCarry.turn2State.libraryConsulted).toBe(false);
    const policy = buildInternalSourceToolPolicy(noCarry.turn2State);
    expect(policy(webSearchCall('solo bakery project sale price'))).toBeUndefined();
  });

  it('finds the latest user question across chained resubmission history', () => {
    // Newest-first: another resubmission turn with no user message on top.
    expect(extractHistoryKnowledgeQuery([[toolApprovalItem()], [userMessage(QUESTION)]])).toBe(QUESTION);
    expect(extractHistoryKnowledgeQuery([[toolApprovalItem()]])).toBeUndefined();
    expect(extractHistoryKnowledgeQuery(undefined)).toBeUndefined();
    expect(extractHistoryKnowledgeQuery([])).toBeUndefined();
  });
});
