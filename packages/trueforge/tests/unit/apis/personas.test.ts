import { OpenAPIHono, z } from '@hono/zod-openapi';
import { AgentSpecSchema, Sessions } from '@truefoundry/trueforge-core/agent-session';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from 'winston';
import { createPersonasRouter, createSessionPersonasRouter } from '../../../src/apis/personas';
import { TENANT_ID } from '../../../src/apis/sessions';
import { createAppErrorHandler } from '../../../src/app';
import type { RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { personaKnowledgeLocation } from '../../../src/personaKnowledge/knowledgePaths';

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

const MODEL_FQN = 'scripted/scripted-model';

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function personaBody(overrides: Record<string, unknown> = {}) {
  return {
    persona: {
      display_name: 'Zara',
      aliases: ['Z'],
      instructions: 'Answer plainly.',
      model_name: MODEL_FQN,
      ...overrides,
    },
  };
}

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const modelProviderStore = new SqliteModelProviderStore(db);
  await modelProviderStore.upsertProvider({
    tenant_id: TENANT_ID,
    name: 'scripted',
    manifest: {
      type: 'custom',
      name: 'scripted',
      base_url: 'https://llm.test.example.com/v1',
      auth: { api_key: 'sk-test' },
      models: [
        {
          model_id: 'scripted-model',
          name: 'scripted-model',
          properties: { context_length: 128000, max_output_tokens: 4096 },
        },
      ],
    },
  });
  const personaStore = new SqlitePersonaStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const knowledgeDir = await mkdtemp(path.join(tmpdir(), 'personas-knowledge-'));
  let user = userA;
  // Mounted behind the app's own error handler so a thrown HTTPException is
  // judged as the JSON the API actually returns, not as a bare text body.
  const mount = (router: OpenAPIHono): OpenAPIHono => {
    const app = new OpenAPIHono();
    app.route('/', router);
    app.onError(createAppErrorHandler({ logger: createLogger({ silent: true }) }));
    return app;
  };
  const personas = mount(
    createPersonasRouter({
      personaStore,
      resolveModelProviderStore: () => modelProviderStore,
      resolveRequestContext: () => user,
      knowledgeDir,
    }),
  );
  const sessionPersonas = mount(
    createSessionPersonasRouter({ personaStore, sessionStore, resolveRequestContext: () => user }),
  );

  const createSession = async (sessionId: string) => {
    await new Sessions({ sessionStore }).create({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      created_by_subject: {
        subject_id: userA.subject.id,
        subject_type: 'user',
        subject_display_name: userA.subject.id,
      },
      external_id: null,
      agent: { type: 'inline', spec: AgentSpecSchema.parse({ model: { name: MODEL_FQN } }) },
    });
  };

  return {
    personas,
    sessionPersonas,
    createSession,
    personaStore,
    knowledgeDir,
    as: (next: RequestContext) => {
      user = next;
    },
  };
}

describe('personas router', () => {
  it('creates, lists, edits, and deletes a persona for its owner only', async () => {
    const { personas, as } = await setup();

    const created = await personas.request('/', jsonInit('POST', personaBody()));
    expect(created.status).toBe(201);
    const { data: persona } = (await created.json()) as { data: { id: string; display_name: string } };
    expect(persona.display_name).toBe('Zara');

    const listed = (await (await personas.request('/')).json()) as { data: unknown[] };
    expect(listed.data).toHaveLength(1);

    as(userB);
    expect(((await (await personas.request('/')).json()) as { data: unknown[] }).data).toHaveLength(0);
    // Another user's id must not be reachable, even with the exact identifier.
    expect((await personas.request(`/${persona.id}`, jsonInit('PUT', personaBody()))).status).toBe(404);

    as(userA);
    const renamed = await personas.request(`/${persona.id}`, jsonInit('PUT', personaBody({ display_name: 'Nova' })));
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { data: { display_name: string } }).data.display_name).toBe('Nova');

    expect((await personas.request(`/${persona.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(((await (await personas.request('/')).json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  it('deletes a knowledge library only for the owner of its persona', async () => {
    const { personas, knowledgeDir, as } = await setup();
    const { data: persona } = z
      .object({ data: z.object({ id: z.string() }) })
      .parse(await (await personas.request('/', jsonInit('POST', personaBody()))).json());
    // Synthetic library files: the database, its SQLite sidecars, and a pending upload blob.
    const { dbPath } = personaKnowledgeLocation({ knowledgeDir, tenantId: TENANT_ID, personaId: persona.id });
    const blobDir = path.join(knowledgeDir, TENANT_ID, `${persona.id}.blobs`);
    const blob = path.join(blobDir, 'doc-1.bin');
    const libraryFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, blob];
    await mkdir(blobDir, { recursive: true });
    for (const file of libraryFiles) {
      await writeFile(file, 'synthetic library bytes');
    }

    as(userB);
    const denied = await personas.request(`/${persona.id}`, { method: 'DELETE' });
    expect(denied.status).toBe(404);
    expect(libraryFiles.map(file => existsSync(file))).toEqual([true, true, true, true]);

    as(userA);
    expect((await personas.request(`/${persona.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(libraryFiles.map(file => existsSync(file))).toEqual([false, false, false, false]);
    expect(existsSync(blobDir)).toBe(false);
    expect((await personas.request(`/${persona.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses a name or alias another persona already answers to', async () => {
    const { personas } = await setup();
    await personas.request('/', jsonInit('POST', personaBody()));

    const sameName = await personas.request('/', jsonInit('POST', personaBody({ display_name: 'zara', aliases: [] })));
    expect(sameName.status).toBe(409);

    const aliasCollidesWithName = await personas.request(
      '/',
      jsonInit('POST', personaBody({ display_name: 'Nova', aliases: ['ZARA'] })),
    );
    expect(aliasCollidesWithName.status).toBe(409);

    const aliasCollidesWithAlias = await personas.request(
      '/',
      jsonInit('POST', personaBody({ display_name: 'Nova', aliases: ['z'] })),
    );
    expect(aliasCollidesWithAlias.status).toBe(409);
    expect(((await aliasCollidesWithAlias.json()) as { error: { message: string } }).error.message).toContain('z');
  });

  it.each([
    { aliases: ['zara'], conflict: 'display name' },
    { aliases: ['Z', ' z '], conflict: 'alias' },
  ])('returns a clear client error for duplicate $conflict names within one persona', async ({ aliases }) => {
    const { personas } = await setup();
    const response = await personas.request('/', jsonInit('POST', personaBody({ aliases })));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      'after trimming and case-folding',
    );
  });

  it('lets a persona keep its own names while editing something else', async () => {
    const { personas } = await setup();
    const created = await personas.request('/', jsonInit('POST', personaBody()));
    const { data } = (await created.json()) as { data: { id: string } };

    const edited = await personas.request(
      `/${data.id}`,
      jsonInit('PUT', personaBody({ instructions: 'Answer briefly.' })),
    );
    expect(edited.status).toBe(200);
  });

  it('refuses a persona bound to a model that is not configured', async () => {
    const { personas } = await setup();
    const response = await personas.request('/', jsonInit('POST', personaBody({ model_name: 'nowhere/ghost-model' })));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('unavailable');
  });

  it('returns 404 for a missing persona before validating its model', async () => {
    const { personas } = await setup();
    const response = await personas.request(
      '/missing-persona',
      jsonInit('PUT', personaBody({ model_name: 'nowhere/ghost-model' })),
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('Persona not found');
  });

  it('rejects an empty role and an oversized alias list before anything is stored', async () => {
    const { personas } = await setup();
    expect((await personas.request('/', jsonInit('POST', personaBody({ instructions: '   ' })))).status).toBe(400);
    expect(
      (
        await personas.request(
          '/',
          jsonInit('POST', personaBody({ aliases: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'] })),
        )
      ).status,
    ).toBe(400);
    expect(((await (await personas.request('/')).json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  it('returns the exact persona text the model would receive', async () => {
    const { personas } = await setup();
    const created = await personas.request('/', jsonInit('POST', personaBody()));
    const { data } = (await created.json()) as { data: { id: string } };

    const context = await personas.request(`/${data.id}/context`);
    expect(context.status).toBe(200);
    const body = (await context.json()) as { data: { injected_context: string; model_name: string } };
    expect(body.data.injected_context).toContain('<persona-name>Zara</persona-name>');
    expect(body.data.model_name).toBe(MODEL_FQN);
  });
});

describe('session persona router', () => {
  it('starts on the default assistant and records an explicit activation', async () => {
    const { personas, sessionPersonas, createSession } = await setup();
    await createSession('s1');
    const { data: persona } = (await (await personas.request('/', jsonInit('POST', personaBody()))).json()) as {
      data: { id: string };
    };

    const initial = await sessionPersonas.request('/s1/persona');
    expect(initial.headers.get('cache-control')).toBe('private, no-store');
    expect(await initial.json()).toEqual({ data: null });

    const activated = await sessionPersonas.request('/s1/persona', jsonInit('PUT', { persona_id: persona.id }));
    expect(activated.status).toBe(200);
    const activation = (await activated.json()) as { data: Record<string, unknown> };
    expect(activation.data).toMatchObject({ persona_name: 'Zara', source: 'explicit', turn_id: null });

    const active = (await (await sessionPersonas.request('/s1/persona')).json()) as {
      data: { persona_id: string };
    };
    expect(active.data.persona_id).toBe(persona.id);
  });

  it('returns to the default assistant without erasing what came before', async () => {
    const { personas, sessionPersonas, createSession } = await setup();
    await createSession('s1');
    const { data: persona } = (await (await personas.request('/', jsonInit('POST', personaBody()))).json()) as {
      data: { id: string };
    };
    await sessionPersonas.request('/s1/persona', jsonInit('PUT', { persona_id: persona.id }));

    const cleared = await sessionPersonas.request('/s1/persona', jsonInit('PUT', { persona_id: null }));
    expect(cleared.status).toBe(200);
    expect((await cleared.json()) as unknown).toMatchObject({
      data: { persona_id: null, persona_name: null, source: 'default' },
    });

    const log = (await (await sessionPersonas.request('/s1/persona-activations')).json()) as {
      data: { source: string }[];
    };
    // Newest first: the return to default, then the activation it undid.
    expect(log.data.map(entry => entry.source)).toEqual(['default', 'explicit']);
  });

  it('keeps one chat’s persona out of another chat', async () => {
    const { personas, sessionPersonas, createSession } = await setup();
    await createSession('s1');
    await createSession('s2');
    const { data: persona } = (await (await personas.request('/', jsonInit('POST', personaBody()))).json()) as {
      data: { id: string };
    };
    await sessionPersonas.request('/s1/persona', jsonInit('PUT', { persona_id: persona.id }));

    expect(await (await sessionPersonas.request('/s2/persona')).json()).toEqual({ data: null });
  });

  it('reports the default assistant once the active persona is deleted', async () => {
    const { personas, sessionPersonas, createSession, personaStore } = await setup();
    await createSession('s1');
    const { data: persona } = (await (await personas.request('/', jsonInit('POST', personaBody()))).json()) as {
      data: { id: string };
    };
    await sessionPersonas.request('/s1/persona', jsonInit('PUT', { persona_id: persona.id }));

    expect((await personas.request(`/${persona.id}`, { method: 'DELETE' })).status).toBe(200);

    // The activation log outlives the persona, so the newest row still names
    // it. What answers the next turn is the default assistant, and this is
    // where the UI reads that from.
    expect(await (await sessionPersonas.request('/s1/persona')).json()).toEqual({ data: null });

    // Resolution is scoped to the owner: another user's persona sharing the id
    // is a different persona and must not bring the indicator back.
    await personaStore.createPersona({
      tenant_id: TENANT_ID,
      created_by: userB.subject.id,
      updated_by: userB.subject.id,
      id: persona.id,
      display_name: 'Zara',
      aliases: [],
      instructions: 'Answer plainly.',
      model_name: MODEL_FQN,
    });
    expect(await (await sessionPersonas.request('/s1/persona')).json()).toEqual({ data: null });

    // Provenance is untouched by the deletion.
    const log = (await (await sessionPersonas.request('/s1/persona-activations')).json()) as {
      data: { persona_id: string | null; persona_name: string | null }[];
    };
    expect(log.data[0]).toMatchObject({ persona_id: persona.id, persona_name: 'Zara' });
  });

  it('refuses a persona that does not exist and a chat the caller does not own', async () => {
    const { sessionPersonas, createSession, as } = await setup();
    await createSession('s1');

    expect((await sessionPersonas.request('/s1/persona', jsonInit('PUT', { persona_id: 'nope' }))).status).toBe(404);
    expect((await sessionPersonas.request('/missing/persona')).status).toBe(404);

    as(userB);
    expect((await sessionPersonas.request('/s1/persona')).status).toBe(403);
    expect((await sessionPersonas.request('/s1/persona', jsonInit('PUT', { persona_id: null }))).status).toBe(403);
    expect((await sessionPersonas.request('/s1/persona-activations')).status).toBe(403);
  });
});
