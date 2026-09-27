import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  describeOAuthScope,
  describeOAuthScopes,
} from '@/containers/SettingsBuilder/oauthScopeLabels.js';

describe('oauthScopeLabels', () => {
  it('describes Gmail scopes in plain language', () => {
    assert.equal(
      describeOAuthScope('https://www.googleapis.com/auth/gmail.readonly'),
      'Read your emails',
    );
    assert.equal(describeOAuthScope('gmail.send'), 'Send emails on your behalf');
  });

  it('describes Calendar scopes in plain language', () => {
    assert.equal(
      describeOAuthScope('https://www.googleapis.com/auth/calendar.readonly'),
      'View your calendars and events',
    );
    assert.equal(describeOAuthScope('calendar.events'), 'View and manage your calendar events');
  });

  it('describes Tasks scopes in plain language', () => {
    assert.equal(
      describeOAuthScope('https://www.googleapis.com/auth/tasks.readonly'),
      'View your task lists and tasks',
    );
    assert.equal(describeOAuthScope('tasks'), 'View and manage your task lists and tasks');
  });

  it('falls back to the raw scope for unknown scopes', () => {
    assert.equal(describeOAuthScope('https://example.com/unknown'), 'https://example.com/unknown');
  });

  it('describes a list of scopes, empty input yields empty list', () => {
    assert.deepEqual(describeOAuthScopes(['calendar.readonly', 'tasks']), [
      'View your calendars and events',
      'View and manage your task lists and tasks',
    ]);
    assert.deepEqual(describeOAuthScopes([]), []);
    assert.deepEqual(describeOAuthScopes(undefined), []);
  });
});
