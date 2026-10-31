import { personalizationFactLines, type PersonalizationProfile } from '../../../src/personalization/profile';

const profile: PersonalizationProfile = {
  tenant_id: 'default',
  created_by: 'user-a',
  updated_by: 'user-a',
  assistant_name: null,
  assistant_identity: null,
  voice_guidance: null,
  user_name: 'Alice',
  address_as: null,
  user_profile: 'Lives in Lisbon.\n\nLikes tea.',
  pinned_preferences: ['Short answers'],
  help_areas: [],
  learned_profile: '# Learned\n\n- Has a dog named Rex.',
  learning_enabled: true,
  revision: 3,
  digest: '',
  created_at: '2026-08-24T00:00:00.000Z',
  updated_at: '2026-08-24T00:00:00.000Z',
};

describe('personalizationFactLines', () => {
  it('lists every non-empty line of the profile text, pinned preferences, and learned document', () => {
    expect(personalizationFactLines(profile)).toEqual([
      'Lives in Lisbon.',
      'Likes tea.',
      'Short answers',
      '# Learned',
      '- Has a dog named Rex.',
    ]);
  });

  it('is empty for a profile with no text', () => {
    expect(
      personalizationFactLines({ ...profile, user_profile: null, pinned_preferences: [], learned_profile: null }),
    ).toEqual([]);
  });
});
