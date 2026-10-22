import { describe, expect, it } from 'vitest';

import { HELP_AREA_IDS, type HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import {
  FIRST_FRAME_CARD_SLOTS,
  KEEP_PAGES_IN_SPACES,
  MORNING_BRIEF,
  TOUR_ILLUSTRATION_KEYS,
  capabilityPrompts,
  firstFrameCardPrompts,
  visibleTourPrompts,
  type TourCapabilities,
} from '@/components/tourPrompts.js';

const ALL: TourCapabilities = { email: true, calendar: true, sandbox: true, maps: true };
const NONE: TourCapabilities = { email: false, calendar: false, sandbox: false, maps: false };

function keysFor({ helpAreas, capabilities }: { helpAreas: HelpAreaId[]; capabilities: TourCapabilities }): string[] {
  return firstFrameCardPrompts({ helpAreas, capabilities, assistantName: 'Aman' }).map(item => item.key);
}

describe('firstFrameCardPrompts', () => {
  it('shows the first capability prompts when no area is chosen, with Spaces in the last slot', () => {
    expect(keysFor({ helpAreas: [], capabilities: NONE })).toEqual(['get-to-know', 'schedule', 'places', 'spaces']);
    expect(keysFor({ helpAreas: [], capabilities: ALL })).toEqual(['get-to-know', 'email', 'subscriptions', 'spaces']);
  });

  it('leads with the cards of the chosen areas, in the order chosen', () => {
    expect(keysFor({ helpAreas: ['focus'], capabilities: ALL })).toEqual([
      'clear-head',
      'break-task',
      'get-started',
      'spaces',
    ]);
    expect(keysFor({ helpAreas: ['work_money', 'focus'], capabilities: ALL })).toEqual([
      'subscriptions',
      'clear-head',
      'invoices',
      'spaces',
    ]);
  });

  it('fills exactly the slots, never repeats a card, and always keeps Spaces', () => {
    const repeated: HelpAreaId[] = ['focus', 'focus'];
    for (const helpAreas of [[...HELP_AREA_IDS], repeated, []]) {
      for (const capabilities of [ALL, NONE]) {
        const keys = keysFor({ helpAreas, capabilities });
        expect(keys).toHaveLength(FIRST_FRAME_CARD_SLOTS);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toContain(KEEP_PAGES_IN_SPACES.key);
      }
    }
  });

  it('keeps a card whose capability is missing out of the tickets', () => {
    expect(keysFor({ helpAreas: ['focus'], capabilities: NONE })).toEqual([
      'clear-head',
      'break-task',
      'get-started',
      'spaces',
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
    const prompts = capabilityPrompts('Aman');
    expect(visibleTourPrompts(prompts, NONE).map(item => item.key)).not.toContain('email');
    expect(visibleTourPrompts(prompts, { ...NONE, email: true }).map(item => item.key)).toContain('email');
  });
});

describe('capabilityPrompts', () => {
  it('offers one Spaces card with no capability requirement, and no documents card', () => {
    const prompts = capabilityPrompts('Aman');
    const spaces = prompts.filter(item => item.key === 'spaces');

    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ label: 'Keep pages in Spaces' });
    expect(spaces[0]?.needs).toBeUndefined();
    expect(prompts.map(item => item.key)).not.toContain('documents');
    expect(visibleTourPrompts(prompts, NONE).map(item => item.key)).toContain('spaces');
  });

  it('names the get-to-know card after the assistant', () => {
    expect(capabilityPrompts('Maya').find(item => item.key === 'get-to-know')).toMatchObject({
      label: 'Get to know Maya',
    });
  });

  it('gives each of the twelve illustrations to exactly one capability prompt', () => {
    const illustrated = capabilityPrompts('Aman').flatMap(item =>
      item.illustration === undefined ? [] : [item.illustration],
    );

    expect(illustrated.sort()).toEqual([...TOUR_ILLUSTRATION_KEYS].sort());
    expect(TOUR_ILLUSTRATION_KEYS).toHaveLength(12);
  });
});
