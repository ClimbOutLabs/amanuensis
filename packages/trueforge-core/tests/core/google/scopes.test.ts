import { grantedFeatures, scopesForFeatures } from '../../../src/core/google/scopes';

describe('Google features and scopes', () => {
  it('asks for the narrowest scope per feature, in feature order, once each', () => {
    expect(scopesForFeatures(['gmail_compose', 'gmail_read', 'gmail_read'])).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ]);
  });

  it('never asks for a full-mailbox scope', () => {
    for (const scope of scopesForFeatures(['gmail_read', 'gmail_compose'])) {
      expect(scope).not.toMatch(/mail\.google\.com|gmail\.modify/);
    }
  });

  it('reads granted features off the scopes Google returned', () => {
    expect(grantedFeatures(['https://www.googleapis.com/auth/gmail.compose', 'openid'])).toEqual(['gmail_compose']);
    expect(grantedFeatures([])).toEqual([]);
  });
});
