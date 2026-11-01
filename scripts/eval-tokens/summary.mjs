// Markdown for a human grader: each prompt's checklist and every run's reply, with a blank Pass line.

/** Wraps text in a fence longer than any backtick run inside it, so the reply cannot close the block. */
export function fenced(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * @param {{
 *   label: string,
 *   model: string,
 *   temperature: number,
 *   runs: number,
 *   origin: string,
 *   generatedAt: string,
 *   prompts: ReadonlyArray<{ id: string, group: string, prompt: string, checklist: readonly string[] }>,
 *   rows: ReadonlyArray<Record<string, unknown>>,
 * }} options
 */
export function buildSummary({ label, model, temperature, runs, origin, generatedAt, prompts, rows }) {
  const lines = [
    `# Token eval: ${label}`,
    '',
    `- Model: \`${model}\``,
    `- Temperature: ${String(temperature)}`,
    `- Runs per prompt: ${String(runs)}`,
    `- Instance: ${origin}`,
    `- Generated: ${generatedAt}`,
    `- Replies: ${String(rows.length)}`,
    '',
    'Grading: read each reply against its checklist, then write yes or no on its Pass line.',
    '',
  ];
  for (const prompt of prompts) {
    lines.push(`## ${prompt.id} (${prompt.group})`, '', fenced(prompt.prompt), '', 'Checklist:');
    for (const item of prompt.checklist) {
      lines.push(`- ${item}`);
    }
    lines.push('');
    const promptRows = rows.filter(row => row.prompt_id === prompt.id);
    for (const row of promptRows) {
      lines.push(
        `### Run ${String(row.run)}`,
        '',
        `Status: ${String(row.status)}. Approvals answered: ${String(row.approvals)}.`,
        '',
        fenced(typeof row.reply === 'string' ? row.reply : ''),
        '',
        '**Pass:**',
        '',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
