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

  it('asks for read-only calendar events and never the full calendar', () => {
    expect(scopesForFeatures(['calendar_read', 'gmail_read'])).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ]);
    for (const scope of scopesForFeatures(['gmail_read', 'gmail_compose', 'calendar_read'])) {
      expect(scope).not.toMatch(/auth\/calendar$|calendar\.readonly$|calendar\.events$/);
    }
  });

  it('adds events with the events scope only, never the whole calendar', () => {
    expect(scopesForFeatures(['calendar_write'])).toEqual(['https://www.googleapis.com/auth/calendar.events']);
    for (const scope of scopesForFeatures(['gmail_read', 'gmail_compose', 'calendar_read', 'calendar_write'])) {
      expect(scope).not.toMatch(/auth\/calendar$|calendar\.readonly$/);
    }
    expect(
      grantedFeatures([
        'https://www.googleapis.com/auth/calendar.events.readonly',
        'https://www.googleapis.com/auth/calendar.events',
      ]),
    ).toEqual(['calendar_read', 'calendar_write']);
  });

  it('reads Calendar off the scopes Google returned, alongside mail', () => {
    expect(
      grantedFeatures([
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar.events.readonly',
      ]),
    ).toEqual(['gmail_read', 'calendar_read']);
  });

  it('reads granted features off the scopes Google returned', () => {
    expect(grantedFeatures(['https://www.googleapis.com/auth/gmail.compose', 'openid'])).toEqual(['gmail_compose']);
    expect(grantedFeatures([])).toEqual([]);
  });
});
