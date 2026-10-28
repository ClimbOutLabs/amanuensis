import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../scripts/eval-spaces/cli.mjs';
import { loadSpaceSet } from '../scripts/eval-spaces/parse.mjs';
import { runEvalSpaces, SPACE_CSV_COLUMNS } from '../scripts/eval-spaces/run.mjs';
import { createInstanceClient } from '../scripts/eval-tokens/client.mjs';
import { startFakeInstance } from './eval-tokens/fakeInstance.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureSetPath = path.join(rootDir, 'tests', 'fixtures', 'eval-spaces', 'space-set.json');
const TOKEN = 'fake-token-for-tests-only-0123456789';

const metrics = {
  plain: {
    steps: 3,
    sub_agent_steps: 0,
    total_input_tokens: 1000,
    total_output_tokens: 100,
    total_cache_read_tokens: null,
    total_reasoning_tokens: null,
    last_call_input_tokens: 500,
    tool_calls_by_tool: { create_space: 1, edit_space: 2 },
    results_by_kind: { ok: 2, refused: 1, unavailable: 0, error: 0 },
    guard_fired: null,
    claim_mismatch: false,
    wall_time_ms: 500,
    time_to_first_token_ms: 100,
  },
};

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

async function withFake(fn) {
  const fake = await startFakeInstance({ token: TOKEN, metrics });
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-spaces-run-'));
  try {
    const client = createInstanceClient({ baseUrl: fake.baseUrl, token: TOKEN });
    return await fn({ fake, dir, client });
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function runFixture({ client, dir, keep = false, runs = 1 }) {
  return await runEvalSpaces({
    client,
    spaceSet: await loadSpaceSet(fixtureSetPath),
    model: 'fake/model-1',
    temperature: 0,
    runs,
    label: 'fake',
    outDir: path.join(dir, 'out'),
    keep,
    generatedAt: new Date('2026-01-01T00:00:00.000Z'),
    pollIntervalMs: 0,
  });
}

test('a run scores the stored space, walks its revisions, and removes the space', async () => {
  await withFake(async ({ fake, dir, client }) => {
    const { rows, csvPath, summaryPath } = await runFixture({ client, dir });
    const [made, plain] = rows;

    assert.equal(made.status, 'done');
    assert.equal(made.create_calls, 2, 'two turns, one create each');
    assert.equal(made.edit_calls, 4);
    assert.equal(made.refused_or_failed_calls, 2);
    assert.equal(made.rows, 3);
    assert.equal(made.duplicate_rows, 0);
    assert.equal(made.table_valid, true);
    assert.equal(made.closing_line, true);
    assert.equal(made.formatting_changed, true);
    assert.equal(made.rows_lost, 'revision 2: gamma');
    assert.equal(made.expectations_met, true, made.failed_expectations);
    assert.equal(made.error, '');

    assert.equal(plain.space_id, undefined);
    assert.equal(plain.completed, false);
    assert.equal(plain.expectations_met, false);
    assert.match(plain.error, /No new space/);

    assert.equal((await client.listAllSpaces()).length, 0, 'the space is gone');
    assert.ok(fake.requests.some(request => request.method === 'DELETE'));
    assert.ok(
      fake.requests.some(request => request.path?.includes('?revision=1')),
      'old revisions were read',
    );

    const lines = (await readFile(csvPath, 'utf8')).trim().split('\n');
    assert.deepEqual(parseCsvLine(lines[0]), [...SPACE_CSV_COLUMNS]);
    assert.equal(lines.length, 3);
    const summary = await readFile(summaryPath, 'utf8');
    assert.match(summary, /^# Space eval: fake/);
    assert.match(summary, /Runs that met every target: 1 of 1/);
  });
});

test('--keep leaves the spaces in the instance', async () => {
  await withFake(async ({ dir, client }) => {
    await runFixture({ client, dir, keep: true });
    const spaces = await client.listAllSpaces();
    assert.equal(spaces.length, 1);
    assert.equal(spaces[0].revision, 3);
  });
});

test('a follow-up that changes only spacing does not count as a formatting change', async () => {
  await withFake(async ({ dir, client }) => {
    const set = await loadSpaceSet(fixtureSetPath);
    const [prompt] = set.prompts;
    const { rows } = await runEvalSpaces({
      client,
      spaceSet: { ...set, prompts: [{ ...prompt, follow_up: 'Thanks.' }] },
      model: 'fake/model-1',
      temperature: 0,
      runs: 1,
      label: 'fake',
      outDir: path.join(dir, 'out'),
      pollIntervalMs: 0,
    });
    assert.equal(rows[0].formatting_changed, false);
    assert.equal(rows[0].expectations_met, false);
    assert.match(rows[0].failed_expectations, /formatting_changed false != true/);
  });
});

test('getSpace reads a stored revision and answers 404 past the kept history', async () => {
  await withFake(async ({ dir, client }) => {
    await runFixture({ client, dir, keep: true });
    const [space] = await client.listAllSpaces();
    const first = await client.getSpace({ id: space.id, revision: 1 });
    assert.match(first.body, /Gamma/);
    await assert.rejects(client.getSpace({ id: space.id, revision: 99 }), { status: 404 });
  });
});

test('the command refuses an instance that is not in eval mode and sends no prompts', async () => {
  const fake = await startFakeInstance({ token: TOKEN, metrics, evalMode: false });
  try {
    const errors = [];
    const code = await main({
      argv: ['--instance', fake.baseUrl, '--model', 'fake/model-1', '--label', 'x'],
      env: { TRUEFORGE_TOKEN: TOKEN },
      stdout: () => undefined,
      stderr: text => errors.push(text),
      rootDir,
    });
    assert.equal(code, 1);
    assert.match(errors.join(''), /not an eval instance/);
    assert.ok(!fake.requests.some(request => request.method === 'POST'));
  } finally {
    await fake.close();
  }
});

test('the command writes the results and accepts --keep', async () => {
  const fake = await startFakeInstance({ token: TOKEN, metrics });
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-spaces-cli-'));
  try {
    const out = [];
    const code = await main({
      argv: [
        '--instance',
        fake.baseUrl,
        '--model',
        'fake/model-1',
        '--label',
        'x',
        '--set',
        fixtureSetPath,
        '--out',
        path.join(dir, 'out'),
        '--keep',
      ],
      env: { TRUEFORGE_TOKEN: TOKEN },
      stdout: text => out.push(text),
      stderr: () => undefined,
      rootDir,
      pollIntervalMs: 0,
    });
    assert.equal(code, 0);
    assert.match(out.join(''), /Wrote 2 runs \(1 met every target\)/);
    assert.ok(!fake.requests.some(request => request.method === 'DELETE'));
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function fetchFailing({ nth }) {
  let listCalls = 0;
  return async (url, init) => {
    if (init?.method === 'GET' && /\/api\/v1\/spaces(\?|$)/.test(String(url))) {
      listCalls += 1;
      if (listCalls === nth) {
        return { ok: false, status: 500, text: async () => JSON.stringify({ error: { message: 'Try again.' } }) };
      }
    }
    return await fetch(url, init);
  };
}

async function runWith({ fake, dir, prompts, fetchImpl, keep = false }) {
  const client = createInstanceClient({ baseUrl: fake.baseUrl, token: TOKEN, fetchImpl });
  return await runEvalSpaces({
    client,
    spaceSet: { version: 1, prompts },
    model: 'fake/model-1',
    temperature: 0,
    runs: 1,
    label: 'fake',
    outDir: path.join(dir, 'out'),
    keep,
    pollIntervalMs: 0,
  });
}

async function seedPersonsSpace(client) {
  const list = await client.listSpaces();
  await client.createSpace({
    space: { name: 'Mine to keep', purpose: 'A person made this.', status: 'active', body: 'x', format: 'markdown' },
    expected_aggregate_revision: list.aggregate_revision,
  });
}

test('a failing first listing deletes nothing', async () => {
  await withFake(async ({ fake, dir, client }) => {
    await seedPersonsSpace(client);
    const { rows } = await runWith({
      fake,
      dir,
      fetchImpl: fetchFailing({ nth: 1 }),
      prompts: [{ id: 'p', prompt: 'MAKES_SPACE:Breeds go', expect: { rows: 3 } }],
    });
    assert.equal(rows[0].status, 'request_failed');
    assert.match(rows[0].error, /nothing was deleted/);
    assert.equal((await client.listAllSpaces()).length, 1, "the person's space survives");
    assert.ok(!fake.requests.some(request => request.method === 'DELETE'));
  });
});

test('a space someone else makes during the run is neither scored nor deleted', async () => {
  await withFake(async ({ dir, fake, client }) => {
    const { rows } = await runWith({
      fake,
      dir,
      prompts: [{ id: 'p', prompt: 'MAKES_SPACE:Mine OTHER_MAKES_SPACE:Theirs go', expect: { rows: 3 } }],
    });
    assert.equal(rows[0].new_spaces, 1);
    assert.equal(rows[0].expectations_met, true, rows[0].failed_expectations);
    const left = await client.listAllSpaces();
    assert.deepEqual(
      left.map(space => space.name),
      ['Theirs'],
    );
  });
});

test('a chat that fails after its first turn keeps its metrics and still cleans up', async () => {
  await withFake(async ({ dir, fake, client }) => {
    const { rows } = await runWith({
      fake,
      dir,
      fetchImpl: fetchFailing({ nth: 2 }),
      prompts: [
        { id: 'p', prompt: 'MAKES_SPACE:Mine go', follow_up: 'REFORMATS_SPACE', expect: { formatting_changed: true } },
      ],
    });
    assert.equal(rows[0].status, 'request_failed');
    assert.equal(rows[0].steps, 3, 'the first turn is kept');
    assert.equal(rows[0].expectations_met, false);
    assert.equal(rows[0].formatting_changed, false);
    assert.equal((await client.listAllSpaces()).length, 0);
  });
});

test('a first turn that errors cannot pass formatting_changed', async () => {
  await withFake(async ({ dir, fake }) => {
    const { rows } = await runWith({
      fake,
      dir,
      prompts: [
        {
          id: 'p',
          prompt: 'MAKES_SPACE:Mine FAILS_TURN',
          follow_up: 'REFORMATS_SPACE',
          expect: { formatting_changed: true, table_valid: true },
        },
      ],
    });
    assert.equal(rows[0].status, 'error');
    assert.equal(rows[0].formatting_changed, false);
    assert.equal(rows[0].expectations_met, false);
    assert.match(rows[0].failed_expectations, /status error is not done/);
    assert.match(rows[0].error, /follow-up did not run/);
  });
});

test('a follow-up that makes a second space cannot pass formatting_changed', async () => {
  await withFake(async ({ dir, fake, client }) => {
    const { rows } = await runWith({
      fake,
      dir,
      prompts: [
        {
          id: 'p',
          prompt: 'MAKES_SPACE:First go',
          follow_up: 'MAKES_SPACE:Second go',
          expect: { formatting_changed: true },
        },
      ],
    });
    assert.equal(rows[0].new_spaces, 2);
    assert.equal(rows[0].formatting_changed, false);
    assert.equal(rows[0].expectations_met, false);
    assert.equal((await client.listAllSpaces()).length, 0, 'both spaces the chat made are removed');
  });
});
