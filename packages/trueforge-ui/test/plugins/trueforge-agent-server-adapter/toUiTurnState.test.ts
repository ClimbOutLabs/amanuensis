import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  extractRecallTimestamp,
  toUiEventItem,
  toUiTurnDoneMetrics,
  toUiTurnState,
} from '@/plugins/trueforge-agent-server-adapter/toUiTurnState.js';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

describe('toUiTurnState', () => {
  it('fills optional SDK token fields so TurnDoneMetrics is complete', () => {
    assert.deepEqual(toUiTurnDoneMetrics({ totalInputTokens: 3, totalCostInUsd: 0.12 }), {
      totalInputTokens: 3,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalReasoningTokens: 0,
      totalCostInUsd: 0.12,
    });
  });

  it('maps a done state with partial metrics', () => {
    assert.deepEqual(
      toUiTurnState({
        status: 'done',
        completedAt: '2026-01-01T00:00:00.000Z',
        output: null,
        requiredActions: [],
        metrics: { totalTokens: 10 },
      }),
      {
        status: 'done',
        completedAt: '2026-01-01T00:00:00.000Z',
        requiredActions: [],
        metrics: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 10,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalReasoningTokens: 0,
        },
      },
    );
  });

  it('extracts aman.memory.recall timestamps for timeline model-bar attribution', () => {
    // The timeline's model bar ("time since the previous event") would absorb
    // the whole recall duration as model time if recall stayed filtered out.
    // These markers let the timeline seed the model-bar start at recall completion.
    const item: TrueForgeApi.SessionEventItem = {
      turnId: 'turn-1',
      event: {
        type: 'aman.memory.recall',
        id: 'evt_recall',
        createdAt: '2026-09-15T00:00:05.000Z',
        injectedBlock: null,
        stats: {
          budgetReason: 'normal',
          droppedBelowThreshold: 0,
          droppedOverBudget: 0,
          entities: 0,
          estimatedTokens: 0,
          items: 0,
          outcome: 'ok',
          recallMs: 3266,
        },
        sweep: { abandoned: 0, pending: 0, retried: 0, verified: 0 },
      },
    };
    assert.deepEqual(extractRecallTimestamp(item), {
      turnId: 'turn-1',
      timestamp: '2026-09-15T00:00:05.000Z',
    });
    // Recall stays filtered out of the events array (vendor type has no shape for it).
    assert.equal(toUiEventItem(item), undefined);
  });

  it('extractRecallTimestamp returns undefined for non-recall events', () => {
    const item: TrueForgeApi.SessionEventItem = {
      turnId: 'turn-1',
      event: {
        type: 'turn.created',
        id: 'evt_1',
        createdAt: '2026-09-15T00:00:00.000Z',
      } as TrueForgeApi.SessionEventItem['event'],
    };
    assert.equal(extractRecallTimestamp(item), undefined);
  });

  it('excludes aman.skill.used from UI event items (host skill-telemetry, not a presentation event)', () => {
    // Regression: the server emits aman.skill.used when an agent reads or
    // executes inside a mounted skill. The vendor union has no shape for it,
    // so the adapter must drop it rather than fail response validation.
    const item: TrueForgeApi.SessionEventItem = {
      turnId: 'turn-1',
      event: {
        type: 'aman.skill.used',
        id: 'evt_1',
        kind: 'skill_read',
        skillName: 'test-skill',
        createdAt: '2026-09-15T00:00:00.000Z',
      },
    };
    assert.equal(toUiEventItem(item), undefined);
  });
});
