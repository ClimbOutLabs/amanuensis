import type { PromptReport } from '@truefoundry/trueforge-core/core';
import {
  measurePersonalInstance,
  PERSONAL_INSTANCE_NAMES,
  PROMPT_REPORT_TURN_NAMES,
  type PersonalInstanceName,
  type PromptReportTurn,
} from '../../../../src/runtime/promptReport/personalInstance';

type Baseline = { total: number; rows: Record<string, number> };

/** Measured 2026-10-22 (built-in tools sent in bundles); the memory provider's tools are not captured yet, so they are not counted. */
const BASELINE: Record<PersonalInstanceName, Record<PromptReportTurn, Baseline>> = {
  personal: {
    'core-only': {
      total: 1474,
      rows: {
        'agent-identity': 97,
        'current-date': 36,
        'model-identity': 79,
        'agent-capabilities': 805,
        'agent-capabilities/internal-messages': 59,
        'agent-capabilities/untrusted-tool-output': 104,
        'agent-capabilities/ability-boundaries': 91,
        'agent-capabilities/no-task-no-tools': 75,
        'agent-capabilities/check-before-asking': 69,
        'agent-capabilities/plain-speech': 114,
        'agent-capabilities/tool-bundles': 188,
        'agent-capabilities/active-speaker-context': 91,
        ask_user_question: 261,
        load_bundle: 96,
        get_current_datetime: 100,
      },
    },
    calendar: {
      total: 2215,
      rows: {
        'agent-identity': 97,
        'current-date': 36,
        'model-identity': 79,
        'agent-capabilities': 865,
        'agent-capabilities/internal-messages': 59,
        'agent-capabilities/untrusted-tool-output': 104,
        'agent-capabilities/ability-boundaries': 91,
        'agent-capabilities/no-task-no-tools': 75,
        'agent-capabilities/check-before-asking': 69,
        'agent-capabilities/plain-speech': 114,
        'agent-capabilities/tool-bundles': 191,
        'agent-capabilities/active-speaker-context': 91,
        'agent-capabilities/schedules': 57,
        ask_user_question: 261,
        load_bundle: 96,
        get_current_datetime: 100,
        create_schedule: 324,
        delete_schedule: 91,
        list_schedules: 75,
        pause_schedule: 94,
        resume_schedule: 97,
      },
    },
    web: {
      total: 2204,
      rows: {
        'agent-identity': 97,
        'current-date': 36,
        'model-identity': 79,
        'agent-capabilities': 1271,
        'agent-capabilities/internal-messages': 59,
        'agent-capabilities/untrusted-tool-output': 104,
        'agent-capabilities/source-discovery': 383,
        'agent-capabilities/ability-boundaries': 91,
        'agent-capabilities/web-images': 80,
        'agent-capabilities/no-task-no-tools': 75,
        'agent-capabilities/check-before-asking': 69,
        'agent-capabilities/plain-speech': 114,
        'agent-capabilities/tool-bundles': 191,
        'agent-capabilities/active-speaker-context': 91,
        ask_user_question: 261,
        load_bundle: 96,
        get_current_datetime: 100,
        tavily_extract: 130,
        tavily_search: 134,
      },
    },
  },
  'personal-with-google': {
    'core-only': {
      total: 1492,
      rows: {
        'agent-identity': 97,
        'current-date': 36,
        'model-identity': 79,
        'agent-capabilities': 823,
        'agent-capabilities/internal-messages': 59,
        'agent-capabilities/untrusted-tool-output': 104,
        'agent-capabilities/ability-boundaries': 91,
        'agent-capabilities/no-task-no-tools': 75,
        'agent-capabilities/check-before-asking': 69,
        'agent-capabilities/plain-speech': 114,
        'agent-capabilities/tool-bundles': 206,
        'agent-capabilities/active-speaker-context': 91,
        ask_user_question: 261,
        load_bundle: 96,
        get_current_datetime: 100,
      },
    },
    calendar: {
      total: 3300,
      rows: {
        'agent-identity': 97,
        'current-date': 36,
        'model-identity': 79,
        'agent-capabilities': 885,
        'agent-capabilities/internal-messages': 59,
        'agent-capabilities/untrusted-tool-output': 104,
        'agent-capabilities/ability-boundaries': 91,
        'agent-capabilities/no-task-no-tools': 75,
        'agent-capabilities/check-before-asking': 69,
        'agent-capabilities/plain-speech': 114,
        'agent-capabilities/tool-bundles': 211,
        'agent-capabilities/active-speaker-context': 91,
        'agent-capabilities/schedules': 57,
        ask_user_question: 261,
        load_bundle: 96,
        get_current_datetime: 100,
        get_draft: 75,
        get_thread: 119,
        list_drafts: 93,
        list_inbox_threads: 141,
        read_email: 81,
        get_event: 88,
        list_events: 468,
        create_schedule: 324,
        delete_schedule: 91,
        list_schedules: 75,
        pause_schedule: 94,
        resume_schedule: 97,
      },
    },
    web: {
      total: 2221,
      rows: {
        'agent-identity': 97,
        'current-date': 36,
        'model-identity': 79,
        'agent-capabilities': 1288,
        'agent-capabilities/internal-messages': 59,
        'agent-capabilities/untrusted-tool-output': 104,
        'agent-capabilities/source-discovery': 383,
        'agent-capabilities/ability-boundaries': 91,
        'agent-capabilities/web-images': 80,
        'agent-capabilities/no-task-no-tools': 75,
        'agent-capabilities/check-before-asking': 69,
        'agent-capabilities/plain-speech': 114,
        'agent-capabilities/tool-bundles': 208,
        'agent-capabilities/active-speaker-context': 91,
        ask_user_question: 261,
        load_bundle: 96,
        get_current_datetime: 100,
        tavily_extract: 130,
        tavily_search: 134,
      },
    },
  },
};

/** Most tokens the bundle index section may take in any setup. */
const BUNDLE_INDEX_BUDGET = 300;

/** Fail when a setup grows past the baseline by more than this share. */
const HEADROOM = 0.05;

const CASES = PERSONAL_INSTANCE_NAMES.flatMap(name => PROMPT_REPORT_TURN_NAMES.map(turn => ({ name, turn })));

function rowsOf(report: PromptReport): Record<string, number> {
  return Object.fromEntries([...report.sections, ...report.tools].map(row => [row.name, row.tokens]));
}

/** Names of rows that are new or larger than in the baseline, with the change in tokens. */
function growth(baseline: Baseline, report: PromptReport): string[] {
  const before = baseline.rows;
  return Object.entries(rowsOf(report))
    .filter(([row, tokens]) => tokens > (before[row] ?? 0))
    .map(([row, tokens]) => `${row} (${before[row] === undefined ? 'new' : `+${tokens - before[row]}`})`);
}

describe('personal instance prompt budget', () => {
  it.each(CASES)('keeps $name on a $turn turn within the budget', async ({ name, turn }) => {
    const report = await measurePersonalInstance({ name, turn });
    const baseline = BASELINE[name][turn];
    const budget = Math.ceil(baseline.total * (1 + HEADROOM));
    if (report.totalTokens > budget) {
      const changed = growth(baseline, report).join(', ') || 'none found; a row was removed or the total changed';
      throw new Error(
        `The ${name} setup now sends ${report.totalTokens} tokens on a ${turn} turn, over its budget of ${budget} ` +
          `(baseline ${baseline.total} plus 5%). Rows that grew: ${changed}. ` +
          'Next: shorten the instruction text or tool description that grew, or move the tool into a bundle. ' +
          'If the growth is intended, update BASELINE in this file in the same change and say why in the pull request.',
      );
    }
    expect(report.totalTokens).toBeLessThanOrEqual(budget);
  });

  it.each(PERSONAL_INSTANCE_NAMES)('keeps the bundle index of %s within its budget', async name => {
    const report = await measurePersonalInstance({ name, turn: 'core-only' });
    const index = report.sections.find(row => row.name === 'agent-capabilities/tool-bundles');
    expect(index?.tokens).toBeGreaterThan(0);
    expect(index?.tokens).toBeLessThanOrEqual(BUNDLE_INDEX_BUDGET);
  });
});
