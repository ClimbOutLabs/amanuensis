import { describe, expect, it } from 'vitest';

import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import { tryADayPrompts, type TourCapabilities } from '@/components/tourPrompts.js';

const ALL: TourCapabilities = { email: true, calendar: true, sandbox: true, maps: true };
const NONE: TourCapabilities = { email: false, calendar: false, sandbox: false, maps: false };

function keysFor({ helpAreas, capabilities }: { helpAreas: HelpAreaId[]; capabilities: TourCapabilities }): string[] {
  return tryADayPrompts({ helpAreas, capabilities }).map(item => item.key);
}

describe('tryADayPrompts', () => {
  it('shows the general set with the morning brief first when no area is chosen', () => {
    expect(keysFor({ helpAreas: [], capabilities: ALL })).toEqual([
      'brief',
      'scam-check',
      'reply',
      'plan-day',
      'doctor-appointment',
      'subscriptions',
    ]);
  });

  it('keeps only the general cards this instance can run when no area is chosen', () => {
    expect(keysFor({ helpAreas: [], capabilities: NONE })).toEqual(['brief', 'plan-day']);
  });

  it('fills the five cards from one area, then from the general set', () => {
    expect(keysFor({ helpAreas: ['focus'], capabilities: ALL })).toEqual([
      'brief',
      'clear-head',
      'break-task',
      'get-started',
      'forgot',
      'scam-check',
    ]);
  });

  it('spreads the five cards evenly across several areas and shows a shared card once', () => {
    expect(keysFor({ helpAreas: ['family', 'caring'], capabilities: ALL })).toEqual([
      'brief',
      'family-week',
      'care-track',
      'meals',
      'doctor-appointment',
      'care-visit',
    ]);
  });

  it('follows the order the areas were chosen in', () => {
    expect(keysFor({ helpAreas: ['caring', 'family'], capabilities: ALL })).toEqual([
      'brief',
      'care-track',
      'family-week',
      'doctor-appointment',
      'meals',
      'care-visit',
    ]);
  });

  it('leaves out an area card whose capability is missing and fills from the general set', () => {
    expect(keysFor({ helpAreas: ['focus'], capabilities: NONE })).toEqual([
      'brief',
      'clear-head',
      'break-task',
      'get-started',
      'plan-day',
    ]);
  });

  it('shows the maps card only when maps is available', () => {
    expect(keysFor({ helpAreas: ['new_country'], capabilities: { ...ALL, maps: false } })).toEqual([
      'brief',
      'settle',
      'letter',
      'scam-check',
      'reply',
      'plan-day',
    ]);
    expect(keysFor({ helpAreas: ['new_country'], capabilities: ALL })).toEqual([
      'brief',
      'settle',
      'letter',
      'family-doctor',
      'scam-check',
      'reply',
    ]);
  });

  it('keeps the morning brief first whatever the areas', () => {
    const areas: HelpAreaId[] = ['work_money', 'focus', 'family', 'caring', 'new_country'];
    const cards = tryADayPrompts({ helpAreas: areas, capabilities: ALL });

    expect(cards[0]?.key).toBe('brief');
    expect(cards).toHaveLength(6);
  });
});
