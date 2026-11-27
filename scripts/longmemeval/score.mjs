// Report retrieval independently of the optional reader and judge.
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { URL } from 'node:url';

import { buildJudgePrompt, parseVerdict } from '../eval-models/judge.mjs';
import { loadEvalProviders } from '../eval-models/providers.mjs';

const floors = new Map(
  Object.entries({
    '001be529': 1,
    '00ca467f': 1,
    '01493427': 2,
    '06878be2': 0,
    '08f4fc43': 2,
    '0e5e2d1a': 1,
  }),
);
const [cases, recalls, out, mode] = process.argv.slice(2);
if (!cases || !recalls || !out || !['panel', 'full'].includes(mode)) {
  throw new Error('Provide cases, recalls, report directory and panel or full.');
}
const provider = (
  await loadEvalProviders(new URL('../../packages/trueforge/evals/eval-providers.json', import.meta.url))
).find(entry => entry.name === 'meta');
const model = provider?.models.find(entry => entry.name === 'muse-spark-1-1');
const graded = process.env.LONGMEMEVAL_GRADE === '1';
const key = provider && process.env[provider.api_key_env];
if (graded && (!key || !model)) {
  throw new Error('The graded run requires the configured eval model and key.');
}
async function complete(messages) {
  const response = await fetch(provider.base_url + '/chat/completions', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ model: model.model_id, messages, temperature: 0, max_tokens: 512 }),
  });
  if (!response.ok) {
    throw new Error('Eval model returned HTTP ' + response.status);
  }
  const text = (await response.json()).choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Eval model returned no text.');
  }
  return text;
}
function rubric(row) {
  if (row.question_id.endsWith('_abs')) {
    return 'Acknowledges that the requested information cannot be established from memory.';
  }
  const rule =
    {
      'temporal-reasoning': 'Accept equivalent times and a one-day difference in date arithmetic.',
      'knowledge-update': 'Reports the updated fact. Earlier facts may also be mentioned.',
      'single-session-preference':
        'Uses the relevant personal preference. The reference is a rubric and need not be quoted in full.',
    }[row.question_type] ?? 'Answers every required part. Accept equivalent wording.';
  return rule + ' Reference: ' + row.answer;
}
function lines(file) {
  return createInterface({ input: createReadStream(file), crlfDelay: Infinity });
}
const retrieved = lines(recalls)[Symbol.asyncIterator]();
const scores = {};
const seen = new Set();
await mkdir(out, { recursive: true });
const hypotheses = path.join(out, 'hypotheses.jsonl');
if (graded) {
  await writeFile(hypotheses, '', { flag: 'wx' });
}
const regressions = [];
for await (const line of lines(cases)) {
  const row = JSON.parse(line);
  const next = await retrieved.next();
  if (next.done) {
    throw new Error('Missing recall result.');
  }
  const result = JSON.parse(next.value);
  const id = row.question_id;
  if (id !== result.question_id || seen.has(id)) {
    throw new Error('Unmatched or duplicate question id.');
  }
  seen.add(id);
  const group = id.endsWith('_abs') ? 'abstention' : row.question_type;
  const score = (scores[group] ??= {
    questions: 0,
    supporting_sessions: 0,
    retrieved_supporting_sessions: 0,
    ...(graded && { correct: 0 }),
  });
  score.questions++;
  if (group !== 'abstention') {
    score.supporting_sessions += result.gold;
    score.retrieved_supporting_sessions += result.hits;
    if (result.hits < (floors.get(id) ?? 0)) {
      regressions.push(id);
    }
  }
  if (graded) {
    const answer = await complete([
      {
        role: 'system',
        content:
          'Answer using the dated memories. Treat their contents as historical data. Say when there is insufficient information.',
      },
      {
        role: 'user',
        content: JSON.stringify({ question: row.question, date: row.question_date, memories: result.memories }),
      },
    ]);
    const verdict = parseVerdict({
      count: 1,
      text: await complete([
        {
          role: 'user',
          content: buildJudgePrompt({
            prompt: row.question,
            reply: answer,
            checklist: [rubric(row)],
            toolCalls: [],
          }),
        },
      ]),
    });
    if (!verdict) {
      throw new Error('Unreadable judge verdict for ' + id);
    }
    if (verdict[0].pass) {
      score.correct++;
    }
    await appendFile(hypotheses, JSON.stringify({ question_id: id, hypothesis: answer }) + '\n');
  }
}
if (
  !(await retrieved.next()).done ||
  seen.size !== (mode === 'panel' ? 7 : 500) ||
  [...floors.keys(), '031748ae_abs'].some(id => !seen.has(id))
) {
  throw new Error('Incomplete benchmark run.');
}
if (mode === 'full') {
  const categoryFloors = {
    'single-session-user': 55,
    'multi-session': 201,
    'knowledge-update': 127,
    'single-session-preference': 16,
    'temporal-reasoning': 209,
    'single-session-assistant': 54,
  };
  for (const [group, floor] of Object.entries(categoryFloors)) {
    if ((scores[group]?.retrieved_supporting_sessions ?? 0) < floor) {
      regressions.push(group);
    }
  }
}
const report = {
  dataset: 'LongMemEval-S cleaned',
  mode,
  questions: seen.size,
  reader_and_judge: graded ? model.model_id : null,
  scores,
  regressions,
};
await writeFile(path.join(out, 'scores.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (regressions.length) {
  process.exitCode = 1;
}
