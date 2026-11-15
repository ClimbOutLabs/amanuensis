/**
 * The list of every tool Aman can call, and what each one may do without the person. A tool that acts
 * outside Aman never runs on its own: it asks on a card or is refused. A tool that reads the person's
 * accounts or the web leaves a line in the activity log. A tool that is not on the list fails this test,
 * so a new tool cannot ship before someone decides which kind it is.
 */
import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { DEFERRED_TOOLS_SERVER_ID } from '@truefoundry/trueforge-core/core/runtime/DeferredTool';
import { TOOL_BUNDLES_SERVER_ID } from '@truefoundry/trueforge-core/core/runtime/ToolBundles';
import { judge, toolTable, type Judged, type ToolRow } from './toolJudgingKit';

/**
 * `acts`: sends, saves or changes something outside Aman, or runs code that can.
 * `reads`: reads the person's accounts or the web and changes nothing.
 * `inside`: works only on what Aman itself keeps.
 */
type Kind = 'acts' | 'reads' | 'inside';

const TOOL_KINDS: Record<string, Kind> = {
  'gmail/draft_email': 'acts',
  'gmail/send_draft': 'acts',
  'gmail/update_draft': 'acts',
  'gmail/get_draft': 'reads',
  'gmail/get_thread': 'reads',
  'gmail/list_drafts': 'reads',
  'gmail/list_inbox_threads': 'reads',
  'gmail/read_email': 'reads',
  'google_calendar/create_event': 'acts',
  'google_calendar/update_event': 'acts',
  'google_calendar/get_event': 'reads',
  'google_calendar/list_events': 'reads',
  'Email/send_email': 'acts',
  'Email/forward_email': 'acts',
  'Email/save_draft': 'acts',
  'Email/archive_emails': 'acts',
  'Email/get_attachment_content': 'reads',
  'Email/get_emails_content': 'reads',
  'Email/list_emails_metadata': 'reads',
  'Email/list_mailboxes': 'reads',
  'Calendar/create_event': 'acts',
  'Calendar/update_event': 'acts',
  'Calendar/delete_event': 'acts',
  'Calendar/respond_to_event': 'acts',
  'Calendar/get_event': 'reads',
  'Calendar/list_calendars': 'reads',
  'Calendar/list_events': 'reads',
  'Calendar/search_events': 'reads',
  'maps/render_map': 'acts',
  'maps/render_places': 'acts',
  'maps/render_route': 'acts',
  'sandbox/exec': 'acts',
  'sandbox/run_code': 'acts',
  'web-search/tavily_search': 'reads',
  'web-search/tavily_extract': 'reads',
  'sandbox/apply_patch': 'inside',
  'sandbox/replace_text': 'inside',
  'sandbox/write_file': 'inside',
  'documents/create_document_report': 'inside',
  'documents/extract_document_text': 'inside',
  'documents/summarize_net_worth': 'inside',
  'schedules/cancel_reminder': 'inside',
  'schedules/create_schedule': 'inside',
  'schedules/delete_schedule': 'inside',
  'schedules/list_reminders': 'inside',
  'schedules/list_schedules': 'inside',
  'schedules/pause_schedule': 'inside',
  'schedules/resume_schedule': 'inside',
  'schedules/set_reminder': 'inside',
  'space/create_space': 'inside',
  'space/edit_space': 'inside',
  'space/get_space': 'inside',
  'space/list_blocks': 'inside',
  'space/list_spaces': 'inside',
  'space/move_space': 'inside',
  'space/revert_space': 'inside',
  'sub_agents/create_sub_agent': 'inside',
  'usage/usage_summary': 'inside',
  'ask-user-question/ask_user_question': 'inside',
  'connection_offer/connection_offer_status': 'inside',
  'connection_offer/record_connection_offer_decline': 'inside',
  'current-datetime/get_current_datetime': 'inside',
  'openui/get_openui_instructions': 'inside',
};

function keyOf(row: ToolRow): string {
  return row.key;
}

describe('every tool Aman can call', () => {
  let table: ToolRow[] = [];
  const judged = new Map<string, Judged>();

  beforeAll(async () => {
    // No test may reach a real service: every outbound request fails at once.
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in tests.'));
    table = (await toolTable()).filter(
      row => row.server !== DEFERRED_TOOLS_SERVER_ID && row.server !== TOOL_BUNDLES_SERVER_ID,
    );
    for (const row of table) {
      judged.set(keyOf(row), (await judge({ mode: 'online', row, loading: 'direct' })).judged);
    }
  }, 900_000);

  afterAll(() => {
    jest.restoreAllMocks();
  });

  function ofKind(kind: Kind): { tool: string; judged: Judged }[] {
    return [...judged].flatMap(([tool, entry]) => (TOOL_KINDS[tool] === kind ? [{ tool, judged: entry }] : []));
  }

  it('is on the list with its kind, and the list names no tool that is gone', () => {
    const offered = table.map(keyOf).sort();
    // A new tool: add it to TOOL_KINDS as acts, reads or inside. A removed tool: take its line out.
    expect(offered).toEqual(Object.keys(TOOL_KINDS).sort());
  });

  it('never runs on its own when it acts outside Aman: it asks on a card or is refused', () => {
    const acting = ofKind('acts');
    const ranAlone = acting.filter(
      ({ judged: entry }) =>
        entry.decision.is_approval_required !== true && entry.decision.pre_dispatch_failure === undefined,
    );
    expect(ranAlone.map(entry => entry.tool)).toEqual([]);
    // The table holds both ways of stopping, so the check above is not passing by refusing everything.
    expect(acting.some(({ judged: entry }) => entry.decision.tier3_card != null)).toBe(true);
    expect(acting.some(({ judged: entry }) => entry.decision.pre_dispatch_failure !== undefined)).toBe(true);
  });

  it('leaves a line in the activity log when a tool that acts outside Aman is refused', () => {
    const refusedUnlogged = ofKind('acts').filter(
      ({ judged: entry }) =>
        entry.decision.pre_dispatch_failure !== undefined && !entry.audit.some(row => row.outcome === 'auto_denied'),
    );
    expect(refusedUnlogged.map(entry => entry.tool)).toEqual([]);
  });

  it("leaves a line in the activity log when it reads the person's accounts or the web", () => {
    const reading = ofKind('reads');
    expect(reading.length).toBeGreaterThan(0);
    expect(reading.filter(({ judged: entry }) => entry.audit.length === 0).map(entry => entry.tool)).toEqual([]);
  });

  it('asks for every changing or unlabelled tool of a connector the person adds, unless they choose otherwise', () => {
    const spec = AgentSpecSchema.parse({
      model: { name: 'scripted/chat-model' },
      instructions: 'Answer the user.',
      mcp_servers: [{ name: 'notes' }],
    });
    expect(spec.mcp_servers?.[0]?.require_approval_for_tools).toEqual(['@write', '@destructive', '@unclassified']);
  });
});
