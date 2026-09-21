import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPersonaApi } from '../src/personaApi';

const persona = {
  id: 'p-zara',
  display_name: 'Zara',
  aliases: ['Z'],
  instructions: 'Answer as a careful archivist.',
  model_name: 'anthropic/haiku',
};

const draft = {
  display_name: persona.display_name,
  aliases: persona.aliases,
  instructions: persona.instructions,
  model_name: persona.model_name,
};

function recordingApi() {
  const requests: Request[] = [];
  const api = createPersonaApi(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/api/v1/personas') {
      return Response.json({ data: [persona] });
    }
    if (path.endsWith('/persona')) {
      return Response.json({
        data: {
          id: 'a-1',
          session_id: 'sess-1',
          turn_id: null,
          persona_id: persona.id,
          persona_name: persona.display_name,
          model_name: persona.model_name,
          source: 'explicit',
          created_at: '2026-08-27T00:00:00.000Z',
        },
      });
    }
    if (request.method === 'DELETE') {
      return Response.json({});
    }
    return Response.json({ data: persona });
  });
  return { api, requests };
}

test('persona API speaks the server’s snake_case wire shape on every route', async () => {
  const { api, requests } = recordingApi();

  assert.deepEqual(await api.listPersonas(), [persona]);
  assert.deepEqual(await api.createPersona(draft), persona);
  assert.deepEqual(await api.updatePersona(persona.id, draft), persona);
  await api.deletePersona(persona.id);
  await api.getSessionPersona('sess-1');
  await api.setSessionPersona('sess-1', persona.id);

  assert.deepEqual(
    requests.map(request => [request.method, new URL(request.url).pathname]),
    [
      ['GET', '/api/v1/personas'],
      ['POST', '/api/v1/personas'],
      ['PUT', '/api/v1/personas/p-zara'],
      ['DELETE', '/api/v1/personas/p-zara'],
      ['GET', '/api/v1/sessions/sess-1/persona'],
      ['PUT', '/api/v1/sessions/sess-1/persona'],
    ],
  );

  const [, create, , , , setActive] = requests;
  assert.ok(create && setActive);
  assert.deepEqual(await create.json(), { persona: draft });
  assert.deepEqual(await setActive.json(), { persona_id: persona.id });

  const sessionPersonaGet = requests[4];
  assert.ok(sessionPersonaGet);
  assert.equal(sessionPersonaGet.cache, 'no-store');
});

test('persona API sends null to return the chat to the default assistant', async () => {
  const bodies: unknown[] = [];
  const api = createPersonaApi(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      data: {
        id: 'a-2',
        session_id: 'sess-1',
        turn_id: null,
        persona_id: null,
        persona_name: null,
        model_name: null,
        source: 'default',
        created_at: '2026-08-27T00:00:00.000Z',
      },
    });
  });

  const cleared = await api.setSessionPersona('sess-1', null);

  assert.deepEqual(bodies, [{ persona_id: null }]);
  assert.deepEqual(cleared, {
    persona_id: null,
    persona_name: null,
    model_name: null,
    source: 'default',
    turn_id: null,
  });
});

test('persona API reads a chat that never left the default assistant as null', async () => {
  const api = createPersonaApi(async () => Response.json({ data: null }));
  assert.equal(await api.getSessionPersona('sess-1'), null);
});

test('persona API rejects a malformed persona rather than handing it to the UI', async () => {
  const api = createPersonaApi(async () => Response.json({ data: [{ ...persona, aliases: 'Z' }] }));
  await assert.rejects(api.listPersonas(), /persona response was invalid/i);
});

test('persona API surfaces the server’s conflict message for a duplicate alias', async () => {
  const api = createPersonaApi(async () =>
    Response.json({ error: { message: 'Persona name or alias already in use: z' } }, { status: 409 }),
  );

  await assert.rejects(api.createPersona(draft), /already in use: z/);
});
