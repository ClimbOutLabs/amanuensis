import { AMAN_GUIDE_DISPLAY_NAME } from '../../../../src/personas/amanGuide/install';
import { matchPersonaInvocation, type PersonaContent } from '../../../../src/personas/persona';

// The text the "Get to know Aman" Tour card sends. The UI test pins the same string's prefix.
const TOUR_CARD_MESSAGE = 'Aman guide, introduce yourself and show me how to get started.';

const guide: PersonaContent = {
  display_name: AMAN_GUIDE_DISPLAY_NAME,
  aliases: [],
  instructions: 'You are the Aman guide.',
  model_name: 'tokenfactory/guide-model',
};

describe('Get to know Aman card message', () => {
  it('invokes the Aman guide by its name, so the reply comes from the guide', () => {
    const match = matchPersonaInvocation({ text: TOUR_CARD_MESSAGE, personas: [guide] });

    expect(match?.persona.display_name).toBe(AMAN_GUIDE_DISPLAY_NAME);
  });
});
