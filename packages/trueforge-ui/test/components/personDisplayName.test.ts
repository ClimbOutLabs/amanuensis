import { describe, expect, it } from 'vitest';

import { personDisplayName } from '@/components/personDisplayName.js';

describe('personDisplayName', () => {
  it('prefers the name the person asked to be called', () => {
    expect(
      personDisplayName({
        profile: { address_as: 'Mum', user_name: 'Maria Lopez' },
        signInName: 'maria@example.com',
      }),
    ).toBe('Mum');
  });

  it('falls back to the name the person gave, when there is no address_as', () => {
    expect(
      personDisplayName({
        profile: { address_as: null, user_name: 'Maria Lopez' },
        signInName: 'maria@example.com',
      }),
    ).toBe('Maria Lopez');
  });

  it('falls back to the sign-in name when the profile has no name', () => {
    expect(personDisplayName({ profile: { address_as: '  ', user_name: null }, signInName: ' Alex ' })).toBe('Alex');
    expect(personDisplayName({ profile: null, signInName: 'alex@example.com' })).toBe('alex@example.com');
  });

  it('never shows the placeholder sign-in name owner, in any case', () => {
    expect(personDisplayName({ profile: null, signInName: 'owner' })).toBeUndefined();
    expect(personDisplayName({ profile: null, signInName: ' Owner ' })).toBeUndefined();
    expect(personDisplayName({ profile: { address_as: null, user_name: null }, signInName: 'OWNER' })).toBeUndefined();
  });

  it('still shows a name the person chose, even when it reads owner', () => {
    expect(personDisplayName({ profile: { address_as: 'owner', user_name: null }, signInName: 'owner' })).toBe('owner');
  });

  it('is hidden when no name is usable', () => {
    expect(personDisplayName({ profile: null, signInName: undefined })).toBeUndefined();
    expect(personDisplayName({ profile: { address_as: '', user_name: '   ' }, signInName: '' })).toBeUndefined();
  });
});
