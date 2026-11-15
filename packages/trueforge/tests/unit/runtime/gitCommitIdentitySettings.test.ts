import { createLogger } from 'winston';

import type { IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import {
  effectiveGitCommitIdentity,
  GIT_COMMIT_IDENTITY_SETTING_KEY,
  readStoredGitCommitIdentity,
} from '../../../src/runtime/gitCommitIdentitySettings';

const logger = createLogger({ silent: true });

function storeWith(value: string | undefined | Error): Pick<IGlobalSettingsStore, 'getSetting'> {
  return {
    getSetting: async ({ key }) => {
      expect(key).toBe(GIT_COMMIT_IDENTITY_SETTING_KEY);
      if (value instanceof Error) {
        throw value;
      }
      return value === undefined ? undefined : { key, value, updated_at: '2026-11-13T00:00:00.000Z' };
    },
  };
}

const NOTHING_CHOSEN = { name: null, email: null };

describe('readStoredGitCommitIdentity', () => {
  it('reads the name and email the person chose', async () => {
    const stored = JSON.stringify({ name: 'Sam Rivera', email: 'sam@example.com' });
    await expect(readStoredGitCommitIdentity({ globalSettingsStore: storeWith(stored), logger })).resolves.toEqual({
      name: 'Sam Rivera',
      email: 'sam@example.com',
    });
  });

  it('reads a name chosen on its own', async () => {
    const stored = JSON.stringify({ name: 'Aman', email: null });
    await expect(readStoredGitCommitIdentity({ globalSettingsStore: storeWith(stored), logger })).resolves.toEqual({
      name: 'Aman',
      email: null,
    });
  });

  it.each([
    ['nothing is stored', undefined],
    ['the read fails', new Error('database is down')],
    ['the stored text is not JSON', 'Sam'],
    ['the stored name could break a commit header', JSON.stringify({ name: 'Sam <x>', email: null })],
  ])('gives nothing chosen when %s', async (_label, value) => {
    await expect(readStoredGitCommitIdentity({ globalSettingsStore: storeWith(value), logger })).resolves.toEqual(
      NOTHING_CHOSEN,
    );
  });
});

describe('effectiveGitCommitIdentity', () => {
  it("uses the person's own name when they chose nothing", () => {
    expect(effectiveGitCommitIdentity({ stored: NOTHING_CHOSEN, personName: ' Sam Rivera ' })).toEqual({
      name: 'Sam Rivera',
      email: 'aman@localhost',
    });
  });

  it('uses the chosen name and email over the defaults', () => {
    expect(
      effectiveGitCommitIdentity({ stored: { name: 'Aman', email: 'sam@example.com' }, personName: 'Sam Rivera' }),
    ).toEqual({ name: 'Aman', email: 'sam@example.com' });
  });

  it.each([null, undefined, '', '   ', 'Sam <x>'])('falls back to Aman when the own name is %p', personName => {
    expect(effectiveGitCommitIdentity({ stored: NOTHING_CHOSEN, personName }).name).toBe('Aman');
  });
});
