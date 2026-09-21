import { PersonaNameConflictError, type IPersonaStore } from '../../src/db/personaStore';

const OWNER = { tenant_id: 'default', created_by: 'user-a' };

const ZARA = {
  ...OWNER,
  id: 'p-zara',
  updated_by: 'user-a',
  display_name: 'Zara',
  aliases: ['Z', 'Zara Quinn'],
  instructions: 'Answer as a careful archivist.',
  model_name: 'scripted/alt-model',
};

export function runPersonaStoreContractSuite(getStore: () => IPersonaStore): void {
  it('round-trips a persona with its aliases intact and scoped to its owner', async () => {
    const store = getStore();
    const created = await store.createPersona(ZARA);

    expect(created.display_name).toBe('Zara');
    expect(Array.isArray(created.aliases)).toBe(true);
    expect(created.aliases).toEqual(['Z', 'Zara Quinn']);
    expect(created.created_at).toMatch(/Z$/);

    expect((await store.getPersona({ ...OWNER, id: 'p-zara' }))?.aliases).toEqual(['Z', 'Zara Quinn']);
    expect(await store.getPersona({ tenant_id: 'default', created_by: 'user-b', id: 'p-zara' })).toBeUndefined();
    expect(await store.listPersonas({ tenant_id: 'default', created_by: 'user-b' })).toEqual([]);
  });

  it('refuses a name another persona already answers to, on create and on edit', async () => {
    const store = getStore();
    await store.createPersona(ZARA);

    await expect(
      store.createPersona({ ...ZARA, id: 'p-other', display_name: 'Nova', aliases: ['zara quinn'] }),
    ).rejects.toBeInstanceOf(PersonaNameConflictError);

    await store.createPersona({ ...ZARA, id: 'p-milo', display_name: 'Milo', aliases: [] });
    await expect(
      store.updatePersona({ ...ZARA, id: 'p-milo', display_name: 'MILO ', aliases: ['Z'] }),
    ).rejects.toBeInstanceOf(PersonaNameConflictError);

    // The refused writes left nothing behind.
    const personas = await store.listPersonas(OWNER);
    expect(personas.map(persona => persona.display_name)).toEqual(['Milo', 'Zara']);
  });

  it('lets a persona keep its own names while being edited', async () => {
    const store = getStore();
    await store.createPersona(ZARA);
    const updated = await store.updatePersona({ ...ZARA, instructions: 'Answer briefly.' });
    expect(updated?.instructions).toBe('Answer briefly.');
    expect(updated?.aliases).toEqual(['Z', 'Zara Quinn']);
  });

  it('reports a missing persona rather than creating one on update, and deletes only its owner’s row', async () => {
    const store = getStore();
    await store.createPersona(ZARA);
    expect(await store.updatePersona({ ...ZARA, id: 'p-ghost' })).toBeUndefined();

    await store.deletePersona({ tenant_id: 'default', created_by: 'user-b', id: 'p-zara' });
    expect(await store.getPersona({ ...OWNER, id: 'p-zara' })).toBeDefined();

    await store.deletePersona({ ...OWNER, id: 'p-zara' });
    expect(await store.getPersona({ ...OWNER, id: 'p-zara' })).toBeUndefined();
  });

  it('orders the activation log by write order, not by clock, and keeps chats apart', async () => {
    const store = getStore();
    const activation = (index: number, sessionId: string) => ({
      tenant_id: 'default',
      id: `a-${sessionId}-${String(index)}`,
      session_id: sessionId,
      turn_id: `t-${String(index)}`,
      persona_id: 'p-zara',
      persona_name: 'Zara',
      model_name: 'scripted/alt-model',
      source: 'invocation' as const,
    });

    // Written back to back so every row shares a millisecond; only an explicit
    // sequence can order them.
    for (let index = 1; index <= 5; index += 1) {
      await store.recordPersonaActivation(activation(index, 's1'));
    }
    await store.recordPersonaActivation({
      ...activation(1, 's2'),
      persona_id: null,
      persona_name: null,
      model_name: null,
      source: 'default',
    });

    const active = await store.getSessionPersona({ tenant_id: 'default', session_id: 's1' });
    expect(active?.turn_id).toBe('t-5');

    const log = await store.listSessionPersonaActivations({ tenant_id: 'default', session_id: 's1', limit: 10 });
    expect(log.map(entry => entry.turn_id)).toEqual(['t-5', 't-4', 't-3', 't-2', 't-1']);

    const otherLog = await store.listSessionPersonaActivations({ tenant_id: 'default', session_id: 's2', limit: 10 });
    expect(otherLog.map(entry => entry.turn_id)).toEqual(['t-1']);
    expect((await store.getSessionPersona({ tenant_id: 'default', session_id: 's2' }))?.persona_id).toBeNull();
  });

  it('cannot attach an activation to a session in another tenant', async () => {
    const store = getStore();
    await expect(
      store.recordPersonaActivation({
        tenant_id: 'other-tenant',
        id: 'a-cross-tenant',
        session_id: 's1',
        turn_id: 't-cross-tenant',
        persona_id: null,
        persona_name: null,
        model_name: null,
        source: 'default',
      }),
    ).rejects.toThrow();
  });

  it('reads the latest manual selection independently of later turn provenance', async () => {
    const store = getStore();
    await store.recordPersonaActivation({
      tenant_id: 'default',
      id: 'a-manual',
      session_id: 's1',
      turn_id: null,
      persona_id: 'p-zara',
      persona_name: 'Zara',
      model_name: 'scripted/alt-model',
      source: 'explicit',
    });
    await store.recordPersonaActivation({
      tenant_id: 'default',
      id: 'a-turn',
      session_id: 's1',
      turn_id: 't-1',
      persona_id: null,
      persona_name: null,
      model_name: null,
      source: 'default',
    });

    expect((await store.getSessionPersona({ tenant_id: 'default', session_id: 's1' }))?.id).toBe('a-turn');
    expect((await store.getLatestManualSessionPersona({ tenant_id: 'default', session_id: 's1' }))?.id).toBe(
      'a-manual',
    );
  });

  it('finds a legacy parent activation by turn and only a later manual override', async () => {
    const store = getStore();
    await store.recordPersonaActivation({
      tenant_id: 'default',
      id: 'a-ash-parent',
      session_id: 's1',
      turn_id: 't-ash',
      persona_id: 'p-ash',
      persona_name: 'Ash',
      model_name: 'scripted/alt-model',
      source: 'invocation',
    });
    await store.recordPersonaActivation({
      tenant_id: 'default',
      id: 'a-briar-other-fork',
      session_id: 's1',
      turn_id: 't-briar',
      persona_id: 'p-briar',
      persona_name: 'Briar',
      model_name: 'scripted/model',
      source: 'invocation',
    });

    expect(
      (await store.getTurnPersonaActivation({ tenant_id: 'default', session_id: 's1', turn_id: 't-ash' }))?.id,
    ).toBe('a-ash-parent');
    expect(
      await store.getLatestManualSessionPersonaAfterTurn({
        tenant_id: 'default',
        session_id: 's1',
        turn_id: 't-ash',
      }),
    ).toBeUndefined();

    await store.recordPersonaActivation({
      tenant_id: 'default',
      id: 'a-manual-later',
      session_id: 's1',
      turn_id: null,
      persona_id: 'p-nia',
      persona_name: 'Nia',
      model_name: 'scripted/alt-model',
      source: 'explicit',
    });
    expect(
      (
        await store.getLatestManualSessionPersonaAfterTurn({
          tenant_id: 'default',
          session_id: 's1',
          turn_id: 't-ash',
        })
      )?.id,
    ).toBe('a-manual-later');
    await expect(
      store.isManualSessionPersonaCurrent({
        tenant_id: 'default',
        session_id: 's1',
        expected_activation_id: 'a-manual-later',
      }),
    ).resolves.toBe(true);
    await expect(
      store.isManualSessionPersonaCurrent({
        tenant_id: 'default',
        session_id: 's1',
        expected_activation_id: 'a-ash-parent',
      }),
    ).resolves.toBe(false);
  });

  it('records turn provenance only when the observed manual selection is still current', async () => {
    const store = getStore();
    await store.recordPersonaActivation({
      tenant_id: 'default',
      id: 'a-manual-current',
      session_id: 's1',
      turn_id: null,
      persona_id: 'p-zara',
      persona_name: 'Zara',
      model_name: 'scripted/alt-model',
      source: 'explicit',
    });

    await expect(
      store.recordPersonaActivationIfManualCurrent({
        tenant_id: 'default',
        id: 'a-stale-turn',
        session_id: 's1',
        turn_id: 't-stale',
        persona_id: 'p-briar',
        persona_name: 'Briar',
        model_name: 'scripted/model',
        source: 'invocation',
        expected_activation_id: null,
      }),
    ).resolves.toBeUndefined();

    expect(
      await store.getTurnPersonaActivation({ tenant_id: 'default', session_id: 's1', turn_id: 't-stale' }),
    ).toBeUndefined();
    expect((await store.getSessionPersona({ tenant_id: 'default', session_id: 's1' }))?.id).toBe('a-manual-current');
  });

  it('keeps the record of a turn a deleted persona answered', async () => {
    const store = getStore();
    await store.createPersona(ZARA);
    await store.recordPersonaActivation({
      tenant_id: 'default',
      id: 'a-1',
      session_id: 's1',
      turn_id: 't-1',
      persona_id: 'p-zara',
      persona_name: 'Zara',
      model_name: 'scripted/alt-model',
      source: 'invocation',
    });

    await store.deletePersona({ ...OWNER, id: 'p-zara' });

    const [recorded] = await store.listSessionPersonaActivations({ tenant_id: 'default', session_id: 's1', limit: 10 });
    expect(recorded).toMatchObject({ turn_id: 't-1', persona_name: 'Zara', model_name: 'scripted/alt-model' });
  });
}
