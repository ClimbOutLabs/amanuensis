import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPersonalizationApi } from '../src/personalizationApi';

const profile = {
  assistant_name: 'Mira',
  assistant_identity: null,
  voice_guidance: null,
  user_profile: null,
  pinned_preferences: [],
  learned_profile: null,
  learning_enabled: false,
};

test('personalization API treats a missing profile as defaults', async () => {
  const api = createPersonalizationApi(async () => new Response(null, { status: 404 }));
  assert.equal(await api.getProfile(), null);
});

const { learning_enabled: _omittedSwitch, ...profileWithoutSwitch } = profile;

/**
 * A client over a server that answers every request with `data`, collecting the bodies it PUTs
 * so a test can assert what actually went on the wire rather than what the UI held.
 */
function recordingApi(data: unknown) {
  const savedProfiles: unknown[] = [];
  const api = createPersonalizationApi(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    if (request.method === 'PUT') {
      savedProfiles.push(await request.json());
    }
    return Response.json({ data });
  });
  return { api, savedProfiles };
}

async function loadProfile(api: ReturnType<typeof createPersonalizationApi>) {
  const loaded = await api.getProfile();
  if (loaded === null) {
    throw new Error('the scripted response carries a profile');
  }
  return loaded;
}

test('personalization API keeps an absent learning switch absent and rejects a non-boolean one', async () => {
  // Synthesizing a value here would make it indistinguishable from one the server sent, and the
  // client would then send it back to a server whose request object rejects the unknown key.
  const absent = createPersonalizationApi(async () => Response.json({ data: profileWithoutSwitch }));
  assert.deepEqual(await absent.getProfile(), profileWithoutSwitch);

  const malformed = createPersonalizationApi(async () =>
    Response.json({ data: { ...profile, learning_enabled: 'yes' } }),
  );
  await assert.rejects(malformed.getProfile(), /personalization response was invalid/i);
});

test('personalization API omits the learning switch from a save when the server never sent one', async () => {
  const { api, savedProfiles } = recordingApi(profileWithoutSwitch);

  await api.updateProfile(await loadProfile(api));

  // Byte for byte what came back, so an older server sees no key it does not know and the save
  // succeeds instead of failing over a field the user never touched.
  assert.deepEqual(savedProfiles, [{ profile: profileWithoutSwitch }]);
});

test('personalization API sends the learning switch back when the server sent one', async () => {
  const { api, savedProfiles } = recordingApi(profile);

  await api.updateProfile(await loadProfile(api));

  assert.deepEqual(savedProfiles, [{ profile }]);
});

test('personalization API sends a toggled switch even to a server that never sent one', async () => {
  const { api, savedProfiles } = recordingApi(profileWithoutSwitch);
  const loaded = await loadProfile(api);

  // The user has now expressed a choice, and there is no way to honour it without sending it.
  await api.updateProfile({ ...loaded, learning_enabled: true });

  assert.deepEqual(savedProfiles, [{ profile: { ...profileWithoutSwitch, learning_enabled: true } }]);
});

test('personalization API rejects malformed preference data instead of exposing it to the UI', async () => {
  const api = createPersonalizationApi(async () =>
    Response.json({ data: { ...profile, pinned_preferences: { type: 'Buffer', data: [11] } } }),
  );

  await assert.rejects(api.getProfile(), /personalization response was invalid/i);
});

test("personalization API surfaces the server's structured validation message on save failure", async () => {
  // The server nests the human-readable text under `error.message` (RequestErrorResponseSchema);
  // this used to be read as a bare string and handed straight to `new Error()`, which coerces a
  // non-string message to the literal "[object Object]".
  const api = createPersonalizationApi(async () =>
    Response.json(
      { error: { message: 'Personalization content exceeds the 5,500 character limit.' } },
      { status: 400 },
    ),
  );

  await assert.rejects(api.updateProfile(profile), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Personalization content exceeds the 5,500 character limit.');
    assert.doesNotMatch(error.message, /object Object/);
    return true;
  });
});

test('personalization API falls back to a plain string error body', async () => {
  const api = createPersonalizationApi(async () => Response.json({ error: 'Something went wrong.' }, { status: 500 }));

  await assert.rejects(api.getProfile(), /Something went wrong\./);
});

test('personalization API falls back to a status message when the error body has no usable text', async () => {
  const api = createPersonalizationApi(async () => new Response('not json', { status: 503 }));

  await assert.rejects(api.getProfile(), /Request failed \(503\)/);
});

test('personalization API falls back to a status message on a null nested error instead of throwing', async () => {
  // `{ error: null }` is a malformed but not impossible body (typeof null is 'object', the same
  // as a real nested error record) — this must fall through to the status fallback, not throw a
  // TypeError while reaching for a `.message` that null does not have.
  const api = createPersonalizationApi(async () => Response.json({ error: null }, { status: 502 }));

  await assert.rejects(api.getProfile(), /Request failed \(502\)/);
});

test('personalization API falls back to a status message on an empty nested error message', async () => {
  // An empty `error.message` is falsy content, not a usable one; returning it verbatim would show
  // the user a blank banner instead of the generic status fallback.
  const api = createPersonalizationApi(async () => Response.json({ error: { message: '' } }, { status: 400 }));

  await assert.rejects(api.getProfile(), /Request failed \(400\)/);
});

test('personalization API uses the Phase 1 profile routes', async () => {
  const requests: Request[] = [];
  const api = createPersonalizationApi(async (input, init) => {
    requests.push(new Request(new URL(String(input), 'http://localhost'), init));
    const request = requests.at(-1)!;
    if (request.method === 'GET') return Response.json({ data: profile });
    if (request.method === 'PUT') return Response.json({ data: profile });
    return new Response('{}');
  });

  assert.deepEqual(await api.getProfile(), profile);
  assert.deepEqual(await api.updateProfile(profile), profile);
  await api.deleteProfile();
  assert.deepEqual(
    requests.map(request => [request.method, new URL(request.url).pathname]),
    [
      ['GET', '/api/v1/personalization/profile'],
      ['PUT', '/api/v1/personalization/profile'],
      ['DELETE', '/api/v1/personalization/profile'],
    ],
  );
  assert.deepEqual(await requests[1]!.json(), { profile });
});
