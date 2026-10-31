import type { ContextMessage } from '@truefoundry/trueforge-core/core';
import { buildPersonalizationContext, type PersonalizationProfile } from '../../../../src/personalization/profile';
import { extractPreviousExchange } from '../../../../src/runtime/memory/memoryCapability';

const profile: PersonalizationProfile = {
  tenant_id: 'default',
  created_by: 'user-a',
  updated_by: 'user-a',
  assistant_name: null,
  assistant_identity: null,
  voice_guidance: null,
  user_name: 'Alice',
  address_as: null,
  user_profile: 'Lives in Lisbon and likes tea.',
  pinned_preferences: ['Short answers'],
  help_areas: [],
  learned_profile: '# Learned\n\nHas a dog named Rex.',
  learning_enabled: true,
  revision: 3,
  digest: '',
  created_at: '2026-08-24T00:00:00.000Z',
  updated_at: '2026-08-24T00:00:00.000Z',
};

describe("the person's words in a turn, with host blocks beside them", () => {
  it("summarizes only the person's sentence when the host personalization block rides in the user message", () => {
    const personalization = buildPersonalizationContext(profile).injected_context;
    const context: ContextMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `<tfy-internal>${personalization}</tfy-internal>` },
          { type: 'text', text: 'I moved to Porto last week.' },
          { type: 'text', text: '<untrusted-document>Lives in Lisbon and likes tea.</untrusted-document>' },
        ],
      },
      { role: 'assistant', content: 'Congratulations on the move.' },
      { role: 'user', content: 'Thanks.' },
    ];
    const exchange = extractPreviousExchange(context);
    expect(exchange?.userText).toBe('I moved to Porto last week.');
    expect(exchange?.userText).not.toContain('Lisbon');
  });
});
