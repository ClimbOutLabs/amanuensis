// Markdown for a reader comparing runs: one table per prompt, then each run's final reply.
import { fenced } from '../eval-tokens/summary.mjs';

const TABLE_COLUMNS = Object.freeze([
  'run',
  'status',
  'create_calls',
  'edit_calls',
  'refused_or_failed_calls',
  'rows',
  'duplicate_rows',
  'table_valid',
  'pictures',
  'closing_line',
  'formatting_changed',
  'rows_lost',
  'steps',
  'input_tokens',
  'expectations_met',
]);

function cell(value) {
  return value === undefined || value === null || value === '' ? '-' : String(value).replace(/\|/g, '/');
}

/**
 * @param {{
 *   label: string, model: string, temperature: number, runs: number, keep: boolean,
 *   origin: string, generatedAt: string,
 *   prompts: ReadonlyArray<{ id: string, prompt: string, follow_up?: string, expect: Record<string, unknown> }>,
 *   rows: ReadonlyArray<Record<string, unknown>>,
 * }} options
 */
export function buildSpaceSummary({ label, model, temperature, runs, keep, origin, generatedAt, prompts, rows }) {
  const lines = [
    `# Space eval: ${label}`,
    '',
    `- Model: \`${model}\``,
    `- Temperature: ${String(temperature)}`,
    `- Runs per prompt: ${String(runs)}`,
    `- Instance: ${origin}`,
    `- Spaces kept after the run: ${keep ? 'yes' : 'no'}`,
    `- Generated: ${generatedAt}`,
    '',
  ];
  for (const prompt of prompts) {
    const promptRows = rows.filter(row => row.prompt_id === prompt.id);
    const met = promptRows.filter(row => row.expectations_met === true).length;
    lines.push(`## ${prompt.id}`, '', fenced(prompt.prompt), '');
    if (prompt.follow_up !== undefined) {
      lines.push('Follow-up:', '', fenced(prompt.follow_up), '');
    }
    lines.push(
      `Targets: ${Object.entries(prompt.expect)
        .map(([name, value]) => `${name} ${String(value)}`)
        .join(', ')}.`,
      `Runs that met every target: ${String(met)} of ${String(promptRows.length)}.`,
      '',
      `| ${TABLE_COLUMNS.join(' | ')} |`,
      `| ${TABLE_COLUMNS.map(() => '---').join(' | ')} |`,
    );
    for (const row of promptRows) {
      lines.push(`| ${TABLE_COLUMNS.map(column => cell(row[column])).join(' | ')} |`);
    }
    lines.push('');
    for (const row of promptRows) {
      lines.push(`### Run ${String(row.run)}`, '');
      if (row.failed_expectations) {
        lines.push(`Missed: ${String(row.failed_expectations)}.`, '');
      }
      if (row.error) {
        lines.push(`Note: ${String(row.error)}`, '');
      }
      lines.push(fenced(typeof row.reply === 'string' ? row.reply : ''), '');
    }
  }
  return `${lines.join('\n')}\n`;
}
