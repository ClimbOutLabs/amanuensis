// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canPlayReward,
  EMPTY_REWARD_LEDGER,
  localDayKey,
  localWeekKey,
  pickHighlightedCard,
  recordReward,
  useHighlightedCard,
  useRewardLedger,
  type RewardContext,
  type RewardLedger,
  type RewardRequest,
} from '@/hooks/useRewardLedger.js';

const CALM: RewardContext = { busy: false, waitingOnPerson: false, hasError: false, scheduleFailedToday: false };

/** Wednesday 21 October 2026, local midday. */
const WED_NOON = new Date(2026, 9, 21, 12, 0, 0);

function play(ledger: RewardLedger, request: RewardRequest, now: Date, context: RewardContext = CALM) {
  const allowed = canPlayReward({ ledger, request, context, now });
  return { allowed, ledger: allowed ? recordReward({ ledger, request, now }) : ledger };
}

describe('reward caps', () => {
  it('ticks play every time on a calm screen', () => {
    let ledger = EMPTY_REWARD_LEDGER;
    for (let i = 0; i < 5; i++) {
      const result = play(ledger, { kind: 'tick' }, WED_NOON);
      expect(result.allowed).toBe(true);
      ledger = result.ledger;
    }
  });

  it('never plays while busy, waiting on the person, or on an error', () => {
    const request: RewardRequest = { kind: 'tick' };
    expect(
      canPlayReward({ ledger: EMPTY_REWARD_LEDGER, request, now: WED_NOON, context: { ...CALM, busy: true } }),
    ).toBe(false);
    expect(
      canPlayReward({
        ledger: EMPTY_REWARD_LEDGER,
        request,
        now: WED_NOON,
        context: { ...CALM, waitingOnPerson: true },
      }),
    ).toBe(false);
    expect(
      canPlayReward({ ledger: EMPTY_REWARD_LEDGER, request, now: WED_NOON, context: { ...CALM, hasError: true } }),
    ).toBe(false);
  });

  it('allows at most one all-clear a day', () => {
    const first = play(EMPTY_REWARD_LEDGER, { kind: 'allClear' }, WED_NOON);
    expect(first.allowed).toBe(true);
    expect(play(first.ledger, { kind: 'allClear' }, new Date(2026, 9, 21, 18, 0, 0)).allowed).toBe(false);
    expect(play(first.ledger, { kind: 'allClear' }, new Date(2026, 9, 22, 9, 0, 0)).allowed).toBe(true);
  });

  it('never runs the all-clear after a schedule failed today', () => {
    expect(
      canPlayReward({
        ledger: EMPTY_REWARD_LEDGER,
        request: { kind: 'allClear' },
        now: WED_NOON,
        context: { ...CALM, scheduleFailedToday: true },
      }),
    ).toBe(false);
  });

  it('plays the first brief of the week once, and not after an all-clear that day', () => {
    const monday = new Date(2026, 9, 19, 7, 30, 0);
    const first = play(EMPTY_REWARD_LEDGER, { kind: 'firstBrief' }, monday);
    expect(first.allowed).toBe(true);
    expect(play(first.ledger, { kind: 'firstBrief' }, new Date(2026, 9, 19, 15, 0, 0)).allowed).toBe(false);
    expect(play(first.ledger, { kind: 'firstBrief' }, new Date(2026, 9, 22, 7, 30, 0)).allowed).toBe(false);
    expect(play(first.ledger, { kind: 'firstBrief' }, new Date(2026, 9, 26, 7, 30, 0)).allowed).toBe(true);
    const cleared = play(EMPTY_REWARD_LEDGER, { kind: 'allClear' }, monday);
    expect(play(cleared.ledger, { kind: 'firstBrief' }, monday).allowed).toBe(false);
  });

  it('plays each milestone once', () => {
    const first = play(EMPTY_REWARD_LEDGER, { kind: 'milestone', key: 'replies-10' }, WED_NOON);
    expect(first.allowed).toBe(true);
    expect(play(first.ledger, { kind: 'milestone', key: 'replies-10' }, WED_NOON).allowed).toBe(false);
    expect(play(first.ledger, { kind: 'milestone', key: 'replies-25' }, WED_NOON).allowed).toBe(true);
  });

  it('limits highlights to three per brief and resets for a new brief', () => {
    let ledger = EMPTY_REWARD_LEDGER;
    for (let i = 0; i < 3; i++) {
      const result = play(ledger, { kind: 'highlight', briefId: 'day-1' }, WED_NOON);
      expect(result.allowed).toBe(true);
      ledger = result.ledger;
    }
    expect(play(ledger, { kind: 'highlight', briefId: 'day-1' }, WED_NOON).allowed).toBe(false);
    expect(play(ledger, { kind: 'highlight', briefId: 'day-2' }, WED_NOON).allowed).toBe(true);
  });

  it('tears at most once a minute', () => {
    const first = play(EMPTY_REWARD_LEDGER, { kind: 'tear' }, WED_NOON);
    expect(first.allowed).toBe(true);
    const thirtySeconds = new Date(WED_NOON.getTime() + 30_000);
    expect(play(first.ledger, { kind: 'tear' }, thirtySeconds).allowed).toBe(false);
    const sixtySeconds = new Date(WED_NOON.getTime() + 60_000);
    expect(play(first.ledger, { kind: 'tear' }, sixtySeconds).allowed).toBe(true);
  });

  it('writes a note at most once a week and never two days in a row', () => {
    const monday = new Date(2026, 9, 19, 9, 0, 0);
    const first = play(EMPTY_REWARD_LEDGER, { kind: 'note' }, monday);
    expect(first.allowed).toBe(true);
    expect(play(first.ledger, { kind: 'note' }, new Date(2026, 9, 20, 9, 0, 0)).allowed).toBe(false);
    expect(play(first.ledger, { kind: 'note' }, new Date(2026, 9, 21, 9, 0, 0)).allowed).toBe(false);
    expect(play(first.ledger, { kind: 'note' }, new Date(2026, 9, 26, 9, 0, 0)).allowed).toBe(true);
  });

  it('keeps the week key on Monday for a Sunday', () => {
    expect(localWeekKey(new Date(2026, 9, 25, 12, 0, 0))).toBe('2026-10-19');
    expect(localWeekKey(new Date(2026, 9, 26, 12, 0, 0))).toBe('2026-10-26');
    expect(localDayKey(WED_NOON)).toBe('2026-10-21');
  });
});

describe('useRewardLedger', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('records a played reward so the next call is refused', () => {
    const { result } = renderHook(() => useRewardLedger());
    expect(result.current.tryPlay({ request: { kind: 'allClear' }, context: CALM, now: WED_NOON })).toBe(true);
    expect(result.current.tryPlay({ request: { kind: 'allClear' }, context: CALM, now: WED_NOON })).toBe(false);
    expect(localStorage.getItem('aui-reward-ledger')).not.toBeNull();
  });

  it('ignores stored data that does not match the ledger shape', () => {
    localStorage.setItem('aui-reward-ledger', JSON.stringify({ lastClearDay: 4 }));
    const { result } = renderHook(() => useRewardLedger());
    expect(result.current.tryPlay({ request: { kind: 'allClear' }, context: CALM, now: WED_NOON })).toBe(true);
  });

  it('refuses a request while the screen is busy and writes nothing', () => {
    const { result } = renderHook(() => useRewardLedger());
    expect(result.current.tryPlay({ request: { kind: 'tear' }, context: { ...CALM, busy: true }, now: WED_NOON })).toBe(
      false,
    );
    expect(localStorage.getItem('aui-reward-ledger')).toBeNull();
  });
});

describe('highlighted card', () => {
  it('picks the first waiting approval, else the next appointment, else none', () => {
    expect(pickHighlightedCard({ firstWaitingApprovalId: 'appr-1', nextAppointmentId: 'stop-2' })).toBe('appr-1');
    expect(pickHighlightedCard({ firstWaitingApprovalId: null, nextAppointmentId: 'stop-2' })).toBe('stop-2');
    expect(pickHighlightedCard({ firstWaitingApprovalId: null, nextAppointmentId: null })).toBeNull();
  });

  it('reads the same pick through the hook', () => {
    const { result } = renderHook(() =>
      useHighlightedCard({ firstWaitingApprovalId: null, nextAppointmentId: 'stop-2' }),
    );
    expect(result.current).toBe('stop-2');
  });
});
