import type { PromptReport } from '@truefoundry/trueforge-core/core';
import {
  measurePersonalInstance,
  PERSONAL_INSTANCE_NAMES,
  type PersonalInstanceName,
} from '../../../../src/runtime/promptReport/personalInstance';

/** Measured 2026-10-22 (every tool but two listed by name only in the tool index); the memory provider's tools are not captured yet, so they are not counted. */
const BASELINE: Record<PersonalInstanceName, { total: number; rows: Record<string, number> }> = {
  personal: {
    total: 5803,
    rows: {
      'agent-identity': 97,
      'current-date': 36,
      'model-identity': 79,
      'agent-capabilities': 4562,
      'agent-capabilities/internal-messages': 59,
      'agent-capabilities/untrusted-tool-output': 104,
      'agent-capabilities/source-discovery': 383,
      'agent-capabilities/ability-boundaries': 91,
      'agent-capabilities/web-images': 80,
      'agent-capabilities/no-task-no-tools': 75,
      'agent-capabilities/check-before-asking': 69,
      'agent-capabilities/plain-speech': 114,
      'agent-capabilities/sandbox': 984,
      'agent-capabilities/sandbox/repository-work': 738,
      'agent-capabilities/sandbox/sandbox-schema-infer': 105,
      'agent-capabilities/sandbox/sandbox-file-uploads': 52,
      'agent-capabilities/deferred-tools-instructions': 714,
      'agent-capabilities/documents': 267,
      'agent-capabilities/sub-agents': 263,
      'agent-capabilities/openui': 159,
      'agent-capabilities/active-speaker-context': 91,
      'agent-capabilities/spaces': 1035,
      'agent-capabilities/schedules': 57,
      ask_user_question: 261,
      get_current_datetime: 100,
      call_tool: 221,
      get_tool_info: 156,
      get_tool_output_schema: 183,
      list_tools: 108,
    },
  },
  'personal-with-google': {
    total: 5951,
    rows: {
      'agent-identity': 97,
      'current-date': 36,
      'model-identity': 79,
      'agent-capabilities': 4710,
      'agent-capabilities/internal-messages': 59,
      'agent-capabilities/untrusted-tool-output': 104,
      'agent-capabilities/source-discovery': 383,
      'agent-capabilities/ability-boundaries': 91,
      'agent-capabilities/web-images': 80,
      'agent-capabilities/no-task-no-tools': 75,
      'agent-capabilities/check-before-asking': 69,
      'agent-capabilities/plain-speech': 114,
      'agent-capabilities/sandbox': 984,
      'agent-capabilities/sandbox/repository-work': 738,
      'agent-capabilities/sandbox/sandbox-schema-infer': 105,
      'agent-capabilities/sandbox/sandbox-file-uploads': 52,
      'agent-capabilities/deferred-tools-instructions': 862,
      'agent-capabilities/documents': 267,
      'agent-capabilities/sub-agents': 263,
      'agent-capabilities/openui': 159,
      'agent-capabilities/active-speaker-context': 91,
      'agent-capabilities/spaces': 1035,
      'agent-capabilities/schedules': 57,
      ask_user_question: 261,
      get_current_datetime: 100,
      call_tool: 221,
      get_tool_info: 156,
      get_tool_output_schema: 183,
      list_tools: 108,
    },
  },
};

/** Most tokens the tool index section (guide, one line per tool, connectors not listed) may take in any setup. */
const TOOL_INDEX_BUDGET = 1000;

/** Fail when a setup grows past the baseline by more than this share. */
const HEADROOM = 0.05;

function rowsOf(report: PromptReport): Record<string, number> {
  return Object.fromEntries([...report.sections, ...report.tools].map(row => [row.name, row.tokens]));
}

/** Names of rows that are new or larger than in the baseline, with the change in tokens. */
function growth(name: PersonalInstanceName, report: PromptReport): string[] {
  const before = BASELINE[name].rows;
  return Object.entries(rowsOf(report))
    .filter(([row, tokens]) => tokens > (before[row] ?? 0))
    .map(([row, tokens]) => `${row} (${before[row] === undefined ? 'new' : `+${tokens - before[row]}`})`);
}

describe('personal instance prompt budget', () => {
  it.each(PERSONAL_INSTANCE_NAMES)('keeps %s within the budget', async name => {
    const report = await measurePersonalInstance({ name });
    const baseline = BASELINE[name].total;
    const budget = Math.ceil(baseline * (1 + HEADROOM));
    if (report.totalTokens > budget) {
      const changed = growth(name, report).join(', ') || 'none found; a row was removed or the total changed';
      throw new Error(
        `The ${name} setup now sends ${report.totalTokens} tokens per turn, over its budget of ${budget} ` +
          `(baseline ${baseline} plus 5%). Rows that grew: ${changed}. ` +
          'Next: shorten the instruction text or tool description that grew, or remove the tool. ' +
          'If the growth is intended, update BASELINE in this file in the same change and say why in the pull request.',
      );
    }
    expect(report.totalTokens).toBeLessThanOrEqual(budget);
  });

  it.each(PERSONAL_INSTANCE_NAMES)('keeps the tool index of %s within its budget', async name => {
    const report = await measurePersonalInstance({ name });
    const index = report.sections.find(row => row.name === 'agent-capabilities/deferred-tools-instructions');
    expect(index?.tokens).toBeGreaterThan(0);
    expect(index?.tokens).toBeLessThanOrEqual(TOOL_INDEX_BUDGET);
  });
});
