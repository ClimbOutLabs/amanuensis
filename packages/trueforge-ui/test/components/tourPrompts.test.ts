import { HELP_AREA_IDS } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';
import { describe, expect, it } from 'vitest';

import { HELP_AREAS, visibleTourPrompts, type TourCapabilities, type TourPrompt } from '@/components/tourPrompts.js';

const none: TourCapabilities = { email: false, calendar: false, sandbox: false, maps: false };

describe('visibleTourPrompts', () => {
  const always: TourPrompt = { key: 'always', label: 'Always', prompt: 'a' };
  const mail: TourPrompt = { key: 'mail', label: 'Mail', prompt: 'm', needs: ['email'] };

  it('keeps the prompts that need nothing, and the ones whose capability is granted', () => {
    expect(visibleTourPrompts([always, mail], none).map(item => item.key)).toEqual(['always']);
    expect(visibleTourPrompts([always, mail], { ...none, email: true }).map(item => item.key)).toEqual([
      'always',
      'mail',
    ]);
  });
});

describe('HELP_AREAS', () => {
  it('gives every help area at least one card, and no two cards share a key inside an area', () => {
    for (const id of HELP_AREA_IDS) {
      const keys = HELP_AREAS[id].cards.map(card => card.key);
      expect(keys.length).toBeGreaterThan(0);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
