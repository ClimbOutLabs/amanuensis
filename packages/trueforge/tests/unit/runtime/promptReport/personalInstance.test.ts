import type { PromptReport } from '@truefoundry/trueforge-core/core';
import {
  measurePersonalInstance,
  PERSONAL_INSTANCE_NAMES,
  type PersonalInstanceName,
} from '../../../../src/runtime/promptReport/personalInstance';

/** Measured 2026-10-21; the memory provider's tools are not captured yet, so they are not counted. */
const BASELINE: Record<PersonalInstanceName, { total: number; rows: Record<string, number> }> = {
  personal: {
    total: 12287,
    rows: {
      'agent-identity': 38,
      'current-date': 36,
      'model-identity': 79,
      'agent-capabilities': 4193,
      'agent-capabilities/internal-messages': 59,
      'agent-capabilities/untrusted-tool-output': 104,
      'agent-capabilities/source-discovery': 383,
      'agent-capabilities/ability-boundaries': 91,
      'agent-capabilities/no-task-no-tools': 75,
      'agent-capabilities/plain-speech': 114,
      'agent-capabilities/sandbox': 984,
      'agent-capabilities/sandbox/repository-work': 738,
      'agent-capabilities/sandbox/sandbox-schema-infer': 105,
      'agent-capabilities/sandbox/sandbox-file-uploads': 52,
      'agent-capabilities/deferred-tools-instructions': 73,
      'agent-capabilities/documents': 267,
      'agent-capabilities/sub-agents': 263,
      'agent-capabilities/openui': 159,
      'agent-capabilities/active-speaker-context': 91,
      'agent-capabilities/spaces': 1456,
      'agent-capabilities/schedules': 57,
      ask_user_question: 261,
      get_current_datetime: 100,
      call_tool: 208,
      get_tool_info: 153,
      get_tool_output_schema: 183,
      list_tools: 108,
      create_document_report: 362,
      extract_document_text: 242,
      summarize_net_worth: 445,
      render_map: 227,
      render_places: 412,
      render_route: 366,
      get_openui_instructions: 101,
      apply_patch: 337,
      exec: 571,
      replace_text: 443,
      run_code: 520,
      write_file: 307,
      create_schedule: 282,
      delete_schedule: 91,
      list_schedules: 75,
      pause_schedule: 94,
      resume_schedule: 97,
      create_space: 281,
      get_space: 191,
      list_blocks: 127,
      list_spaces: 98,
      revert_space: 192,
      update_space: 531,
      create_sub_agent: 272,
      tavily_extract: 130,
      tavily_search: 134,
    },
  },
  'personal-with-google': {
    total: 13352,
    rows: {
      'agent-identity': 38,
      'current-date': 36,
      'model-identity': 79,
      'agent-capabilities': 4193,
      'agent-capabilities/internal-messages': 59,
      'agent-capabilities/untrusted-tool-output': 104,
      'agent-capabilities/source-discovery': 383,
      'agent-capabilities/ability-boundaries': 91,
      'agent-capabilities/no-task-no-tools': 75,
      'agent-capabilities/plain-speech': 114,
      'agent-capabilities/sandbox': 984,
      'agent-capabilities/sandbox/repository-work': 738,
      'agent-capabilities/sandbox/sandbox-schema-infer': 105,
      'agent-capabilities/sandbox/sandbox-file-uploads': 52,
      'agent-capabilities/deferred-tools-instructions': 73,
      'agent-capabilities/documents': 267,
      'agent-capabilities/sub-agents': 263,
      'agent-capabilities/openui': 159,
      'agent-capabilities/active-speaker-context': 91,
      'agent-capabilities/spaces': 1456,
      'agent-capabilities/schedules': 57,
      ask_user_question: 261,
      get_current_datetime: 100,
      call_tool: 208,
      get_tool_info: 153,
      get_tool_output_schema: 183,
      list_tools: 108,
      create_document_report: 362,
      extract_document_text: 242,
      summarize_net_worth: 445,
      get_draft: 75,
      get_thread: 119,
      list_drafts: 93,
      list_inbox_threads: 141,
      read_email: 81,
      get_event: 88,
      list_events: 468,
      render_map: 227,
      render_places: 412,
      render_route: 366,
      get_openui_instructions: 101,
      apply_patch: 337,
      exec: 571,
      replace_text: 443,
      run_code: 520,
      write_file: 307,
      create_schedule: 282,
      delete_schedule: 91,
      list_schedules: 75,
      pause_schedule: 94,
      resume_schedule: 97,
      create_space: 281,
      get_space: 191,
      list_blocks: 127,
      list_spaces: 98,
      revert_space: 192,
      update_space: 531,
      create_sub_agent: 272,
      tavily_extract: 130,
      tavily_search: 134,
    },
  },
};

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
});
