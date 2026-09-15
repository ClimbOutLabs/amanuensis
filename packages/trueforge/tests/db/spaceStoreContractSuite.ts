import {
  SpaceAggregateRevisionConflictError,
  SpaceNotFoundError,
  SpaceRevisionConflictError,
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
}
