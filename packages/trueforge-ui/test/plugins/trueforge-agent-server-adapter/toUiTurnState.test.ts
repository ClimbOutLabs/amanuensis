import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
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
