// One row per reply. Lists and objects go in one cell as compact JSON; missing values stay empty.

/** Column order is the contract for the grading sheet. `pass` stays empty for the grader. */
export const REPLY_CSV_COLUMNS = Object.freeze([
  'run',
  'prompt_id',
  'group',
  'label',
  'model',
  'status',
  'error',
  'approvals',
  'steps',
  'sub_agent_steps',
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'reasoning_tokens',
  'last_call_input_tokens',
  'tool_calls_by_tool',
  'results_by_kind',
  'guard_fired',
  'claim_mismatch',
  'wall_time_ms',
  'time_to_first_token_ms',
  'reply',
  'checklist',
  'pass',
]);

/** @param {unknown} value */
export function csvCell(value) {
  if (value === undefined || value === null) {
    return '';
  }
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    text = String(value);
  } else {
    text = JSON.stringify(value);
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {readonly string[]} columns
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 */
export function toCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(columns.map(column => csvCell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}
