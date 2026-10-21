import { describe, expect, it } from 'vitest';

import { HELP_AREA_IDS, type HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import {
  CAPABILITY_PROMPTS,
  FIRST_FRAME_CARD_SLOTS,
  MORNING_BRIEF,
  TOUR_ILLUSTRATION_KEYS,
  firstFrameCardPrompts,
  visibleTourPrompts,
  type TourCapabilities,
} from '@/components/tourPrompts.js';

const ALL: TourCapabilities = { email: true, calendar: true, sandbox: true, maps: true };
const NONE: TourCapabilities = { email: false, calendar: false, sandbox: false, maps: false };

function keysFor({ helpAreas, capabilities }: { helpAreas: HelpAreaId[]; capabilities: TourCapabilities }): string[] {
  return firstFrameCardPrompts({ helpAreas, capabilities }).map(item => item.key);
}

describe('firstFrameCardPrompts', () => {
  it('shows the first capability prompts when no area is chosen', () => {
    expect(keysFor({ helpAreas: [], capabilities: NONE })).toEqual(['get-to-know', 'schedule', 'places', 'web']);
    expect(keysFor({ helpAreas: [], capabilities: ALL })).toEqual(['get-to-know', 'email', 'subscriptions', 'reply']);
  });

  it('leads with the cards of the chosen areas, in the order chosen', () => {
    expect(keysFor({ helpAreas: ['focus'], capabilities: ALL })).toEqual([
      'clear-head',
      'break-task',
      'get-started',
      'forgot',
    ]);
    expect(keysFor({ helpAreas: ['work_money', 'focus'], capabilities: ALL })).toEqual([
      'subscriptions',
      'clear-head',
      'invoices',
      'break-task',
    ]);
  });

  it('never returns more than the slots, and never a card twice', () => {
    const repeated: HelpAreaId[] = ['focus', 'focus'];
    for (const helpAreas of [[...HELP_AREA_IDS], repeated]) {
      const keys = keysFor({ helpAreas, capabilities: ALL });
      expect(keys).toHaveLength(FIRST_FRAME_CARD_SLOTS);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('keeps a card whose capability is missing out of the tickets', () => {
    expect(keysFor({ helpAreas: ['focus'], capabilities: NONE })).toEqual([
      'clear-head',
      'break-task',
      'get-started',
      'calm-day',
    ]);
  });

  it('never offers the morning brief as one of the four, since it has its own ticket', () => {
    for (const helpAreas of HELP_AREA_IDS.map(id => [id])) {
      expect(keysFor({ helpAreas, capabilities: ALL })).not.toContain(MORNING_BRIEF.key);
    }
  });
});

describe('visibleTourPrompts', () => {
  it('keeps the prompts that need nothing, and the ones whose capability is granted', () => {
    expect(visibleTourPrompts(CAPABILITY_PROMPTS, NONE).map(item => item.key)).not.toContain('email');
    expect(visibleTourPrompts(CAPABILITY_PROMPTS, { ...NONE, email: true }).map(item => item.key)).toContain('email');
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

  it('gives each of the twelve illustrations to exactly one capability prompt', () => {
    const illustrated = CAPABILITY_PROMPTS.flatMap(item =>
      item.illustration === undefined ? [] : [item.illustration],
    );

    expect(illustrated.sort()).toEqual([...TOUR_ILLUSTRATION_KEYS].sort());
    expect(TOUR_ILLUSTRATION_KEYS).toHaveLength(12);
  });
});
