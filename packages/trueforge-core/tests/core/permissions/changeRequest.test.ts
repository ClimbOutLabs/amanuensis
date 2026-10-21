import { changeRequestReason, isChangeRequestReason } from '../../../src/core/permissions/changeRequest';

describe('changeRequestReason', () => {
  it('states the person asked for changes, with their words trimmed', () => {
    expect(changeRequestReason('  make it shorter  ')).toBe(
      'The person asked for changes before approving: make it shorter. Make the changes and propose it again.',
    );
  });

  it('is recognised as a change request', () => {
    expect(isChangeRequestReason(changeRequestReason('add a greeting'))).toBe(true);
  });

  it('is not mistaken for an ordinary denial reason or a missing reason', () => {
    expect(isChangeRequestReason('not allowed in this test')).toBe(false);
    expect(isChangeRequestReason(undefined)).toBe(false);
  });
});
