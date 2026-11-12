import { instanceOwnerSubjectId, oidcOwnerSubjectId } from '../../../src/runtime/instanceOwner';

const DEFAULT_ID = 'trueforge-default';

describe('instanceOwnerSubjectId', () => {
  it('is the default person when sign-in is off', () => {
    expect(instanceOwnerSubjectId({ signInOff: true, defaultSubjectId: DEFAULT_ID, oidc: undefined })).toBe(DEFAULT_ID);
  });

  it('is the one address the owner signs in with, when people are told apart by email', () => {
    expect(
      instanceOwnerSubjectId({
        signInOff: false,
        defaultSubjectId: DEFAULT_ID,
        oidc: { OIDC_USER_REFERENCE_CLAIM: 'email', OIDC_ALLOWED_EMAILS: ['owner@example.com'] },
      }),
    ).toBe('owner@example.com');
  });

  it('names no owner for several addresses, a pattern or another claim', () => {
    const of = (claim: 'email' | 'sub', allowed: string[]) =>
      instanceOwnerSubjectId({
        signInOff: false,
        defaultSubjectId: DEFAULT_ID,
        oidc: { OIDC_USER_REFERENCE_CLAIM: claim, OIDC_ALLOWED_EMAILS: allowed },
      });
    expect(of('email', ['a@example.com', 'b@example.com'])).toBeUndefined();
    expect(of('email', ['*@example.com'])).toBeUndefined();
    expect(of('sub', ['a@example.com'])).toBeUndefined();
  });
});

describe('oidcOwnerSubjectId', () => {
  it('is the one allowed address when people are told apart by email, and no one otherwise', () => {
    expect(oidcOwnerSubjectId({ OIDC_USER_REFERENCE_CLAIM: 'email', OIDC_ALLOWED_EMAILS: ['owner@example.com'] })).toBe(
      'owner@example.com',
    );
    expect(oidcOwnerSubjectId({ OIDC_USER_REFERENCE_CLAIM: 'email', OIDC_ALLOWED_EMAILS: ['*@example.com'] })).toBe(
      undefined,
    );
    expect(oidcOwnerSubjectId(undefined)).toBeUndefined();
  });
});
