import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLogger } from 'winston';

import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqlitePersonaStore } from '../../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { amanGuidePersonaId } from '../../../../src/personas/amanGuide/identity';
import { ensureAmanGuide } from '../../../../src/personas/amanGuide/install';
import { createGuideSeeder, seedExistingGuides } from '../../../../src/personas/amanGuide/seed';

const TENANT = 'default';
const MODEL = 'tokenfactory/guide-model';

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const personaStore = new SqlitePersonaStore(db);
  const knowledgeDir = mkdtempSync(path.join(tmpdir(), 'aman-guide-seed-'));
  const logger = createLogger({ silent: true, transports: [] });
  jest.spyOn(logger, 'warn');
  /** The install a server boot or a new account runs for one person. */
  const installFor = (userId: string) => () =>
    ensureAmanGuide({
      personaStore,
      tenantId: TENANT,
      userId,
      modelName: MODEL,
      knowledgeDir,
      enqueue: jest.fn(),
      logger,
    });
  return { personaStore, logger, installFor };
}

async function irisFor(personaStore: SqlitePersonaStore, userId: string) {
  return (await personaStore.listPersonas({ tenant_id: TENANT, created_by: userId })).filter(
    persona => persona.id === amanGuidePersonaId(userId),
  );
}

describe('createGuideSeeder', () => {
  it('gives a fresh instance its one Iris at boot', async () => {
    const { personaStore, logger, installFor } = await setup();
    const seed = createGuideSeeder({ logger });

    await seed('trueforge-default', installFor('trueforge-default'));

    const iris = await irisFor(personaStore, 'trueforge-default');
    expect(iris).toHaveLength(1);
    expect(iris[0]?.display_name).toBe('Iris');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('gives a new account her on its first request, and not a second time in the same run', async () => {
    const { personaStore, logger, installFor } = await setup();
    const seed = createGuideSeeder({ logger });
    const install = jest.fn(installFor('new-person'));

    await seed('new-person', install);
    await seed('new-person', install);

    expect(install).toHaveBeenCalledTimes(1);
    expect(await irisFor(personaStore, 'new-person')).toHaveLength(1);
  });

  it('keeps one Iris after a reboot, with the same id', async () => {
    const { personaStore, logger, installFor } = await setup();
    await createGuideSeeder({ logger })('person-a', installFor('person-a'));
    const [before] = await irisFor(personaStore, 'person-a');

    await createGuideSeeder({ logger })('person-a', installFor('person-a'));

    const after = await irisFor(personaStore, 'person-a');
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before?.id);
  });

  it('keeps one Iris when an imported copy of her is already on the instance', async () => {
    const { personaStore, logger, installFor } = await setup();
    await personaStore.createPersona({
      tenant_id: TENANT,
      created_by: 'person-b',
      id: amanGuidePersonaId('person-b'),
      updated_by: 'person-b',
      display_name: 'Iris',
      aliases: [],
      instructions: 'Imported copy.',
      model_name: MODEL,
    });

    await createGuideSeeder({ logger })('person-b', installFor('person-b'));

    expect(await irisFor(personaStore, 'person-b')).toHaveLength(1);
    expect(await personaStore.listPersonas({ tenant_id: TENANT, created_by: 'person-b' })).toHaveLength(1);
  });

  it('logs a failed install once and resolves, so boot and sign-in are not blocked', async () => {
    const { logger } = await setup();
    const seed = createGuideSeeder({ logger });
    const failing = jest.fn(() => Promise.reject(new Error('disk is full')));

    await expect(seed('person-c', failing)).resolves.toBeUndefined();
    await expect(seed('person-c', failing)).resolves.toBeUndefined();

    expect(failing).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Iris could not be set up. Aman will try again the next time the server starts.',
      { reason: 'disk is full' },
    );
  });
});

describe('seedExistingGuides', () => {
  it('refreshes every existing owner at boot, and a failing owner does not stop the others', async () => {
    const { personaStore, logger, installFor } = await setup();
    await createGuideSeeder({ logger })('owner-a', installFor('owner-a'));
    await createGuideSeeder({ logger })('owner-b', installFor('owner-b'));
    await personaStore.createPersona({
      tenant_id: TENANT,
      created_by: 'owner-c',
      id: 'own-persona',
      updated_by: 'owner-c',
      display_name: 'Ada',
      aliases: [],
      instructions: 'Their own persona.',
      model_name: MODEL,
    });
    const seeder = createGuideSeeder({ logger });
    const seeded: string[] = [];

    await seedExistingGuides({
      listOwners: () => personaStore.listPersonaOwners({ tenant_id: TENANT }),
      seed: userId => {
        seeded.push(userId);
        return seeder(
          userId,
          userId === 'owner-c' ? () => Promise.reject(new Error('model store is locked')) : installFor(userId),
        );
      },
      logger,
    });

    expect(seeded).toEqual(['owner-a', 'owner-b', 'owner-c']);
    expect(await irisFor(personaStore, 'owner-a')).toHaveLength(1);
    expect(await irisFor(personaStore, 'owner-b')).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Iris could not be set up'), {
      reason: 'model store is locked',
    });
  });

  it('logs and goes on when the owners cannot be listed, so boot is not blocked', async () => {
    const { logger } = await setup();
    const seed = jest.fn(() => Promise.resolve());

    await expect(
      seedExistingGuides({
        listOwners: () => Promise.reject(new Error('database is busy')),
        seed,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(seed).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
