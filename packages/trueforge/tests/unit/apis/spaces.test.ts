import { OpenAPIHono } from '@hono/zod-openapi';
import { createLogger } from 'winston';
import { createSpacesRouter } from '../../../src/apis/spaces';
import { createAppErrorHandler } from '../../../src/app';
import type { RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSpaceStore } from '../../../src/db/sqlite/space-store/SqliteSpaceStore';

function requestContext(userRef: string): RequestContext {
  return {
    tenant_id: 'default',
    subject: { id: userRef, type: 'user', display_name: userRef },
    roles: [],
    user_credential: null,
  };
}

const userA: RequestContext = requestContext('user-a');
const userB: RequestContext = requestContext('user-b');

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function spaceBody(overrides: Record<string, unknown> = {}) {
  return {
    space: {
      name: 'Spain houses',
      purpose: 'Track candidate houses in Spain.',
      status: 'active',
      body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 250000 |',
      ...overrides,
    },
    expected_aggregate_revision: 0,
  };
}

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const spaceStore = new SqliteSpaceStore(db);
  let user = userA;
  // Mounted behind the app's own error handler so a thrown HTTPException is
  // judged as the JSON the API actually returns, not as a bare text body.
  const app = new OpenAPIHono();
  app.route('/', createSpacesRouter({ spaceStore, resolveRequestContext: () => user }));
  app.onError(createAppErrorHandler({ logger: createLogger({ silent: true }) }));

  return {
    app,
    spaceStore,
    as: (next: RequestContext) => {
      user = next;
    },
  };
}

describe('spaces API', () => {
  it('creates, gets, lists, and updates a space', async () => {
    const { app } = await setup();

    const createRes = await app.request('/', jsonInit('POST', spaceBody()));
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      data: { space: { id: string; revision: number }; aggregate_revision: number };
    };
    expect(created.data.space.revision).toBe(1);
    expect(created.data.aggregate_revision).toBe(1);

    const getRes = await app.request(`/${created.data.space.id}`);
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as { data: { name: string; body: string } };
    expect(got.data.name).toBe('Spain houses');
    expect(got.data.body).toBe('| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 250000 |');

    const listRes = await app.request('/');
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { data: { spaces: { id: string }[] } };
    expect(listed.data.spaces.map(space => space.id)).toEqual([created.data.space.id]);

    const updateRes = await app.request(
      `/${created.data.space.id}`,
      jsonInit('PUT', {
        space: {
          name: 'Spain houses (shortlist)',
          purpose: 'Track candidate houses in Spain.',
          status: 'active',
          body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 240000 |',
        },
        expected_revision: created.data.space.revision,
        expected_aggregate_revision: created.data.aggregate_revision,
      }),
    );
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { data: { space: { name: string; body: string; revision: number } } };
    expect(updated.data.space.name).toBe('Spain houses (shortlist)');
    expect(updated.data.space.body).toBe('| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 240000 |');
    expect(updated.data.space.revision).toBe(2);
  });

  it('defaults format to markdown when omitted, and round-trips an explicit html format through update', async () => {
    const { app } = await setup();

    const createRes = await app.request('/', jsonInit('POST', spaceBody()));
    const created = (await createRes.json()) as {
      data: { space: { id: string; format: string; revision: number }; aggregate_revision: number };
    };
    expect(created.data.space.format).toBe('markdown');

    const updateRes = await app.request(
      `/${created.data.space.id}`,
      jsonInit('PUT', {
        space: {
          name: 'Spain houses (shortlist)',
          purpose: 'Track candidate houses in Spain.',
          status: 'active',
          body: '<style>.card{color:red}</style><h1>Spain houses</h1>',
          format: 'html',
        },
        expected_revision: created.data.space.revision,
        expected_aggregate_revision: created.data.aggregate_revision,
      }),
    );
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { data: { space: { format: string } } };
    expect(updated.data.space.format).toBe('html');

    const getRes = await app.request(`/${created.data.space.id}`);
    const got = (await getRes.json()) as { data: { format: string } };
    expect(got.data.format).toBe('html');
  });

  it('returns 404 for a space owned by another user', async () => {
    const { app, as } = await setup();
    const createRes = await app.request('/', jsonInit('POST', spaceBody()));
    const created = (await createRes.json()) as { data: { space: { id: string } } };

    as(userB);
    const getRes = await app.request(`/${created.data.space.id}`);
    expect(getRes.status).toBe(404);
  });

  it('returns 409 on a stale expected_aggregate_revision', async () => {
    const { app } = await setup();
    await app.request('/', jsonInit('POST', spaceBody()));

    const staleRes = await app.request('/', jsonInit('POST', spaceBody({ name: 'Other space' })));
    expect(staleRes.status).toBe(409);
  });

  it('returns 409 on a stale expected_revision, and 404 on an update to a missing space', async () => {
    const { app } = await setup();
    const createRes = await app.request('/', jsonInit('POST', spaceBody()));
    const created = (await createRes.json()) as {
      data: { space: { id: string; revision: number }; aggregate_revision: number };
    };

    const staleRes = await app.request(
      `/${created.data.space.id}`,
      jsonInit('PUT', {
        space: spaceBody().space,
        expected_revision: created.data.space.revision + 1,
        expected_aggregate_revision: created.data.aggregate_revision,
      }),
    );
    expect(staleRes.status).toBe(409);

    const missingRes = await app.request(
      '/does-not-exist',
      jsonInit('PUT', {
        space: spaceBody().space,
        expected_revision: 1,
        expected_aggregate_revision: created.data.aggregate_revision,
      }),
    );
    expect(missingRes.status).toBe(404);
  });

  it('deletes a space, then 404s on a get and a repeat delete of it', async () => {
    const { app } = await setup();
    const createRes = await app.request('/', jsonInit('POST', spaceBody()));
    const created = (await createRes.json()) as { data: { space: { id: string; revision: number } } };

    const deleteRes = await app.request(
      `/${created.data.space.id}?expected_revision=${String(created.data.space.revision)}`,
      { method: 'DELETE' },
    );
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({});

    const getRes = await app.request(`/${created.data.space.id}`);
    expect(getRes.status).toBe(404);

    const repeatRes = await app.request(
      `/${created.data.space.id}?expected_revision=${String(created.data.space.revision)}`,
      { method: 'DELETE' },
    );
    expect(repeatRes.status).toBe(404);
  });

  it('returns 409 on a delete with a stale expected_revision, without deleting the space', async () => {
    const { app } = await setup();
    const createRes = await app.request('/', jsonInit('POST', spaceBody()));
    const created = (await createRes.json()) as { data: { space: { id: string; revision: number } } };

    const staleRes = await app.request(
      `/${created.data.space.id}?expected_revision=${String(created.data.space.revision + 1)}`,
      { method: 'DELETE' },
    );
    expect(staleRes.status).toBe(409);

    const getRes = await app.request(`/${created.data.space.id}`);
    expect(getRes.status).toBe(200);
  });

  it('reads a historical revision with ?revision=, and 404s outside the retained window', async () => {
    const { app } = await setup();
    const createRes = await app.request('/', jsonInit('POST', spaceBody()));
    const created = (await createRes.json()) as {
      data: { space: { id: string; revision: number; body: string }; aggregate_revision: number };
    };
    const originalBody = created.data.space.body;

    const updateRes = await app.request(
      `/${created.data.space.id}`,
      jsonInit('PUT', {
        space: { ...spaceBody().space, body: 'Rewritten body.' },
        expected_revision: created.data.space.revision,
        expected_aggregate_revision: created.data.aggregate_revision,
      }),
    );
    expect(updateRes.status).toBe(200);

    const revRes = await app.request(`/${created.data.space.id}?revision=1`);
    expect(revRes.status).toBe(200);
    const rev = (await revRes.json()) as { data: { revision: number; body: string } };
    expect(rev.data.revision).toBe(1);
    expect(rev.data.body).toBe(originalBody);

    const currentRes = await app.request(`/${created.data.space.id}?revision=2`);
    expect(currentRes.status).toBe(200);
    expect(((await currentRes.json()) as { data: { body: string } }).data.body).toBe('Rewritten body.');

    const missingRes = await app.request(`/${created.data.space.id}?revision=99`);
    expect(missingRes.status).toBe(404);
  });

  it('reverts a space to a historical revision as a new revision', async () => {
    const { app } = await setup();
    const createRes = await app.request('/', jsonInit('POST', spaceBody()));
    const created = (await createRes.json()) as {
      data: { space: { id: string; revision: number; body: string }; aggregate_revision: number };
    };
    const originalBody = created.data.space.body;

    const updateRes = await app.request(
      `/${created.data.space.id}`,
      jsonInit('PUT', {
        space: { ...spaceBody().space, body: 'a' },
        expected_revision: created.data.space.revision,
        expected_aggregate_revision: created.data.aggregate_revision,
      }),
    );
    const updated = (await updateRes.json()) as {
      data: { space: { revision: number }; aggregate_revision: number };
    };
    expect(updateRes.status).toBe(200);

    const revertRes = await app.request(
      `/${created.data.space.id}/revert`,
      jsonInit('POST', {
        revision: 1,
        expected_revision: updated.data.space.revision,
        expected_aggregate_revision: updated.data.aggregate_revision,
      }),
    );
    expect(revertRes.status).toBe(200);
    const reverted = (await revertRes.json()) as {
      data: { space: { revision: number; body: string }; aggregate_revision: number };
    };
    expect(reverted.data.space.revision).toBe(updated.data.space.revision + 1);
    expect(reverted.data.space.body).toBe(originalBody);
    expect(reverted.data.aggregate_revision).toBe(updated.data.aggregate_revision + 1);
  });

  it('returns 404 reverting an unknown revision and 409 reverting with a stale expected_revision', async () => {
    const { app } = await setup();
    const createRes = await app.request('/', jsonInit('POST', spaceBody()));
    const created = (await createRes.json()) as {
      data: { space: { id: string; revision: number }; aggregate_revision: number };
    };

    const missingRes = await app.request(
      `/${created.data.space.id}/revert`,
      jsonInit('POST', {
        revision: 99,
        expected_revision: created.data.space.revision,
        expected_aggregate_revision: created.data.aggregate_revision,
      }),
    );
    expect(missingRes.status).toBe(404);

    const staleRes = await app.request(
      `/${created.data.space.id}/revert`,
      jsonInit('POST', {
        revision: 1,
        expected_revision: created.data.space.revision + 1,
        expected_aggregate_revision: created.data.aggregate_revision,
      }),
    );
    expect(staleRes.status).toBe(409);
  });
});
