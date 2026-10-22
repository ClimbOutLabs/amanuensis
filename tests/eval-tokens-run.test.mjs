import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, parseRunnerArgs, readRunnerToken, UsageProblem } from '../scripts/eval-tokens/cli.mjs';
import { createInstanceClient, InstanceHttpError, InstanceUnreachableError } from '../scripts/eval-tokens/client.mjs';
import { REPLY_CSV_COLUMNS } from '../scripts/eval-tokens/csv.mjs';
import { loadTokenSet } from '../scripts/eval-tokens/parse.mjs';
import { combineTurnMetrics, runEvalTokens } from '../scripts/eval-tokens/run.mjs';
import { loadFakeMetrics, startFakeInstance } from './eval-tokens/fakeInstance.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureSetPath = path.join(rootDir, 'tests', 'fixtures', 'eval-tokens', 'token-set.json');
const TOKEN = 'fake-token-for-tests-only-0123456789';

/** Small RFC 4180 reader: quoted cells may hold commas, quotes and line breaks. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
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
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function asObjects(rows) {
  const [header, ...body] = rows;
  return body.map(cells => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])));
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-tokens-run-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a fake-instance run writes one CSV row per reply, a blank pass column, and a summary', async () => {
  const metrics = await loadFakeMetrics();
  const fake = await startFakeInstance({ token: TOKEN, metrics });
  try {
    await withTempDir(async dir => {
      const tokenSet = await loadTokenSet(fixtureSetPath);
      const client = createInstanceClient({ baseUrl: fake.baseUrl, token: TOKEN });
      const outDir = path.join(dir, 'out');
      const result = await runEvalTokens({
        client,
        tokenSet,
        model: 'fake/model-1',
        temperature: 0,
        runs: 2,
        label: 'fake baseline',
        outDir,
        generatedAt: new Date('2026-01-01T00:00:00.000Z'),
        pollIntervalMs: 0,
      });

      const csv = await readFile(result.csvPath, 'utf8');
      const rows = parseCsv(csv);
      assert.deepEqual(rows[0], [...REPLY_CSV_COLUMNS]);
      const records = asObjects(rows);
      assert.equal(records.length, 18 * 2);
      assert.equal(records.filter(record => record.run === '1').length, 18);
      for (const prompt of tokenSet.prompts) {
        assert.equal(records.filter(record => record.prompt_id === prompt.id).length, 2, prompt.id);
      }
      assert.ok(
        records.every(record => record.pass === ''),
        'pass column stays empty',
      );
      assert.ok(records.every(record => record.model === 'fake/model-1' && record.label === 'fake baseline'));
      assert.ok(records.every(record => record.status === 'done'));
      assert.ok(records.every(record => record.checklist.includes(' | ')));

      const plain = records.find(record => record.prompt_id === 'simple-01' && record.run === '1');
      assert.equal(plain.input_tokens, '1200');
      assert.equal(plain.cached_input_tokens, '', 'null stays empty');
      assert.equal(plain.reasoning_tokens, '40');
      assert.equal(plain.tool_calls_by_tool, '{"calendar_lookup":1}');
      assert.equal(plain.results_by_kind, '{"ok":1,"refused":0,"unavailable":0,"error":0}');
      assert.equal(plain.time_to_first_token_ms, '300');
      assert.match(plain.reply, /^FAKE REPLY: /);

      const missing = records.find(record => record.prompt_id === 'simple-04' && record.run === '2');
      assert.equal(missing.status, 'done');
      assert.equal(missing.steps, '');
      assert.equal(missing.input_tokens, '');
      assert.equal(missing.tool_calls_by_tool, '');
      assert.equal(missing.results_by_kind, '');
      assert.ok(missing.reply.startsWith('FAKE REPLY'));

      const approved = records.find(record => record.prompt_id === 'approval-01' && record.run === '1');
      assert.equal(approved.approvals, '1');
      assert.equal(approved.steps, '2', 'paused and resumed steps add up');
      assert.equal(approved.input_tokens, '1200', '500 + 700');
      assert.equal(approved.output_tokens, '80');
      assert.equal(approved.cached_input_tokens, '300');
      assert.equal(approved.wall_time_ms, '750');
      assert.equal(approved.last_call_input_tokens, '700', 'taken from the final call');
      assert.equal(approved.tool_calls_by_tool, '{"send_message":2}');
      assert.equal(approved.claim_mismatch, 'true');
      assert.match(approved.reply, /^FAKE REPLY \(approved\)/);

      const summary = await readFile(result.summaryPath, 'utf8');
      assert.equal(summary.split('**Pass:**').length - 1, 36);
      assert.ok(!/Pass:\*\* \S/.test(summary), 'no pass value is filled in');
      for (const prompt of tokenSet.prompts) {
        assert.ok(summary.includes(`## ${prompt.id} (${prompt.group})`), prompt.id);
      }
      assert.ok(summary.includes('- Temperature: 0'));
      assert.ok(summary.includes('- Instance: http://127.0.0.1:'));

      // The token is sent only as a header; no output file may hold it.
      assert.ok(!csv.includes(TOKEN) && !summary.includes(TOKEN), 'no secret in outputs');
      assert.ok(!csv.includes('Bearer') && !summary.includes('Bearer'), 'no auth header text in outputs');
    });

    const sessionCreates = fake.requests.filter(request => request.path === '/api/v1/sessions');
    assert.equal(sessionCreates.length, 36, 'one session per prompt per run');
    assert.ok(sessionCreates.every(request => request.body.agent.spec.model.params.temperature === 0));
    assert.ok(fake.requests.every(request => request.authorization === `Bearer ${TOKEN}`));

    const approvals = fake.requests
      .filter(request => request.body?.input?.[0]?.type === 'user.tool_approval')
      .map(request => request.body.input[0]);
    assert.equal(approvals.length, 6, 'three approval prompts, two runs each');
    assert.ok(approvals.filter(item => item.approval.status === 'allow').length === 4);
    const declined = approvals.filter(item => item.approval.status === 'deny');
    assert.equal(declined.length, 2);
    assert.ok(declined.every(item => typeof item.approval.reason === 'string'));
    assert.ok(approvals.every(item => item.thread_id === 'main' && item.tool_call_id.startsWith('call_fake_')));
  } finally {
    await fake.close();
  }
});

test('a wrong token stops the run at once and writes no output', async () => {
  const fake = await startFakeInstance({ token: TOKEN, metrics: await loadFakeMetrics() });
  try {
    await withTempDir(async dir => {
      const tokenSet = await loadTokenSet(fixtureSetPath);
      const client = createInstanceClient({ baseUrl: fake.baseUrl, token: 'wrong-token-value-xyz' });
      const outDir = path.join(dir, 'out');
      await assert.rejects(
        runEvalTokens({ client, tokenSet, model: 'fake/m', temperature: 0, runs: 1, label: 'x', outDir }),
        error => {
          assert.ok(error instanceof InstanceHttpError);
          assert.equal(error.status, 401);
          assert.ok(!error.message.includes('wrong-token-value-xyz'));
          return true;
        },
      );
      await assert.rejects(readFile(path.join(outDir, 'replies.csv'), 'utf8'));
    });
  } finally {
    await fake.close();
  }
});

test('an unreachable instance stops the run with a plain message', async () => {
  const fake = await startFakeInstance({ token: TOKEN, metrics: await loadFakeMetrics() });
  const closedUrl = fake.baseUrl;
  await fake.close();
  const tokenSet = await loadTokenSet(fixtureSetPath);
  const client = createInstanceClient({ baseUrl: closedUrl, token: TOKEN });
  await assert.rejects(
    runEvalTokens({ client, tokenSet, model: 'fake/m', temperature: 0, runs: 1, label: 'x', outDir: tmpdir() }),
    error => {
      assert.ok(error instanceof InstanceUnreachableError);
      assert.ok(error.message.includes('Check that the instance is running'));
      return true;
    },
  );
});

test('the command reads the token from the environment and prints no secret', async () => {
  const fake = await startFakeInstance({ token: TOKEN, metrics: await loadFakeMetrics() });
  try {
    await withTempDir(async dir => {
      const out = [];
      const err = [];
      const outDir = path.join(dir, 'cli-out');
      const code = await main({
        argv: [
          '--instance',
          fake.baseUrl,
          '--model',
          'fake/model-1',
          '--label',
          'cli check',
          '--set',
          fixtureSetPath,
          '--out',
          outDir,
        ],
        env: { TRUEFORGE_TOKEN: TOKEN },
        rootDir: dir,
        stdout: text => out.push(text),
        stderr: text => err.push(text),
        pollIntervalMs: 0,
      });
      assert.equal(code, 0, err.join(''));
      assert.ok(out.join('').includes('Wrote 18 replies'));
      const everything = [...out, ...err].join('');
      assert.ok(!everything.includes(TOKEN));
      const csv = await readFile(path.join(outDir, 'replies.csv'), 'utf8');
      assert.ok(!csv.includes(TOKEN));
    });
  } finally {
    await fake.close();
  }
});

test('the token is read from the environment first, then the gitignored file, and never from argv', async () => {
  await withTempDir(async dir => {
    const envFile = path.join(dir, '.env.eval-tokens');
    await writeFile(envFile, `# comment\nTRUEFORGE_TOKEN="from-file-value"\n`);
    assert.equal(await readRunnerToken({ env: { TRUEFORGE_TOKEN: 'from-env' }, envFile }), 'from-env');
    assert.equal(await readRunnerToken({ env: {}, envFile }), 'from-file-value');
    assert.equal(await readRunnerToken({ env: {}, envFile: path.join(dir, 'missing') }), undefined);
    assert.throws(() => parseRunnerArgs(['--token', TOKEN]), UsageProblem);
  });
});

test('command line checks name the one thing to fix', () => {
  assert.throws(() => parseRunnerArgs(['--model', 'a/b', '--label', 'x']), /Missing --instance/);
  assert.throws(
    () => parseRunnerArgs(['--instance', 'http://x', '--model', 'nomodel', '--label', 'x']),
    /provider\/model/,
  );
  assert.throws(() => parseRunnerArgs(['--instance', 'http://x', '--model', 'a/b']), /Missing --label/);
  assert.throws(
    () => parseRunnerArgs(['--instance', 'http://x', '--model', 'a/b', '--label', 'x', '--runs', '0']),
    /--runs/,
  );
  const args = parseRunnerArgs(['--instance', 'http://localhost:8790/', '--model', 'a/b', '--label', ' x ']);
  assert.equal(args.instance, 'http://localhost:8790');
  assert.equal(args.label, 'x');
  assert.equal(args.runs, 1);
  assert.equal(args.temperature, 0);
});

test('usage errors exit with code 2 and say what to fix', async () => {
  const err = [];
  const code = await main({ argv: ['--model', 'a/b'], stdout: () => undefined, stderr: text => err.push(text) });
  assert.equal(code, 2);
  assert.ok(err.join('').includes('Missing --instance'));
});

test('combineTurnMetrics keeps missing values missing', () => {
  const combined = combineTurnMetrics([undefined, undefined]);
  assert.equal(combined.steps, undefined);
  assert.equal(combined.tool_calls_by_tool, undefined);
  assert.equal(combined.claim_mismatch, undefined);
});
