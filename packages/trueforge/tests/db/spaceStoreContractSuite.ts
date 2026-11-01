import {
  SpaceAggregateRevisionConflictError,
  SpaceFolderNotFoundError,
  SpaceNotFoundError,
  SpaceRevisionConflictError,
  SpaceRevisionNotFoundError,
  type ISpaceStore,
} from '../../src/db/spaceStore';

const OWNER = { tenant_id: 'default', created_by: 'user-a' };

const SPAIN_HOUSES = {
  ...OWNER,
  id: 's-spain-houses',
  name: 'Spain houses',
  purpose: 'Track candidate houses in Spain: price, location, and viewing status.',
  status: 'active' as const,
  body: '| Address | Price | Status |\n| --- | --- | --- |\n| Calle Mayor 1 | 250000 | Viewed |',
  format: 'markdown' as const,
};

export function runSpaceStoreContractSuite(getStore: () => ISpaceStore): void {
  it('creates a space at revision 1, scoped to its owner', async () => {
    const store = getStore();
    const { record, aggregate_revision } = await store.createSpace({ ...SPAIN_HOUSES, expected_aggregate_revision: 0 });

    expect(record.name).toBe('Spain houses');
    expect(record.status).toBe('active');
    expect(record.body).toBe(SPAIN_HOUSES.body);
    expect(record.revision).toBe(1);
    expect(record.created_at).toMatch(/Z$/);
    expect(aggregate_revision).toBe(1);

    expect(await store.getSpace({ ...OWNER, space_id: record.id })).toEqual(record);
    expect(await store.getSpace({ tenant_id: 'default', created_by: 'user-b', space_id: record.id })).toBeUndefined();
    expect(
      await store.listSpaces({ tenant_id: 'default', created_by: 'user-b', status: undefined, limit: 10 }),
    ).toEqual([]);
  });

  it('rejects a create whose expected_aggregate_revision is stale, naming the current revision', async () => {
    const store = getStore();
    await store.createSpace({ ...SPAIN_HOUSES, expected_aggregate_revision: 0 });

    const error: unknown = await store
      .createSpace({ ...SPAIN_HOUSES, id: 's-other', name: 'Other', expected_aggregate_revision: 0 })
      .catch((e: unknown) => e);

    if (!(error instanceof SpaceAggregateRevisionConflictError)) {
      throw new Error('expected SpaceAggregateRevisionConflictError');
    }
    expect(error.expected_revision).toBe(0);
    expect(error.actual_revision).toBe(1);
  });

  it('updates a space, advancing both the entity and aggregate revision', async () => {
    const store = getStore();
    const { record: created, aggregate_revision: firstAggregate } = await store.createSpace({
      ...SPAIN_HOUSES,
      expected_aggregate_revision: 0,
    });

    const { record: updated, aggregate_revision: secondAggregate } = await store.updateSpace({
      ...OWNER,
      space_id: created.id,
      name: 'Spain houses (shortlist)',
      purpose: created.purpose,
      status: 'active',
      body: '| Address | Price | Status |\n| --- | --- | --- |\n| Calle Mayor 1 | 240000 | Offer made |',
      format: 'markdown',
      expected_revision: created.revision,
      expected_aggregate_revision: firstAggregate,
    });

    expect(updated.name).toBe('Spain houses (shortlist)');
    expect(updated.body).toBe(
      '| Address | Price | Status |\n| --- | --- | --- |\n| Calle Mayor 1 | 240000 | Offer made |',
    );
    expect(updated.revision).toBe(created.revision + 1);
    expect(secondAggregate).toBe(firstAggregate + 1);
  });

  it('persists format "html" on create, and round-trips a format change through update', async () => {
    const store = getStore();
    const { record: created } = await store.createSpace({
      ...SPAIN_HOUSES,
      id: 's-html-tracker',
      format: 'html',
      body: '<style>.card{color:red}</style><h1>Tracker</h1>',
      expected_aggregate_revision: (await store.getAggregate(OWNER)).revision,
    });
    expect(created.format).toBe('html');
    expect(await store.getSpace({ ...OWNER, space_id: created.id })).toMatchObject({ format: 'html' });

    const { record: updated } = await store.updateSpace({
      ...OWNER,
      space_id: created.id,
      name: created.name,
      purpose: created.purpose,
      status: created.status,
      body: 'Plain notes now.',
      format: 'markdown',
      expected_revision: created.revision,
      expected_aggregate_revision: (await store.getAggregate(OWNER)).revision,
    });
    expect(updated.format).toBe('markdown');
  });

  it('rejects an update against a missing space', async () => {
    const store = getStore();
    await expect(
      store.updateSpace({
        ...OWNER,
        space_id: 'does-not-exist',
        name: 'Anything',
        purpose: 'Anything',
        status: 'active',
        body: '',
        format: 'markdown',
        expected_revision: 1,
        expected_aggregate_revision: 0,
      }),
    ).rejects.toBeInstanceOf(SpaceNotFoundError);
  });

  it('rejects an update whose expected_revision is stale, naming the current revision', async () => {
    const store = getStore();
    const { record: created, aggregate_revision } = await store.createSpace({
      ...SPAIN_HOUSES,
      expected_aggregate_revision: 0,
    });

    const error: unknown = await store
      .updateSpace({
        ...OWNER,
        space_id: created.id,
        name: 'Renamed',
        purpose: created.purpose,
        status: 'active',
        body: created.body,
        format: 'markdown',
        expected_revision: created.revision + 1,
        expected_aggregate_revision: aggregate_revision,
      })
      .catch((e: unknown) => e);

    if (!(error instanceof SpaceRevisionConflictError)) {
      throw new Error('expected SpaceRevisionConflictError');
    }
    expect(error.expected_revision).toBe(created.revision + 1);
    expect(error.actual_revision).toBe(created.revision);
  });

  it('lists spaces ordered by name with offset pagination and reports has_more/next_offset', async () => {
    const store = getStore();
    for (const name of ['Charlie', 'Alpha', 'Bravo']) {
      await store.createSpace({
        ...OWNER,
        id: `s-${name.toLowerCase()}`,
        name,
        purpose: 'Purpose',
        status: 'active',
        body: '',
        format: 'markdown',
        expected_aggregate_revision: (await store.getAggregate(OWNER)).revision,
      });
    }

    const firstPage = await store.listSpacesWithAggregate({ ...OWNER, status: undefined, limit: 2 });
    expect(firstPage.records.map(r => r.name)).toEqual(['Alpha', 'Bravo']);
    expect(firstPage.has_more).toBe(true);
    expect(firstPage.next_offset).toBe(2);

    const secondPage = await store.listSpacesWithAggregate({
      ...OWNER,
      status: undefined,
      limit: 2,
      offset: firstPage.next_offset ?? undefined,
    });
    expect(secondPage.records.map(r => r.name)).toEqual(['Charlie']);
    expect(secondPage.has_more).toBe(false);
    expect(secondPage.next_offset).toBeNull();
  });

  it('deletes a space, advancing the aggregate revision and leaving no trace of the row', async () => {
    const store = getStore();
    const { record: created, aggregate_revision: firstAggregate } = await store.createSpace({
      ...SPAIN_HOUSES,
      expected_aggregate_revision: 0,
    });

    const { aggregate_revision: secondAggregate } = await store.deleteSpace({
      ...OWNER,
      space_id: created.id,
      expected_revision: created.revision,
    });

    expect(secondAggregate).toBe(firstAggregate + 1);
    expect(await store.getSpace({ ...OWNER, space_id: created.id })).toBeUndefined();
    expect(await store.listSpaces({ ...OWNER, status: undefined, limit: 10 })).toEqual([]);
  });

  it('rejects a delete against a missing space', async () => {
    const store = getStore();
    await expect(
      store.deleteSpace({ ...OWNER, space_id: 'does-not-exist', expected_revision: 1 }),
    ).rejects.toBeInstanceOf(SpaceNotFoundError);
  });

  it('rejects a delete whose expected_revision is stale, naming the current revision', async () => {
    const store = getStore();
    const { record: created } = await store.createSpace({ ...SPAIN_HOUSES, expected_aggregate_revision: 0 });

    const error: unknown = await store
      .deleteSpace({ ...OWNER, space_id: created.id, expected_revision: created.revision + 1 })
      .catch((e: unknown) => e);

    if (!(error instanceof SpaceRevisionConflictError)) {
      throw new Error('expected SpaceRevisionConflictError');
    }
    expect(error.expected_revision).toBe(created.revision + 1);
    expect(error.actual_revision).toBe(created.revision);
    expect(await store.getSpace({ ...OWNER, space_id: created.id })).toBeDefined();
  });

  it('reads a historical revision, and the current revision through the same method', async () => {
    const store = getStore();
    const { record: created } = await store.createSpace({ ...SPAIN_HOUSES, expected_aggregate_revision: 0 });
    const firstBody = created.body;
    const secondBody = `${firstBody}\n| Calle Ancha 2 | 310000 | New |`;
    await store.updateSpace({
      ...OWNER,
      space_id: created.id,
      name: created.name,
      purpose: created.purpose,
      status: created.status,
      body: secondBody,
      format: created.format,
      expected_revision: created.revision,
      expected_aggregate_revision: (await store.getAggregate(OWNER)).revision,
    });

    const rev1 = await store.getSpaceRevision({ ...OWNER, space_id: created.id, revision: 1 });
    expect(rev1).toMatchObject({ id: created.id, revision: 1, body: firstBody, name: created.name });
    const rev2 = await store.getSpaceRevision({ ...OWNER, space_id: created.id, revision: 2 });
    expect(rev2).toMatchObject({ id: created.id, revision: 2, body: secondBody });

    expect(await store.getSpaceRevision({ ...OWNER, space_id: created.id, revision: 99 })).toBeUndefined();
    expect(await store.getSpaceRevision({ ...OWNER, space_id: 'does-not-exist', revision: 1 })).toBeUndefined();
    expect(
      await store.getSpaceRevision({ tenant_id: 'default', created_by: 'user-b', space_id: created.id, revision: 1 }),
    ).toBeUndefined();
  });

  it('reverts a historical revision as a new current revision, keeping the bad write recoverable', async () => {
    const store = getStore();
    const { record: created, aggregate_revision: firstAggregate } = await store.createSpace({
      ...SPAIN_HOUSES,
      expected_aggregate_revision: 0,
    });
    const goodBody = created.body;
    const { record: bad } = await store.updateSpace({
      ...OWNER,
      space_id: created.id,
      name: created.name,
      purpose: created.purpose,
      status: created.status,
      body: 'a',
      format: created.format,
      expected_revision: created.revision,
      expected_aggregate_revision: firstAggregate,
    });
    expect(bad.revision).toBe(2);

    const { record: reverted, aggregate_revision: revertAggregate } = await store.revertSpace({
      ...OWNER,
      space_id: created.id,
      revision: 1,
      expected_revision: bad.revision,
      expected_aggregate_revision: (await store.getAggregate(OWNER)).revision,
    });

    expect(reverted.revision).toBe(3);
    expect(reverted.body).toBe(goodBody);
    expect(revertAggregate).toBeGreaterThan(firstAggregate);
    expect(await store.getSpace({ ...OWNER, space_id: created.id })).toMatchObject({
      revision: 3,
      body: goodBody,
    });
    // The reverted-away content is itself snapshotted, so the revert is revertible.
    expect(await store.getSpaceRevision({ ...OWNER, space_id: created.id, revision: 2 })).toMatchObject({
      body: 'a',
    });
  });

  it('rejects a revert whose expected_revision is stale, naming the current revision', async () => {
    const store = getStore();
    const { record: created } = await store.createSpace({ ...SPAIN_HOUSES, expected_aggregate_revision: 0 });
    await store.updateSpace({
      ...OWNER,
      space_id: created.id,
      name: created.name,
      purpose: created.purpose,
      status: created.status,
      body: 'changed',
      format: created.format,
      expected_revision: created.revision,
      expected_aggregate_revision: (await store.getAggregate(OWNER)).revision,
    });

    const error: unknown = await store
      .revertSpace({
        ...OWNER,
        space_id: created.id,
        revision: 1,
        expected_revision: created.revision,
        expected_aggregate_revision: (await store.getAggregate(OWNER)).revision,
      })
      .catch((e: unknown) => e);

    if (!(error instanceof SpaceRevisionConflictError)) {
      throw new Error('expected SpaceRevisionConflictError');
    }
    expect(error.expected_revision).toBe(created.revision);
    expect(error.actual_revision).toBe(created.revision + 1);
  });

  it('rejects a revert of an unknown space, or a revision outside the retained window', async () => {
    const store = getStore();
    await expect(
      store.revertSpace({
        ...OWNER,
        space_id: 'does-not-exist',
        revision: 1,
        expected_revision: 1,
        expected_aggregate_revision: 0,
      }),
    ).rejects.toBeInstanceOf(SpaceNotFoundError);

    const { record: created } = await store.createSpace({ ...SPAIN_HOUSES, expected_aggregate_revision: 0 });
    await expect(
      store.revertSpace({
        ...OWNER,
        space_id: created.id,
        revision: 99,
        expected_revision: created.revision,
        expected_aggregate_revision: (await store.getAggregate(OWNER)).revision,
      }),
    ).rejects.toBeInstanceOf(SpaceRevisionNotFoundError);
  });

  it('retains only the most recent revisions, pruning older snapshots', async () => {
    const store = getStore();
    const { record: created } = await store.createSpace({ ...SPAIN_HOUSES, expected_aggregate_revision: 0 });
    let revision = created.revision;
    let aggregate_revision = (await store.getAggregate(OWNER)).revision;
    // 21 updates: revisions 1..22 exist, snapshots may only cover the newest 20 (revisions 2..21).
    for (let i = 0; i < 21; i += 1) {
      const result = await store.updateSpace({
        ...OWNER,
        space_id: created.id,
        name: created.name,
        purpose: created.purpose,
        status: created.status,
        body: `body at revision ${String(revision + 1)}`,
        format: created.format,
        expected_revision: revision,
        expected_aggregate_revision: aggregate_revision,
      });
      revision = result.record.revision;
      aggregate_revision = result.aggregate_revision;
    }
    expect(revision).toBe(22);

    expect(await store.getSpaceRevision({ ...OWNER, space_id: created.id, revision: 1 })).toBeUndefined();
    const oldest = await store.getSpaceRevision({ ...OWNER, space_id: created.id, revision: 2 });
    expect(oldest).toMatchObject({ revision: 2, body: 'body at revision 2' });
    const newest = await store.getSpaceRevision({ ...OWNER, space_id: created.id, revision: 21 });
    expect(newest).toMatchObject({ revision: 21, body: 'body at revision 21' });
    // The current revision always reads back through the same method.
    expect(await store.getSpaceRevision({ ...OWNER, space_id: created.id, revision: 22 })).toMatchObject({
      revision: 22,
      body: 'body at revision 22',
    });
  });

  it('deleting a space removes its retained history', async () => {
    const store = getStore();
    const { record: created } = await store.createSpace({ ...SPAIN_HOUSES, expected_aggregate_revision: 0 });
    const { record: updated } = await store.updateSpace({
      ...OWNER,
      space_id: created.id,
      name: created.name,
      purpose: created.purpose,
      status: created.status,
      body: 'changed',
      format: created.format,
      expected_revision: created.revision,
      expected_aggregate_revision: (await store.getAggregate(OWNER)).revision,
    });
    await store.deleteSpace({ ...OWNER, space_id: created.id, expected_revision: updated.revision });

    expect(await store.getSpaceRevision({ ...OWNER, space_id: created.id, revision: 1 })).toBeUndefined();
  });

  describe('space folders', () => {
    const OTHER_OWNER = { tenant_id: 'default', created_by: 'user-b' };

    async function createSpace(store: ISpaceStore, id = SPAIN_HOUSES.id) {
      const { record } = await store.createSpace({
        ...SPAIN_HOUSES,
        id,
        expected_aggregate_revision: (await store.getAggregate(OWNER)).revision,
      });
      return record;
    }

    it('creates, renames and lists folders sorted by name, scoped to the owner', async () => {
      const store = getStore();
      const zebra = await store.createSpaceFolder({ ...OWNER, id: 'f-zebra', name: 'Zebra' });
      await store.createSpaceFolder({ ...OWNER, id: 'f-apple', name: 'Apple' });
      await store.createSpaceFolder({ ...OTHER_OWNER, id: 'f-other', name: 'Other' });

      expect(zebra.created_at).toMatch(/Z$/);
      expect((await store.listSpaceFolders(OWNER)).map(folder => folder.name)).toEqual(['Apple', 'Zebra']);

      const renamed = await store.updateSpaceFolder({ ...OWNER, folder_id: 'f-zebra', name: 'Aardvark' });
      expect(renamed.name).toBe('Aardvark');
      expect((await store.listSpaceFolders(OWNER)).map(folder => folder.name)).toEqual(['Aardvark', 'Apple']);
      await expect(
        store.updateSpaceFolder({ ...OTHER_OWNER, folder_id: 'f-zebra', name: 'Taken' }),
      ).rejects.toBeInstanceOf(SpaceFolderNotFoundError);
    });

    it('moves a space into a folder and back out without touching its revision, timestamps or history', async () => {
      const store = getStore();
      const created = await createSpace(store);
      await store.createSpaceFolder({ ...OWNER, id: 'f-1', name: 'Homes' });
      const aggregateBefore = await store.getAggregate(OWNER);

      await store.setSpaceFolder({ ...OWNER, space_id: created.id, folder_id: 'f-1' });

      expect(await store.listSpaceFolderAssignments(OWNER)).toEqual([{ space_id: created.id, folder_id: 'f-1' }]);
      expect(await store.getSpace({ ...OWNER, space_id: created.id })).toEqual(created);
      expect(await store.getAggregate(OWNER)).toEqual(aggregateBefore);
      expect(await store.getSpaceRevision({ ...OWNER, space_id: created.id, revision: 0 })).toBeUndefined();

      await store.setSpaceFolder({ ...OWNER, space_id: created.id, folder_id: null });
      expect(await store.listSpaceFolderAssignments(OWNER)).toEqual([]);
      expect(await store.getSpace({ ...OWNER, space_id: created.id })).toEqual(created);
      expect(await store.getAggregate(OWNER)).toEqual(aggregateBefore);
    });

    it('moves a space between folders and limits assignment reads to the spaces asked for', async () => {
      const store = getStore();
      const first = await createSpace(store, 's-1');
      const second = await createSpace(store, 's-2');
      await store.createSpaceFolder({ ...OWNER, id: 'f-1', name: 'One' });
      await store.createSpaceFolder({ ...OWNER, id: 'f-2', name: 'Two' });

      await store.setSpaceFolder({ ...OWNER, space_id: first.id, folder_id: 'f-1' });
      await store.setSpaceFolder({ ...OWNER, space_id: second.id, folder_id: 'f-1' });
      await store.setSpaceFolder({ ...OWNER, space_id: first.id, folder_id: 'f-2' });

      expect(await store.listSpaceFolderAssignments(OWNER)).toEqual([
        { space_id: 's-1', folder_id: 'f-2' },
        { space_id: 's-2', folder_id: 'f-1' },
      ]);
      expect(await store.listSpaceFolderAssignments({ ...OWNER, space_ids: ['s-2'] })).toEqual([
        { space_id: 's-2', folder_id: 'f-1' },
      ]);
      expect(await store.listSpaceFolderAssignments({ ...OWNER, space_ids: [] })).toEqual([]);
    });

    it('rejects a move to a missing or another owner folder, and a move of a missing or another owner space', async () => {
      const store = getStore();
      const created = await createSpace(store);
      await store.createSpaceFolder({ ...OTHER_OWNER, id: 'f-other', name: 'Other' });
      await store.createSpaceFolder({ ...OWNER, id: 'f-1', name: 'Homes' });

      await expect(
        store.setSpaceFolder({ ...OWNER, space_id: created.id, folder_id: 'f-missing' }),
      ).rejects.toBeInstanceOf(SpaceFolderNotFoundError);
      await expect(
        store.setSpaceFolder({ ...OWNER, space_id: created.id, folder_id: 'f-other' }),
      ).rejects.toBeInstanceOf(SpaceFolderNotFoundError);
      await expect(store.setSpaceFolder({ ...OWNER, space_id: 's-missing', folder_id: 'f-1' })).rejects.toBeInstanceOf(
        SpaceNotFoundError,
      );
      await expect(
        store.setSpaceFolder({ ...OTHER_OWNER, space_id: created.id, folder_id: 'f-other' }),
      ).rejects.toBeInstanceOf(SpaceNotFoundError);
      expect(await store.listSpaceFolderAssignments(OWNER)).toEqual([]);
    });

    it('deleting a folder unfiles its spaces and keeps them', async () => {
      const store = getStore();
      const created = await createSpace(store);
      await store.createSpaceFolder({ ...OWNER, id: 'f-1', name: 'Homes' });
      await store.setSpaceFolder({ ...OWNER, space_id: created.id, folder_id: 'f-1' });

      await store.deleteSpaceFolder({ ...OWNER, folder_id: 'f-1' });
      await store.deleteSpaceFolder({ ...OWNER, folder_id: 'f-1' });

      expect(await store.listSpaceFolders(OWNER)).toEqual([]);
      expect(await store.listSpaceFolderAssignments(OWNER)).toEqual([]);
      expect(await store.getSpace({ ...OWNER, space_id: created.id })).toEqual(created);
    });

    it('does not let another owner delete a folder', async () => {
      const store = getStore();
      await store.createSpaceFolder({ ...OWNER, id: 'f-1', name: 'Homes' });

      await store.deleteSpaceFolder({ ...OTHER_OWNER, folder_id: 'f-1' });

      expect((await store.listSpaceFolders(OWNER)).map(folder => folder.id)).toEqual(['f-1']);
    });

    it('deleting a space removes its assignment and keeps the folder', async () => {
      const store = getStore();
      const created = await createSpace(store);
      await store.createSpaceFolder({ ...OWNER, id: 'f-1', name: 'Homes' });
      await store.setSpaceFolder({ ...OWNER, space_id: created.id, folder_id: 'f-1' });

      await store.deleteSpace({ ...OWNER, space_id: created.id, expected_revision: created.revision });

      expect(await store.listSpaceFolderAssignments(OWNER)).toEqual([]);
      expect((await store.listSpaceFolders(OWNER)).map(folder => folder.id)).toEqual(['f-1']);
    });

    it('keeps the folder through an update and a revert', async () => {
      const store = getStore();
      const created = await createSpace(store);
      await store.createSpaceFolder({ ...OWNER, id: 'f-1', name: 'Homes' });
      await store.setSpaceFolder({ ...OWNER, space_id: created.id, folder_id: 'f-1' });
      const { record: updated } = await store.updateSpace({
        ...OWNER,
        space_id: created.id,
        name: created.name,
        purpose: created.purpose,
        status: created.status,
        body: 'changed',
        format: created.format,
        expected_revision: created.revision,
        expected_aggregate_revision: (await store.getAggregate(OWNER)).revision,
      });

      await store.revertSpace({
        ...OWNER,
        space_id: created.id,
        revision: created.revision,
        expected_revision: updated.revision,
        expected_aggregate_revision: (await store.getAggregate(OWNER)).revision,
      });

      expect(await store.listSpaceFolderAssignments(OWNER)).toEqual([{ space_id: created.id, folder_id: 'f-1' }]);
    });
  });
}
