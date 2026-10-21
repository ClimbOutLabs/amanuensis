import { describe, expect, it } from 'vitest';

import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import {
  GENERAL_DAY_PROMPTS,
  MORNING_BRIEF,
  tryADayPrompts,
  visibleTourPrompts,
  type TourCapabilities,
} from '@/components/tourPrompts.js';

const ALL: TourCapabilities = { email: true, calendar: true, sandbox: true, maps: true };
const NONE: TourCapabilities = { email: false, calendar: false, sandbox: false, maps: false };

function keysFor({ helpAreas, capabilities }: { helpAreas: HelpAreaId[]; capabilities: TourCapabilities }): string[] {
  return tryADayPrompts({ helpAreas, capabilities }).map(item => item.key);
}

describe('tryADayPrompts', () => {
  it('shows the general set when no area is chosen', () => {
    expect(keysFor({ helpAreas: [], capabilities: ALL })).toEqual([
      'clear-head',
      'break-task',
      'plan-day',
      'appointment',
      'meals',
    ]);
  });

  it('keeps only the general cards this instance can run when no area is chosen', () => {
    expect(keysFor({ helpAreas: [], capabilities: NONE })).toEqual(['clear-head', 'break-task', 'plan-day', 'meals']);
  });

  it('fills the row from one area, then from the general set', () => {
    expect(keysFor({ helpAreas: ['focus'], capabilities: ALL })).toEqual([
      'clear-head',
      'break-task',
      'get-started',
      'forgot',
      'plan-day',
      'appointment',
    ]);
  });

  it('spreads the row evenly across several areas and shows a shared card once', () => {
    expect(keysFor({ helpAreas: ['family', 'caring'], capabilities: ALL })).toEqual([
      'family-week',
      'care-track',
      'meals',
      'appointment',
      'care-visit',
      'owe-reply',
    ]);
  });

  it('follows the order the areas were chosen in', () => {
    expect(keysFor({ helpAreas: ['caring', 'family'], capabilities: ALL })).toEqual([
      'care-track',
      'family-week',
      'appointment',
      'meals',
      'care-visit',
      'owe-reply',
    ]);
  });

  it('leaves out an area card whose capability is missing and fills from the general set', () => {
    expect(keysFor({ helpAreas: ['focus'], capabilities: NONE })).toEqual([
      'clear-head',
      'break-task',
      'get-started',
      'plan-day',
      'meals',
    ]);
  });

  it('shows the maps card only when maps is available', () => {
    expect(keysFor({ helpAreas: ['new_country'], capabilities: { ...ALL, maps: false } })).toEqual([
      'settle',
      'letter',
      'clear-head',
      'break-task',
      'plan-day',
      'appointment',
    ]);
    expect(keysFor({ helpAreas: ['new_country'], capabilities: ALL })).toEqual([
      'settle',
      'letter',
      'family-doctor',
      'clear-head',
      'break-task',
      'plan-day',
    ]);
  });

  it('builds a row of six cards from several areas, never the morning brief', () => {
    const areas: HelpAreaId[] = ['work_money', 'focus', 'family', 'caring', 'new_country'];
    const keys = keysFor({ helpAreas: areas, capabilities: ALL });

    expect(keys).toHaveLength(6);
    expect(keys).not.toContain(MORNING_BRIEF.key);
  });

  it('spreads the work and money cards with the general set', () => {
    expect(keysFor({ helpAreas: ['work_money'], capabilities: ALL })).toEqual([
      'subscriptions',
      'invoices',
      'plan-day',
      'clear-head',
      'break-task',
      'appointment',
    ]);
  });
});

describe('visibleTourPrompts', () => {
  it('keeps the general prompts that need nothing, whatever the capabilities', () => {
    expect(visibleTourPrompts(GENERAL_DAY_PROMPTS, NONE).map(item => item.key)).toEqual([
      'clear-head',
      'break-task',
      'plan-day',
      'meals',
    ]);
  });
});
