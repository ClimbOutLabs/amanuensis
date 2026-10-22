import type { PromptReport } from '@truefoundry/trueforge-core/core';
import {
  measurePersonalInstance,
  PERSONAL_INSTANCE_NAMES,
  PROMPT_REPORT_TURN_NAMES,
  type PersonalInstanceName,
  type PromptReportTurn,
} from '../../../../src/runtime/promptReport/personalInstance';

type Baseline = { total: number; rows: Record<string, number> };

/**
 * Measured 2026-10-22. A self-hosted model gets every built-in tool and every bundle's guidance up front, with no
 * bundle index and no load_bundle, so each turn sends the same prompt. It is far larger than a bundled setup on
 * purpose: on a self-hosted server a long prompt costs a few seconds of prefill, mostly served from its prefix
 * cache, while each extra model call to load a bundle costs a full reasoning pass.
 */
const SELF_HOSTED: Baseline = {
  total: 11094,
  rows: {
    'agent-identity': 97,
    'model-identity': 79,
    'agent-capabilities': 3110,
    'agent-capabilities/internal-messages': 59,
    'agent-capabilities/untrusted-tool-output': 104,
    'agent-capabilities/source-discovery': 383,
    'agent-capabilities/ability-boundaries': 91,
    'agent-capabilities/web-images': 80,
    'agent-capabilities/no-task-no-tools': 75,
    'agent-capabilities/check-before-asking': 69,
    'agent-capabilities/plain-speech': 114,
    'agent-capabilities/sandbox': 246,
    'agent-capabilities/sandbox/sandbox-schema-infer': 105,
    'agent-capabilities/sandbox/sandbox-file-uploads': 52,
    'agent-capabilities/documents': 267,
    'agent-capabilities/sub-agents': 263,
    'agent-capabilities/openui': 159,
    'agent-capabilities/active-speaker-context': 91,
    'agent-capabilities/spaces': 1035,
    'agent-capabilities/schedules': 57,
    ask_user_question: 261,
    get_current_datetime: 100,
    call_tool: 223,
    get_tool_info: 149,
    get_tool_output_schema: 183,
    list_tools: 108,
    create_document_report: 305,
    extract_document_text: 242,
    summarize_net_worth: 432,
    render_map: 227,
    render_places: 396,
    render_route: 298,
    get_openui_instructions: 101,
    apply_patch: 297,
    exec: 448,
    replace_text: 362,
    run_code: 541,
    write_file: 261,
    create_schedule: 314,
    delete_schedule: 91,
    list_schedules: 75,
    pause_schedule: 94,
    resume_schedule: 97,
    create_space: 292,
    get_space: 201,
    list_blocks: 127,
    list_spaces: 98,
    revert_space: 192,
    update_space: 482,
    create_sub_agent: 272,
    usage_summary: 275,
    tavily_extract: 130,
    tavily_search: 134,
  },
};

/** Measured 2026-10-22 (built-in tools sent in bundles, after the tool description trim); the memory provider's tools are not captured yet, so they are not counted. */
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
      total: 2205,
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
        create_schedule: 314,
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
      total: 3263,
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
        list_events: 441,
        create_schedule: 314,
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
  'personal-no-sandbox': {
    'core-only': {
      total: 1548,
      rows: {
        'agent-identity': 97,
        'current-date': 36,
        'model-identity': 79,
        'agent-capabilities': 879,
        'agent-capabilities/internal-messages': 59,
        'agent-capabilities/untrusted-tool-output': 104,
        'agent-capabilities/ability-boundaries': 91,
        'agent-capabilities/no-task-no-tools': 75,
        'agent-capabilities/check-before-asking': 69,
        'agent-capabilities/plain-speech': 114,
        'agent-capabilities/sandbox-off': 101,
        'agent-capabilities/tool-bundles': 161,
        'agent-capabilities/active-speaker-context': 91,
        ask_user_question: 261,
        load_bundle: 96,
        get_current_datetime: 100,
      },
    },
    calendar: {
      total: 2279,
      rows: {
        'agent-identity': 97,
        'current-date': 36,
        'model-identity': 79,
        'agent-capabilities': 939,
        'agent-capabilities/internal-messages': 59,
        'agent-capabilities/untrusted-tool-output': 104,
        'agent-capabilities/ability-boundaries': 91,
        'agent-capabilities/no-task-no-tools': 75,
        'agent-capabilities/check-before-asking': 69,
        'agent-capabilities/plain-speech': 114,
        'agent-capabilities/sandbox-off': 101,
        'agent-capabilities/tool-bundles': 163,
        'agent-capabilities/active-speaker-context': 91,
        'agent-capabilities/schedules': 57,
        ask_user_question: 261,
        load_bundle: 96,
        get_current_datetime: 100,
        create_schedule: 314,
        delete_schedule: 91,
        list_schedules: 75,
        pause_schedule: 94,
        resume_schedule: 97,
      },
    },
    web: {
      total: 2220,
      rows: {
        'agent-identity': 97,
        'current-date': 36,
        'model-identity': 79,
        'agent-capabilities': 1287,
        'agent-capabilities/internal-messages': 59,
        'agent-capabilities/untrusted-tool-output': 104,
        'agent-capabilities/source-discovery': 325,
        'agent-capabilities/ability-boundaries': 91,
        'agent-capabilities/web-images': 80,
        'agent-capabilities/no-task-no-tools': 75,
        'agent-capabilities/check-before-asking': 69,
        'agent-capabilities/plain-speech': 114,
        'agent-capabilities/sandbox-off': 101,
        'agent-capabilities/tool-bundles': 163,
        'agent-capabilities/active-speaker-context': 91,
        ask_user_question: 261,
        load_bundle: 96,
        get_current_datetime: 100,
        tavily_extract: 130,
        tavily_search: 134,
      },
    },
  },
  'personal-no-server-sandbox': {
    'core-only': {
      total: 1596,
      rows: {
        'agent-identity': 97,
        'current-date': 36,
        'model-identity': 79,
        'agent-capabilities': 927,
        'agent-capabilities/internal-messages': 59,
        'agent-capabilities/untrusted-tool-output': 104,
        'agent-capabilities/ability-boundaries': 91,
        'agent-capabilities/no-task-no-tools': 75,
        'agent-capabilities/check-before-asking': 69,
        'agent-capabilities/plain-speech': 114,
        'agent-capabilities/no-sandbox': 149,
        'agent-capabilities/tool-bundles': 161,
        'agent-capabilities/active-speaker-context': 91,
        ask_user_question: 261,
        load_bundle: 96,
        get_current_datetime: 100,
      },
    },
    calendar: {
      total: 2327,
      rows: {
        'agent-identity': 97,
        'current-date': 36,
        'model-identity': 79,
        'agent-capabilities': 987,
        'agent-capabilities/internal-messages': 59,
        'agent-capabilities/untrusted-tool-output': 104,
        'agent-capabilities/ability-boundaries': 91,
        'agent-capabilities/no-task-no-tools': 75,
        'agent-capabilities/check-before-asking': 69,
        'agent-capabilities/plain-speech': 114,
        'agent-capabilities/no-sandbox': 149,
        'agent-capabilities/tool-bundles': 163,
        'agent-capabilities/active-speaker-context': 91,
        'agent-capabilities/schedules': 57,
        ask_user_question: 261,
        load_bundle: 96,
        get_current_datetime: 100,
        create_schedule: 314,
        delete_schedule: 91,
        list_schedules: 75,
        pause_schedule: 94,
        resume_schedule: 97,
      },
    },
    web: {
      total: 2268,
      rows: {
        'agent-identity': 97,
        'current-date': 36,
        'model-identity': 79,
        'agent-capabilities': 1335,
        'agent-capabilities/internal-messages': 59,
        'agent-capabilities/untrusted-tool-output': 104,
        'agent-capabilities/source-discovery': 325,
        'agent-capabilities/ability-boundaries': 91,
        'agent-capabilities/web-images': 80,
        'agent-capabilities/no-task-no-tools': 75,
        'agent-capabilities/check-before-asking': 69,
        'agent-capabilities/plain-speech': 114,
        'agent-capabilities/no-sandbox': 149,
        'agent-capabilities/tool-bundles': 163,
        'agent-capabilities/active-speaker-context': 91,
        ask_user_question: 261,
        load_bundle: 96,
        get_current_datetime: 100,
        tavily_extract: 130,
        tavily_search: 134,
      },
    },
  },
  'personal-self-hosted': { 'core-only': SELF_HOSTED, calendar: SELF_HOSTED, web: SELF_HOSTED },
};

/** Most tokens the bundle index section may take in any setup. */
const BUNDLE_INDEX_BUDGET = 300;

/** Fail when a setup grows past the baseline by more than this share. */
const HEADROOM = 0.05;

const BUNDLED_NAMES = PERSONAL_INSTANCE_NAMES.filter(name => name !== 'personal-self-hosted');

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

  it.each(BUNDLED_NAMES)('keeps the bundle index of %s within its budget', async name => {
    const report = await measurePersonalInstance({ name, turn: 'core-only' });
    const index = report.sections.find(row => row.name === 'agent-capabilities/tool-bundles');
    expect(index?.tokens).toBeGreaterThan(0);
    expect(index?.tokens).toBeLessThanOrEqual(BUNDLE_INDEX_BUDGET);
  });
});

describe('a self-hosted model', () => {
  it('gets every built-in tool on every turn, with no bundle index and no load_bundle', async () => {
    const bundled = await Promise.all(
      PROMPT_REPORT_TURN_NAMES.map(turn => measurePersonalInstance({ name: 'personal', turn })),
    );
    const reports = await Promise.all(
      PROMPT_REPORT_TURN_NAMES.map(turn => measurePersonalInstance({ name: 'personal-self-hosted', turn })),
    );
    const bundledTools = new Set(bundled.flatMap(report => report.tools.map(row => row.name)));
    bundledTools.delete('load_bundle');
    for (const report of reports) {
      const tools = report.tools.map(row => row.name);
      expect(tools).not.toContain('load_bundle');
      expect(report.sections.map(row => row.name)).not.toContain('agent-capabilities/tool-bundles');
      expect(tools).toEqual(expect.arrayContaining([...bundledTools]));
      expect(report).toEqual(reports[0]);
    }
  });
});

/** Each sandbox-backed section and the tools it describes; with the sandbox off, neither may be sent. */
const SANDBOX_SECTIONS: Record<string, string[]> = {
  'agent-capabilities/sandbox': ['exec', 'run_code', 'apply_patch', 'replace_text', 'write_file'],
  'agent-capabilities/sandbox/repository-work': ['exec', 'apply_patch', 'replace_text', 'write_file'],
  'agent-capabilities/sandbox/sandbox-schema-infer': ['exec'],
  'agent-capabilities/sandbox/sandbox-file-uploads': ['exec'],
  'agent-capabilities/documents': ['create_document_report', 'extract_document_text', 'summarize_net_worth'],
};

describe('system prompt sections follow the tools a chat has', () => {
  it('sends the sandbox-off line, and no sandbox tools, when the sandbox is off for the chat', async () => {
    const on = await measurePersonalInstance({ name: 'personal', turn: 'core-only' });
    const off = await measurePersonalInstance({ name: 'personal-no-sandbox', turn: 'core-only' });
    const onSections = new Set(on.sections.map(row => row.name));
    const offSections = new Set(off.sections.map(row => row.name));
    const offTools = new Set(off.tools.map(row => row.name));

    expect(offSections.has('agent-capabilities/sandbox-off')).toBe(true);
    expect(offSections.has('agent-capabilities/no-sandbox')).toBe(false);
    expect(onSections.has('agent-capabilities/sandbox-off')).toBe(false);
    for (const [section, tools] of Object.entries(SANDBOX_SECTIONS)) {
      expect(offSections.has(section)).toBe(false);
      expect(tools.some(tool => offTools.has(tool))).toBe(false);
    }
  });

  it('sends the no-sandbox line, and no sandbox tools, when the server has no sandbox', async () => {
    const report = await measurePersonalInstance({ name: 'personal-no-server-sandbox', turn: 'core-only' });
    const sections = new Set(report.sections.map(row => row.name));
    const tools = new Set(report.tools.map(row => row.name));

    expect(sections.has('agent-capabilities/no-sandbox')).toBe(true);
    expect(sections.has('agent-capabilities/sandbox-off')).toBe(false);
    for (const [section, sectionTools] of Object.entries(SANDBOX_SECTIONS)) {
      expect(sections.has(section)).toBe(false);
      expect(sectionTools.some(tool => tools.has(tool))).toBe(false);
    }
  });
});
