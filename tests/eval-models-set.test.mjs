import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withoutKeys } from '../scripts/eval-models/fresh.mjs';
import { CHECK_TYPES, loadModelSet, ModelSetError, parseModelSet } from '../scripts/eval-models/parse.mjs';
import {
  addEvalProviders,
  loadEvalProviders,
  parseEvalProviders,
  providerPrices,
} from '../scripts/eval-models/providers.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evalsDir = path.join(rootDir, 'packages', 'trueforge', 'evals');

function validSet() {
  return {
    version: 1,
    memories: [{ text: 'My dentist is Dr. Example.', timestamp: '2026-08-04T09:10:00Z' }],
    cases: [
      {
        id: 'memory-a',
        group: 'memory',
        prompt: 'Who is my dentist?',
        approval_policy: 'decline',
        checks: [{ type: 'reply_includes', any: ['Example'] }],
      },
      {
        id: 'safety-a',
        group: 'safety',
        prompt: 'Summarize this.',
        approval_policy: 'approve',
        checklist: ['The reply is a summary.'],
      },
    ],
  };
}

function problemsOf(value) {
  try {
    parseModelSet(value);
  } catch (error) {
    assert.ok(error instanceof ModelSetError, 'expected a ModelSetError');
    return error.problems;
  }
  assert.fail('expected the set to be rejected');
}

test('the shipped set has 15 memory questions and 10 safety traps', async () => {
  const set = await loadModelSet(path.join(evalsDir, 'model-set.json'));
  assert.equal(set.cases.filter(item => item.group === 'memory').length, 15);
  assert.equal(set.cases.filter(item => item.group === 'safety').length, 10);
  assert.ok(set.memories.length > 0);
});

test('every planted address in the shipped set is on a reserved test domain', async () => {
  const set = await loadModelSet(path.join(evalsDir, 'model-set.json'));
  for (const item of set.cases) {
    for (const check of item.checks) {
      if (check.type === 'no_tool_args_include') {
        assert.ok(
          check.any.every(word => word.endsWith('.invalid')),
          `${item.id} must only name .invalid hosts`,
        );
      }
    }
  }
});

test('every inbox trap in the shipped set has its email in the eval inbox', async () => {
  const set = await loadModelSet(path.join(evalsDir, 'model-set.json'));
  const inbox = await readFile(path.join(evalsDir, 'fixtures', 'inbox.json'), 'utf8');
  for (const item of set.cases.filter(entry => entry.id.startsWith('safety-inbox-'))) {
    const planted = item.checks.find(check => check.type === 'no_tool_args_include');
    if (planted !== undefined) {
      assert.ok(
        planted.any.every(host => inbox.includes(host)),
        `${item.id} names a host that no inbox email has`,
      );
    }
  }
});

test('a valid set parses and keeps cases without checks or checklist empty', () => {
  const set = parseModelSet(validSet());
  assert.deepEqual(set.cases[0].checklist, []);
  assert.deepEqual(set.cases[1].checks, []);
});

test('a case with neither checks nor checklist is refused', () => {
  const value = validSet();
  delete value.cases[1].checklist;
  assert.match(problemsOf(value).join('\n'), /can never fail/);
});

test('unknown check types and empty lists are refused', () => {
  const value = validSet();
  value.cases[0].checks = [
    { type: 'reply_sounds_nice', any: ['x'] },
    { type: 'no_tool', tools: [] },
  ];
  const problems = problemsOf(value).join('\n');
  assert.match(problems, new RegExp(CHECK_TYPES.join(', ')));
  assert.match(problems, /tools must be a non-empty list/);
});

test('duplicate ids, unknown groups and bad memories are refused', () => {
  const value = validSet();
  value.cases[1].id = 'memory-a';
  value.cases[1].group = 'cooking';
  value.memories.push({ text: 'No date' });
  const problems = problemsOf(value).join('\n');
  assert.match(problems, /used more than once/);
  assert.match(problems, /group must be one of memory, safety/);
  assert.match(problems, /needs text and a timestamp/);
});

test('the shipped eval providers parse, and each priced model is keyed by provider/model', async () => {
  const providers = await loadEvalProviders(path.join(evalsDir, 'eval-providers.json'));
  assert.ok(providers.length > 0);
  for (const provider of providers) {
    assert.match(provider.base_url, /^https:\/\//);
  }
  assert.ok('meta/muse-spark-1-1' in providerPrices(providers));
});

test('a provider is added only when its key is set, and the key goes only to the instance', async () => {
  const providers = parseEvalProviders({
    version: 1,
    providers: [
      {
        name: 'one',
        base_url: 'https://one.example',
        api_key_env: 'ONE_KEY',
        models: [{ model_id: 'm.1', name: 'm-1' }],
      },
      {
        name: 'two',
        base_url: 'https://two.example',
        api_key_env: 'TWO_KEY',
        models: [{ model_id: 'm', name: 'm-2' }],
      },
    ],
  });
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), authorization: init.headers.authorization });
    return { ok: true, status: 201 };
  };
  const added = await addEvalProviders({
    providers,
    env: { ONE_KEY: 'secret-one' },
    origin: 'http://127.0.0.1:1',
    token: 'tok',
    fetchImpl,
  });
  assert.deepEqual(
    added.map(provider => provider.name),
    ['one'],
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'http://127.0.0.1:1/api/v1/settings/model-providers');
  assert.equal(sent[0].body.manifest.auth.api_key, 'secret-one');
  assert.equal(sent[0].body.manifest.type, 'custom');
});

test('a provider with a plain http address or a bad name is refused', () => {
  assert.throws(
    () =>
      parseEvalProviders({
        version: 1,
        providers: [{ name: 'Bad Name', base_url: 'http://x.example', api_key_env: 'K', models: [] }],
      }),
    /name must be lower-case/,
  );
  assert.throws(
    () =>
      parseEvalProviders({
        version: 1,
        providers: [
          { name: 'ok', base_url: 'http://x.example', api_key_env: 'K', models: [{ model_id: 'a', name: 'a1' }] },
        ],
      }),
    /https address/,
  );
});

test('the eval runner and the build step get the environment without any model key', () => {
  const providers = parseEvalProviders({
    version: 1,
    providers: [
      { name: 'one', base_url: 'https://one.example', api_key_env: 'ONE_KEY', models: [{ model_id: 'a', name: 'a1' }] },
    ],
  });
  assert.deepEqual(withoutKeys({ env: { ONE_KEY: 'x', NEBIUS_API_KEY: 'y', PATH: '/bin' }, providers }), {
    PATH: '/bin',
  });
});
