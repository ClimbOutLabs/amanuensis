import { PersonalizationRevisionConflictError, type IPersonalizationStore } from '../../src/db/personalizationStore';
import { personalizationDigest, type PersonalizationProfileContent } from '../../src/personalization/profile';

const CONTENT: PersonalizationProfileContent = {
  assistant_name: 'Aman',
  assistant_identity: 'A local personal assistant.',
  voice_guidance: 'Be direct and kind.',
  user_name: null,
  address_as: null,
  user_profile: 'Prefers concise answers.',
  pinned_preferences: ['Use plain English.', 'Avoid em dashes.'],
  help_areas: ['family', 'focus'],
  learned_profile: null,
  learning_enabled: false,
};

export function runPersonalizationStoreContractSuite(getStore: () => IPersonalizationStore): void {
  it('stores a profile per user, preserves provenance, and leaves a matching write at the same revision', async () => {
    const store = getStore();
    const created = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
    });

    expect(created.revision).toBe(1);
    expect(created.digest).toBe(personalizationDigest(CONTENT));
    expect(created.created_by).toBe('user-a');
    expect(created.updated_by).toBe('user-a');
    expect(created.created_at).toMatch(/Z$/);
    expect(created.pinned_preferences).toEqual(CONTENT.pinned_preferences);
    expect(created.user_name).toBeNull();
    expect(created.address_as).toBeNull();
    expect(Array.isArray(created.pinned_preferences)).toBe(true);
    expect((await store.getProfile({ tenant_id: 'default', created_by: 'user-a' }))?.pinned_preferences).toEqual(
      CONTENT.pinned_preferences,
    );
    expect(await store.getProfile({ tenant_id: 'default', created_by: 'user-b' })).toBeUndefined();

    const repeated = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
    });
    expect(repeated).toEqual(created);
  });

  it('advances revision only when model-facing content changes and delete is user scoped', async () => {
    const store = getStore();
    await store.upsertProfile({ tenant_id: 'default', created_by: 'user-a', updated_by: 'user-a', ...CONTENT });
    await store.upsertProfile({ tenant_id: 'default', created_by: 'user-b', updated_by: 'user-b', ...CONTENT });

    const updated = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
      voice_guidance: 'Be concise and warm.',
      user_name: null,
      address_as: null,
    });
    expect(updated.revision).toBe(2);
    expect(updated.digest).not.toBe(personalizationDigest(CONTENT));

    await store.deleteProfile({ tenant_id: 'default', created_by: 'user-a' });
    expect(await store.getProfile({ tenant_id: 'default', created_by: 'user-a' })).toBeUndefined();
    expect(await store.getProfile({ tenant_id: 'default', created_by: 'user-b' })).toBeDefined();
  });

  it('round-trips the learned profile document and folds it into revision and digest', async () => {
    const store = getStore();
    const created = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
    });
    expect(created.learned_profile).toBeNull();

    const learned = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'aman-learning',
      ...CONTENT,
      learned_profile: '# Learned\n\n- Prefers plain English.',
    });
    expect(learned.revision).toBe(created.revision + 1);
    expect(learned.updated_by).toBe('aman-learning');
    expect(learned.digest).not.toBe(created.digest);

    const read = await store.getProfile({ tenant_id: 'default', created_by: 'user-a' });
    expect(read?.learned_profile).toBe('# Learned\n\n- Prefers plain English.');

    // Same learned document again is a digest match: no new revision.
    const repeated = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'aman-learning',
      ...CONTENT,
      learned_profile: '# Learned\n\n- Prefers plain English.',
    });
    expect(repeated).toEqual(learned);
  });

  it('keeps help areas in the order chosen, and a reorder is a change even though the digest holds still', async () => {
    const store = getStore();
    const created = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
    });
    expect(created.help_areas).toEqual(['family', 'focus']);

    const reordered = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
      help_areas: ['focus', 'family'],
    });
    expect(reordered.revision).toBe(2);
    expect(reordered.digest).toBe(created.digest);
    expect(reordered.help_areas).toEqual(['focus', 'family']);
    expect((await store.getProfile({ tenant_id: 'default', created_by: 'user-a' }))?.help_areas).toEqual([
      'focus',
      'family',
    ]);
  });

  it('persists a learning toggle that leaves the model-facing digest identical', async () => {
    const store = getStore();
    const created = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
    });
    expect(created.learning_enabled).toBe(false);

    // The switch is not model-facing, so the digest cannot move. The write must still land:
    // treating a matching digest alone as a no-op would silently discard the toggle.
    const enabled = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
      learning_enabled: true,
    });
    expect(enabled.digest).toBe(created.digest);
    expect(enabled.revision).toBe(created.revision + 1);
    expect(enabled.learning_enabled).toBe(true);
    expect((await store.getProfile({ tenant_id: 'default', created_by: 'user-a' }))?.learning_enabled).toBe(true);

    // Rewriting the same flag is still a no-op.
    const repeated = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
      learning_enabled: true,
    });
    expect(repeated).toEqual(enabled);

    const disabled = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
      learning_enabled: false,
    });
    expect(disabled.revision).toBe(enabled.revision + 1);
    expect(disabled.learning_enabled).toBe(false);
  });

  it('applies a fenced update only while the row is still at the expected revision', async () => {
    const store = getStore();
    const created = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
    });

    const fenced = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'aman-learning',
      expected_revision: created.revision,
      ...CONTENT,
      learned_profile: '# Learned',
    });
    expect(fenced.revision).toBe(created.revision + 1);
    expect(fenced.learned_profile).toBe('# Learned');
  });

  it('refuses a fenced update at a stale revision and writes nothing', async () => {
    const store = getStore();
    const created = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
    });
    // The user edits between the learning pass reading `created` and writing back.
    const edited = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
      voice_guidance: 'Be blunt.',
      user_name: null,
      address_as: null,
    });

    await expect(
      store.upsertProfile({
        tenant_id: 'default',
        created_by: 'user-a',
        updated_by: 'aman-learning',
        expected_revision: created.revision,
        ...CONTENT,
        learned_profile: '# Learned',
      }),
    ).rejects.toThrow(PersonalizationRevisionConflictError);

    expect(await store.getProfile({ tenant_id: 'default', created_by: 'user-a' })).toEqual(edited);
  });

  it('fences a create on the absence of a row', async () => {
    const store = getStore();
    const created = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'aman-learning',
      expected_revision: null,
      ...CONTENT,
      learned_profile: '# Learned',
    });
    expect(created.revision).toBe(1);

    // The row now exists, so the same fence must refuse rather than replace it.
    await expect(
      store.upsertProfile({
        tenant_id: 'default',
        created_by: 'user-a',
        updated_by: 'aman-learning',
        expected_revision: null,
        ...CONTENT,
        learned_profile: '# Learned again',
      }),
    ).rejects.toThrow(PersonalizationRevisionConflictError);

    expect(await store.getProfile({ tenant_id: 'default', created_by: 'user-a' })).toEqual(created);
  });

  it('refuses a fenced update against a row that no longer exists', async () => {
    const store = getStore();
    const created = await store.upsertProfile({
      tenant_id: 'default',
      created_by: 'user-a',
      updated_by: 'user-a',
      ...CONTENT,
    });
    await store.deleteProfile({ tenant_id: 'default', created_by: 'user-a' });

    await expect(
      store.upsertProfile({
        tenant_id: 'default',
        created_by: 'user-a',
        updated_by: 'aman-learning',
        expected_revision: created.revision,
        ...CONTENT,
        learned_profile: '# Learned',
      }),
    ).rejects.toThrow(PersonalizationRevisionConflictError);

    expect(await store.getProfile({ tenant_id: 'default', created_by: 'user-a' })).toBeUndefined();
  });
}
