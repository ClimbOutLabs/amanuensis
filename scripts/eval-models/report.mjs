// Turns graded rows into the side-by-side comparison, the CSV, and the score history.
import { toCsv } from '../eval-tokens/csv.mjs';

export const PARTS = Object.freeze(['tasks', 'safety', 'memory']);
const PART_TITLES = Object.freeze({ tasks: 'Everyday tasks', safety: 'Safety traps', memory: 'Memory' });

/** Column order is the contract for reading results side by side. */
export const RESULT_CSV_COLUMNS = Object.freeze([
  'model',
  'run',
  'case_id',
  'part',
  'group',
  'pass',
  'status',
  'failed_because',
  'input_tokens',
  'output_tokens',
  'steps',
  'wall_time_ms',
  'tool_calls',
  'reply',
  'error',
]);

/** Plain reasons a row failed: unfinished chat, failed rules, failed judged items. */
export function failureReasons(row) {
  if (row.status !== 'done') {
    return [`the chat did not finish (${row.status}${row.error ? `: ${row.error}` : ''})`];
  }
  const reasons = row.checks.filter(check => !check.pass).map(check => `${check.check}: ${check.detail}`);
  row.judged.forEach((item, index) => {
    if (!item.pass) {
      reasons.push(`${row.checklist[index] ?? 'checklist item'} (${item.reason || 'judged not met'})`);
    }
  });
  return reasons;
}

export function resultCsv(rows) {
  return toCsv(
    RESULT_CSV_COLUMNS,
    rows.map(row => ({
      ...row,
      failed_because: row.pass ? '' : failureReasons(row).join(' | '),
      tool_calls: row.tool_calls.map(call => call.name),
    })),
  );
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (typeof row[key] === 'number' ? row[key] : 0), 0);
}

/**
 * One line per model: passes overall and per part, tokens, time and cost.
 * @returns {{ model: string, passed: number, total: number, parts: Record<string, { passed: number, total: number }>, input_tokens: number, output_tokens: number, wall_time_ms: number, cost_usd: number | null }[]}
 */
export function scoreModels({ models, rows, costs }) {
  return models.map(model => {
    const mine = rows.filter(row => row.model === model);
    const parts = Object.fromEntries(
      PARTS.map(part => {
        const inPart = mine.filter(row => row.part === part);
        return [part, { passed: inPart.filter(row => row.pass).length, total: inPart.length }];
      }),
    );
    return {
      model,
      passed: mine.filter(row => row.pass).length,
      total: mine.length,
      parts,
      input_tokens: sum(mine, 'input_tokens'),
      output_tokens: sum(mine, 'output_tokens'),
      wall_time_ms: sum(mine, 'wall_time_ms'),
      cost_usd: costs[model] ?? null,
    };
  });
}

function percent(passed, total) {
  return total === 0 ? '-' : `${String(Math.round((passed / total) * 100))}%`;
}

function money(value) {
  return value === null || value === undefined ? 'not known' : `$${value.toFixed(2)}`;
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/**
 * @param {{ label: string, generatedAt: string, origin: string, judgeModel: string, judgeCost: number | undefined, runs: number, temperature: number, setVersions: Record<string, number>, models: string[], costs: Record<string, number | undefined>, rows: any[], cleanupProblems: string[] }} options
 */
export function buildReport(options) {
  const scores = scoreModels(options);
  const lines = [
    `# Model eval: ${options.label}`,
    '',
    `Run on ${options.generatedAt} against ${options.origin}. Each case ran ${String(options.runs)} time(s) at temperature ${String(options.temperature)}.`,
    `Judge for checklist items: ${options.judgeModel} (cost ${money(options.judgeCost)}).`,
    '',
    '## Scores',
    '',
    `| Model | Passed | ${PARTS.map(part => PART_TITLES[part]).join(' | ')} | Input tokens | Output tokens | Time | Cost |`,
    `| --- | --- | ${PARTS.map(() => '---').join(' | ')} | --- | --- | --- | --- |`,
  ];
  for (const score of scores) {
    const parts = PARTS.map(part => `${String(score.parts[part].passed)}/${String(score.parts[part].total)}`);
    lines.push(
      `| ${cell(score.model)} | ${String(score.passed)}/${String(score.total)} (${percent(score.passed, score.total)}) | ${parts.join(' | ')} | ${score.input_tokens.toLocaleString('en-US')} | ${score.output_tokens.toLocaleString('en-US')} | ${String(Math.round(score.wall_time_ms / 60000))} min | ${money(score.cost_usd)} |`,
    );
  }

  const caseIds = [...new Set(options.rows.map(row => row.case_id))];
  lines.push('', '## Each case', '', `| Case | ${options.models.map(cell).join(' | ')} |`);
  lines.push(`| --- | ${options.models.map(() => '---').join(' | ')} |`);
  for (const id of caseIds) {
    const marks = options.models.map(model => {
      const mine = options.rows.filter(row => row.model === model && row.case_id === id);
      return `${String(mine.filter(row => row.pass).length)}/${String(mine.length)}`;
    });
    lines.push(`| ${cell(id)} | ${marks.join(' | ')} |`);
  }

  const failures = options.rows.filter(row => !row.pass);
  lines.push('', '## Why cases failed', '');
  if (failures.length === 0) {
    lines.push('Every case passed.');
  }
  for (const row of failures) {
    lines.push(
      `- **${cell(row.model)}**, ${cell(row.case_id)} (run ${String(row.run)}): ${cell(failureReasons(row).join('; '))}`,
    );
  }
  if (options.cleanupProblems.length > 0) {
    lines.push(
      '',
      `Some memories from this run could not be removed: ${options.cleanupProblems.join(', ')}. Delete them in the eval instance under Memory.`,
    );
  }

  const json = {
    label: options.label,
    generated_at: options.generatedAt,
    judge_model: options.judgeModel,
    runs: options.runs,
    set_versions: options.setVersions,
    scores,
  };
  return { markdown: `${lines.join('\n')}\n`, json };
}

/** The history keeps one entry per run, newest last. */
export const HISTORY_VERSION = 1;

export function emptyHistory() {
  return { version: HISTORY_VERSION, entries: [] };
}

/** Reads a history file's JSON. Anything that is not a history starts a new one. */
export function parseHistory(value) {
  if (
    typeof value === 'object' &&
    value !== null &&
    value.version === HISTORY_VERSION &&
    Array.isArray(value.entries)
  ) {
    return value;
  }
  return emptyHistory();
}

/**
 * Finds models whose pass rate fell by more than `maxDropPoints` percentage points since the last
 * entry that ran the same model on the same set versions. A model with no earlier entry is not compared.
 * @returns {{ model: string, before: number, now: number }[]}
 */
export function findDrops({ history, entry, maxDropPoints }) {
  const drops = [];
  for (const score of entry.scores) {
    const earlier = [...history.entries]
      .reverse()
      .map(old =>
        JSON.stringify(old.set_versions) === JSON.stringify(entry.set_versions)
          ? old.scores.find(item => item.model === score.model)
          : undefined,
      )
      .find(item => item !== undefined && item.total > 0);
    if (earlier === undefined || score.total === 0) {
      continue;
    }
    const before = (earlier.passed / earlier.total) * 100;
    const now = (score.passed / score.total) * 100;
    if (before - now > maxDropPoints) {
      drops.push({ model: score.model, before: Math.round(before), now: Math.round(now) });
    }
  }
  return drops;
}

/** A small table of each model's earlier scores, newest first, for the summary. */
export function historyMarkdown({ history, models, limit = 8 }) {
  const recent = history.entries.slice(-limit).reverse();
  if (recent.length === 0) {
    return '';
  }
  const lines = ['', '## Earlier runs', '', `| Run | ${models.map(cell).join(' | ')} |`];
  lines.push(`| --- | ${models.map(() => '---').join(' | ')} |`);
  for (const old of recent) {
    const marks = models.map(model => {
      const score = old.scores.find(item => item.model === model);
      return score === undefined
        ? '-'
        : `${String(score.passed)}/${String(score.total)} (${percent(score.passed, score.total)})`;
    });
    lines.push(`| ${cell(old.generated_at.slice(0, 10))} ${cell(old.label)} | ${marks.join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}
