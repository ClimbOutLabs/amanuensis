import { createPersonalizationRouter } from '../../../src/apis/personalization';
import type { RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import {
  GetPersonalizationContextResponseSchema,
  GetPersonalizationProfileResponseSchema,
} from '../../../src/schemas/personalization';

const userA: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'user-a', type: 'user', display_name: 'user-a' },
  roles: [],
  user_credential: null,
};
const userB: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'user-b', type: 'user', display_name: 'user-b' },
  roles: [],
  user_credential: null,
};

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('personalization router', () => {
  it('stores the user name and form of address, and reads them as unset when a client omits them', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const router = createPersonalizationRouter({
      personalizationStore: new SqlitePersonalizationStore(db),
      resolveRequestContext: () => userA,
    });
    const base = {
      assistant_name: null,
      assistant_identity: null,
      voice_guidance: null,
      user_profile: null,
      pinned_preferences: [],
    };

    const named = await router.request(
      '/profile',
      jsonInit('PUT', { profile: { ...base, user_name: 'Sam Rivera', address_as: 'Sam' } }),
    );
    const namedBody = GetPersonalizationProfileResponseSchema.parse(await named.json());
    expect(namedBody.data).toMatchObject({ user_name: 'Sam Rivera', address_as: 'Sam', revision: 1 });
    const context = GetPersonalizationContextResponseSchema.parse(await (await router.request('/context')).json());
    expect(context.data?.injected_context).toContain('<user-name>Sam Rivera</user-name>');

    // A client that predates the fields PUTs without them; the complete replace reads them as null.
    const older = await router.request(
      '/profile',
      jsonInit('PUT', { profile: { ...base, user_profile: 'Plain English.' } }),
    );
    const olderBody = GetPersonalizationProfileResponseSchema.parse(await older.json());
    expect(olderBody.data).toMatchObject({ user_name: null, address_as: null, revision: 2 });

    // Only the name is still content: the profile is not empty, so this is not a DELETE in disguise.
    const nameOnly = await router.request('/profile', jsonInit('PUT', { profile: { ...base, user_name: 'Sam' } }));
    expect(nameOnly.status).toBe(200);
  });

  it('keeps profiles user scoped and returns the exact model-facing context', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    let user = userA;
    const router = createPersonalizationRouter({
      personalizationStore: new SqlitePersonalizationStore(db),
      resolveRequestContext: () => user,
    });
    const request = {
      profile: {
        assistant_name: 'Aman',
        assistant_identity: 'A local-first personal assistant.',
        voice_guidance: 'Warm and concise.',
        user_name: null,
        address_as: null,
        user_profile: 'Prefers plain English.',
        pinned_preferences: ['Do not use em dashes.'],
      },
    };

    const created = await router.request('/profile', jsonInit('PUT', request));
    expect(created.status).toBe(200);
    // Parsed through the wire schema rather than asserted into shape: the test then fails on a
    // response that drifts from the published contract, not only on a wrong value.
    const createdBody = GetPersonalizationProfileResponseSchema.parse(await created.json());
    expect(createdBody.data?.revision).toBe(1);

    const context = await router.request('/context');
    const contextBody = GetPersonalizationContextResponseSchema.parse(await context.json());
    expect(contextBody.data?.profile_digest).toBe(createdBody.data?.digest);
    expect(contextBody.data?.injected_context).toContain('<assistant-name>Aman</assistant-name>');

    user = userB;
    expect(await (await router.request('/profile')).json()).toEqual({ data: null });
    user = userA;
    expect((await router.request('/profile', { method: 'DELETE' })).status).toBe(200);
    expect(await (await router.request('/context')).json()).toEqual({ data: null });
  });

  it('round-trips the learned profile on the wire and rejects out-of-bounds documents', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const router = createPersonalizationRouter({
      personalizationStore: new SqlitePersonalizationStore(db),
      resolveRequestContext: () => userA,
    });
    const profileFields = {
      assistant_name: 'Aman',
      assistant_identity: null,
      voice_guidance: null,
      user_name: null,
      address_as: null,
      user_profile: null,
      pinned_preferences: [],
    };

    // Pre-learned-profile clients omit the key; it reads back as null.
    const omitted = await router.request('/profile', jsonInit('PUT', { profile: profileFields }));
    expect(omitted.status).toBe(200);
    const omittedBody = GetPersonalizationProfileResponseSchema.parse(await omitted.json());
    expect(omittedBody.data?.learned_profile).toBeNull();

    const saved = await router.request(
      '/profile',
      jsonInit('PUT', { profile: { ...profileFields, learned_profile: '# Learned\n\n- Plain English.' } }),
    );
    expect(saved.status).toBe(200);
    const savedBody = GetPersonalizationProfileResponseSchema.parse(await saved.json());
    expect(savedBody.data?.learned_profile).toBe('# Learned\n\n- Plain English.');

    const context = await router.request('/context');
    const contextBody = GetPersonalizationContextResponseSchema.parse(await context.json());
    expect(contextBody.data?.injected_context).toContain(
      '<learned-profile>\n# Learned\n\n- Plain English.\n</learned-profile>',
    );

    const oversized = await router.request(
      '/profile',
      jsonInit('PUT', { profile: { ...profileFields, learned_profile: 'x'.repeat(4_001) } }),
    );
    expect(oversized.status).toBe(400);

    const cdata = await router.request(
      '/profile',
      jsonInit('PUT', { profile: { ...profileFields, learned_profile: 'bad ]]> document' } }),
    );
    expect(cdata.status).toBe(400);
  });

  it('round-trips the learning switch and bumps the revision when only it changes', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const router = createPersonalizationRouter({
      personalizationStore: new SqlitePersonalizationStore(db),
      resolveRequestContext: () => userA,
    });
    const profileFields = {
      assistant_name: 'Aman',
      assistant_identity: null,
      voice_guidance: null,
      user_name: null,
      address_as: null,
      user_profile: null,
      pinned_preferences: [],
    };

    // Clients predating the toggle omit the key; it reads back as learning off.
    const omitted = await router.request('/profile', jsonInit('PUT', { profile: profileFields }));
    const omittedBody = GetPersonalizationProfileResponseSchema.parse(await omitted.json());
    expect(omittedBody.data?.learning_enabled).toBe(false);

    const enabled = await router.request(
      '/profile',
      jsonInit('PUT', { profile: { ...profileFields, learning_enabled: true } }),
    );
    const enabledBody = GetPersonalizationProfileResponseSchema.parse(await enabled.json());
    expect(enabledBody.data?.learning_enabled).toBe(true);
    // The switch is not model-facing, so the digest cannot move; the write must land anyway.
    expect(enabledBody.data?.digest).toBe(omittedBody.data?.digest);
    expect(enabledBody.data?.revision).toBe(2);

    const nonBoolean = await router.request(
      '/profile',
      jsonInit('PUT', { profile: { ...profileFields, learning_enabled: 'yes' } }),
    );
    expect(nonBoolean.status).toBe(400);
  });

  it('lets a profile that holds only the learning switch be turned on and back off', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const router = createPersonalizationRouter({
      personalizationStore: new SqlitePersonalizationStore(db),
      resolveRequestContext: () => userA,
    });
    const emptyContent = {
      assistant_name: null,
      assistant_identity: null,
      voice_guidance: null,
      user_name: null,
      address_as: null,
      user_profile: null,
      pinned_preferences: [],
    };

    // Someone with no personalization content tries the feature.
    const enabled = await router.request(
      '/profile',
      jsonInit('PUT', { profile: { ...emptyContent, learning_enabled: true } }),
    );
    expect(enabled.status).toBe(200);
    const enabledBody = GetPersonalizationProfileResponseSchema.parse(await enabled.json());
    expect(enabledBody.data?.learning_enabled).toBe(true);
    expect(enabledBody.data?.revision).toBe(1);

    // A day later they change their mind. Turning a switch back off is not an error, and it
    // leaves the row in place rather than demanding a DELETE.
    const disabled = await router.request(
      '/profile',
      jsonInit('PUT', { profile: { ...emptyContent, learning_enabled: false } }),
    );
    expect(disabled.status).toBe(200);
    const disabledBody = GetPersonalizationProfileResponseSchema.parse(await disabled.json());
    expect(disabledBody.data?.learning_enabled).toBe(false);
    expect(disabledBody.data?.revision).toBe(2);

    // The next read reflects it, and the row survived.
    const read = GetPersonalizationProfileResponseSchema.parse(await (await router.request('/profile')).json());
    expect(read.data?.learning_enabled).toBe(false);
    expect(read.data?.revision).toBe(2);

    // A request carrying no content at all is still what DELETE is for.
    const nothing = await router.request('/profile', jsonInit('PUT', { profile: emptyContent }));
    expect(nothing.status).toBe(400);
  });
});
