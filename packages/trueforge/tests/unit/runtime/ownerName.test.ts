import winston from 'winston';
import type { IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { OWNER_NAME_SEEDED_KEY, seedOwnerName, seedOwnerNameAtBoot } from '../../../src/runtime/ownerName';

const logger = winston.createLogger({ silent: true });
const TENANT = 'default';
const OWNER = 'robin@example.com';
const KEY = { tenant_id: TENANT, created_by: OWNER };

async function createFixture() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const globalSettingsStore: IGlobalSettingsStore = new SqliteGlobalSettingsStore(db);
  const personalizationStore = new SqlitePersonalizationStore(db);
  return {
    globalSettingsStore,
    personalizationStore,
    seed: (owner_name = 'Robin') =>
      seedOwnerName({
        globalSettingsStore,
        personalizationStore,
        tenant_id: TENANT,
        owner_subject_id: OWNER,
        owner_name,
      }),
    save: (names: { user_name: string | null; address_as: string | null }) =>
      personalizationStore.upsertProfile({
        ...KEY,
        updated_by: OWNER,
        assistant_name: 'Aman',
        assistant_identity: null,
        voice_guidance: null,
        user_profile: 'Likes short answers.',
        pinned_preferences: ['Use bullet points.'],
        help_areas: [],
        learned_profile: null,
        learning_enabled: true,
        ...names,
      }),
  };
}

describe('seedOwnerName', () => {
  it('fills both names of a person with no profile yet', async () => {
    const f = await createFixture();

    await expect(f.seed()).resolves.toBe('seeded');

    const profile = await f.personalizationStore.getProfile(KEY);
    expect(profile).toMatchObject({ user_name: 'Robin', address_as: 'Robin', learning_enabled: false });
    expect(await f.globalSettingsStore.getSetting({ key: OWNER_NAME_SEEDED_KEY })).toBeDefined();
  });

  it('fills only the empty name and keeps everything else of an existing profile', async () => {
    const f = await createFixture();
    await f.save({ user_name: '  ', address_as: 'Dr. Lee' });

    await expect(f.seed()).resolves.toBe('seeded');

    expect(await f.personalizationStore.getProfile(KEY)).toMatchObject({
      user_name: 'Robin',
      address_as: 'Dr. Lee',
      assistant_name: 'Aman',
      user_profile: 'Likes short answers.',
      pinned_preferences: ['Use bullet points.'],
      learning_enabled: true,
    });
  });

  it('never overwrites names the person already set', async () => {
    const f = await createFixture();
    const saved = await f.save({ user_name: 'Robin Lee', address_as: 'Rob' });

    await expect(f.seed()).resolves.toBe('kept_existing');

    const profile = await f.personalizationStore.getProfile(KEY);
    expect(profile).toMatchObject({ user_name: 'Robin Lee', address_as: 'Rob', revision: saved.revision });
  });

  it('runs once, so a name the person clears later stays cleared', async () => {
    const f = await createFixture();
    await f.seed();
    await f.save({ user_name: null, address_as: null });

    await expect(f.seed('Someone Else')).resolves.toBe('already_seeded');

    expect(await f.personalizationStore.getProfile(KEY)).toMatchObject({ user_name: null, address_as: null });
  });
});

describe('seedOwnerNameAtBoot', () => {
  const oidc = { OIDC_USER_REFERENCE_CLAIM: 'email', OIDC_ALLOWED_EMAILS: [OWNER] };

  it('seeds the one allowed email when it is the identity key', async () => {
    const f = await createFixture();

    await seedOwnerNameAtBoot({ ...f, owner_name: 'Robin', oidc, tenant_id: TENANT, logger });

    expect(await f.personalizationStore.getProfile(KEY)).toMatchObject({ user_name: 'Robin' });
  });

  it('seeds nothing without a name or without an email identity', async () => {
    const f = await createFixture();

    await seedOwnerNameAtBoot({ ...f, owner_name: '', oidc, tenant_id: TENANT, logger });
    await seedOwnerNameAtBoot({
      ...f,
      owner_name: 'Robin',
      oidc: { ...oidc, OIDC_USER_REFERENCE_CLAIM: 'sub' },
      tenant_id: TENANT,
      logger,
    });
    await seedOwnerNameAtBoot({ ...f, owner_name: 'Robin', oidc: undefined, tenant_id: TENANT, logger });

    expect(await f.personalizationStore.getProfile(KEY)).toBeUndefined();
    expect(await f.globalSettingsStore.getSetting({ key: OWNER_NAME_SEEDED_KEY })).toBeUndefined();
  });
});
