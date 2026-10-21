import { describe, expect, it } from 'vitest';

import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import {
  CAPABILITY_PROMPTS,
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
      'self-care',
    ]);
  });

  it('keeps only the general cards this instance can run when no area is chosen', () => {
    expect(keysFor({ helpAreas: [], capabilities: NONE })).toEqual([
      'clear-head',
      'break-task',
      'plan-day',
      'meals',
      'self-care',
    ]);
  });

  it('fills the row from one area with all six of its cards', () => {
    expect(keysFor({ helpAreas: ['focus'], capabilities: ALL })).toEqual([
      'clear-head',
      'break-task',
      'get-started',
      'forgot',
      'calm-day',
      'routine',
    ]);
  });

  it('spreads the row evenly across several areas and shows a shared card once', () => {
    expect(keysFor({ helpAreas: ['family', 'caring'], capabilities: ALL })).toEqual([
      'family-week',
      'care-track',
      'meals',
      'care-visit',
      'appointment',
      'owe-reply',
    ]);
  });

  it('follows the order the areas were chosen in', () => {
    expect(keysFor({ helpAreas: ['caring', 'family'], capabilities: ALL })).toEqual([
      'care-track',
      'family-week',
      'care-visit',
      'meals',
      'appointment',
      'medicine',
    ]);
  });

  it('leaves out an area card whose capability is missing and fills from the general set', () => {
    expect(keysFor({ helpAreas: ['focus'], capabilities: NONE })).toEqual([
      'clear-head',
      'break-task',
      'get-started',
      'calm-day',
      'routine',
      'plan-day',
    ]);
  });

  it('fills a shortfall from the other chosen area before the general set', () => {
    expect(keysFor({ helpAreas: ['focus', 'work_money'], capabilities: NONE })).toEqual([
      'clear-head',
      'plan-day',
      'break-task',
      'budget',
      'get-started',
      'tricky-email',
    ]);
  });

  it('shows the doctor appointments card when either calendar or email is available', () => {
    expect(keysFor({ helpAreas: ['family'], capabilities: { ...NONE, email: true } })).toContain('appointment');
    expect(keysFor({ helpAreas: ['family'], capabilities: { ...NONE, calendar: true } })).toContain('appointment');
  });

  it('shows the maps card only when maps is available', () => {
    expect(keysFor({ helpAreas: ['new_country'], capabilities: { ...ALL, maps: false } })).toEqual([
      'settle',
      'letter',
      'newcomers',
      'language',
      'neighborhood',
      'clear-head',
    ]);
    expect(keysFor({ helpAreas: ['new_country'], capabilities: ALL })).toEqual([
      'settle',
      'letter',
      'family-doctor',
      'newcomers',
      'language',
      'neighborhood',
    ]);
  });

  it('builds a row of six cards from several areas, never the morning brief', () => {
    const areas: HelpAreaId[] = ['work_money', 'focus', 'family', 'caring', 'new_country'];
    const keys = keysFor({ helpAreas: areas, capabilities: ALL });

    expect(keys).toHaveLength(6);
    expect(keys).not.toContain(MORNING_BRIEF.key);
  });

  it('shows the six work and money cards in order', () => {
    expect(keysFor({ helpAreas: ['work_money'], capabilities: ALL })).toEqual([
      'subscriptions',
      'invoices',
      'plan-day',
      'budget',
      'meeting',
      'tricky-email',
    ]);
  });

  it('fills the work and money row from the general set when calendar and email are missing', () => {
    expect(keysFor({ helpAreas: ['work_money'], capabilities: NONE })).toEqual([
      'plan-day',
      'budget',
      'tricky-email',
      'clear-head',
      'break-task',
      'meals',
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
      'self-care',
    ]);
  });
});

describe('CAPABILITY_PROMPTS', () => {
  it('offers one Spaces card with no capability requirement, and no documents card', () => {
    const spaces = CAPABILITY_PROMPTS.filter(item => item.key === 'spaces');

    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ label: 'Keep pages in Spaces' });
    expect(spaces[0]?.needs).toBeUndefined();
    expect(CAPABILITY_PROMPTS.map(item => item.key)).not.toContain('documents');
    expect(visibleTourPrompts(CAPABILITY_PROMPTS, NONE).map(item => item.key)).toContain('spaces');
  });
});
