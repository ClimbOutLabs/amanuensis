'use client';

import { useThreadIsRunning, type PartState } from '@assistant-ui/core/react';
import { useEffect, useMemo, useState } from 'react';

import { useAuiState } from '../assistant-ui.js';
import { usePrefersReducedMotion } from '../atoms/lib/usePrefersReducedMotion.js';
import { useOptionalMemoryRecall } from '../components/MemoryRecallContext.js';
import { useMemoryTurnContext } from '../containers/MemoryTurnContextProvider.js';
import { parseToolNotDoneReason } from '../utils/toolCallParsing.js';
import {
  deriveWaitQueue,
  LONG_WAIT_MS,
  type WaitQueueMemory,
  type WaitQueuePart,
  type WaitQueueSnapshot,
} from '../utils/waitQueueJourney.js';
import { useContextCompactionActive } from './useContextCompactionActive.js';

export type WaitQueueView = {
  snapshot: WaitQueueSnapshot;
  elapsedMs: number;
  longWait: boolean;
  reducedMotion: boolean;
};

/** Narrows a live part to the queue's input shape. `status` is always present per PartState. */
function toQueuePart(part: PartState): WaitQueuePart {
  const statusType = part.status.type;
  switch (part.type) {
    case 'text':
      return { type: 'text', statusType };
    case 'tool-call':
      return {
        type: 'tool-call',
        statusType,
        toolName: part.toolName,
        argsText: part.argsText,
        notDoneReason: parseToolNotDoneReason(part.result),
      };
    default:
      return { type: part.type, statusType };
  }
}

/**
 * Per-turn wait clocks, keyed by turn id (falling back to the message id).
 * Module-level on purpose: the indicator part unmounts and remounts across
 * the phases of one turn (text streaming, tool calls, streaming again), and a
 * per-mount clock would reset on every remount — the long-wait note could
 * then claim "12s so far" 20 minutes into a turn. Entries are dropped when
 * their turn settles; abandoned ones are pruned lazily by last-seen time, so
 * dead turns can't accumulate and clocks never leak across chats.
 */
const turnStartMs = new Map<string, { start: number; lastSeen: number }>();
const TURN_CLOCK_TTL_MS = 60 * 60 * 1000;

function pruneStaleTurnClocks(now: number): void {
  for (const [key, entry] of turnStartMs) {
    if (now - entry.lastSeen > TURN_CLOCK_TTL_MS) turnStartMs.delete(key);
  }
}

/** Returns the turn's start, recording it on first sight and resuming it on remount. */
function resumeTurnStart(key: string, now: number): number {
  const existing = turnStartMs.get(key);
  if (existing !== undefined) {
    existing.lastSeen = now;
    return existing.start;
  }
  pruneStaleTurnClocks(now);
  turnStartMs.set(key, { start: now, lastSeen: now });
  return now;
}

/** Test support: drops all recorded turn starts (module state is shared across tests). */
export function resetWaitQueueTurnClocks(): void {
  turnStartMs.clear();
}

/**
 * Owns the wait queue's live view for one assistant message: thread running
 * state, message parts, this turn's memory-recall landing, and a cheap 1s
 * elapsed timer. Station derivation itself stays pure in `waitQueueJourney`
 * (see `deriveWaitQueue`), so the no-fake-progress guarantee is unit-testable
 * without React.
 */
export function useWaitQueue(): WaitQueueView {
  const isRunning = useThreadIsRunning();
  const parts = useAuiState(s => s.message.parts);
  // Same turn-id wiring as AssistantMessageContainer: set by the runtime for
  // live and replayed messages, so the recall lookup survives reloads.
  const turnId = useAuiState(s => {
    const value = s.message.metadata.custom.turnId;
    return typeof value === 'string' ? value : undefined;
  });
  const memoryApi = useOptionalMemoryRecall();
  const memoryContext = useMemoryTurnContext(turnId);
  const reducedMotion = usePrefersReducedMotion();
  const sessionId = useAuiState(s => s.threadListItem.remoteId ?? undefined);
  const compacting = useContextCompactionActive(sessionId);

  const queueParts = useMemo(() => parts.map(toQueuePart), [parts]);

  const memory: WaitQueueMemory = useMemo(() => {
    const recall = memoryContext?.recall;
    return {
      available: memoryApi !== null,
      landed: recall != null,
      ...(recall != null ? { items: recall.stats.items, outcome: recall.stats.outcome } : {}),
    };
  }, [memoryApi, memoryContext]);

  // Elapsed wait for the long-queue show, keyed per TURN not per mount: the
  // indicator mounts when the turn starts and must keep one clock across the
  // turn's phases. The interval is 1s and the subtree is tiny, so the
  // re-render cost is negligible.
  const messageId = useAuiState(s => s.message.id);
  const clockKey = turnId ?? messageId;
  const [startMs, setStartMs] = useState<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning) {
      // The turn settled: drop its clock so a later turn reusing this message
      // slot starts fresh instead of resuming a dead turn's time.
      turnStartMs.delete(clockKey);
      setStartMs(null);
      return;
    }
    // A remount mid-turn (e.g. the indicator part cycling across phases)
    // resumes the turn's clock instead of starting a new one.
    setStartMs(resumeTurnStart(clockKey, Date.now()));
    const id = setInterval(() => setTick(tick => tick + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning, clockKey]);

  // Read the clock at render, not from the last tick: a render that is not a tick (or a tick that
  // a busy or hidden tab delivered late) still shows the real time waited, and a settled turn none.
  const elapsedMs = !isRunning || startMs === null ? 0 : Math.max(0, Date.now() - startMs);

  const snapshot = useMemo(
    () => deriveWaitQueue({ isRunning, parts: queueParts, memory, compacting }),
    [isRunning, queueParts, memory, compacting],
  );

  return { snapshot, elapsedMs, longWait: elapsedMs >= LONG_WAIT_MS, reducedMotion };
}
