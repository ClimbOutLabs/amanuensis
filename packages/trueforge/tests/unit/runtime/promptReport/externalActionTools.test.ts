/**
 * The list of every tool Aman can call, and what each one may do without the person. A tool that acts
 * outside Aman never runs on its own: it asks on a card or is refused. The one exception is a short
 * list below, for an event on the person's own calendar that has no guests. A tool that reads the
 * person's accounts or the web leaves a line in the activity log. A tool that is not on the list fails this test,
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
  'Calendar/create_event1': 'acts',
  'Calendar/update_event1': 'acts',
  'Calendar/delete_event': 'acts',
  'Calendar/respond_to_event': 'acts',
  'Calendar/get_event1': 'reads',
  'Calendar/list_calendars': 'reads',
  'Calendar/list_events1': 'reads',
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
  'current-datetime/get_current_datetime': 'inside',
  'openui/get_openui_instructions': 'inside',
};

/**
 * The only tools that act outside Aman and may run without a card, each with the one reason that lets
 * it. Adding a line here is a decision for the person who owns the instance, not for a code change.
 */
const MAY_RUN_WITHOUT_A_CARD: Record<string, string> = {
  'google_calendar/create_event': 'own_calendar_write',
  'google_calendar/update_event': 'own_calendar_write',
};

const GUEST = 'nora@harbour.example';

/** Arguments for an event with nobody else on it. */
const OWN_EVENT_ARGS: Record<string, Record<string, unknown>> = {
  'google_calendar/create_event': { title: 'Dentist', start: '2026-12-02T09:00', end: '2026-12-02T10:00' },
  'google_calendar/update_event': { event_id: 'evt-1', title: 'Dentist, moved' },
};

/** The same calls for an event that has a guest. */
const GUEST_EVENT_ARGS: Record<string, Record<string, unknown>> = {
  'google_calendar/create_event': {
    ...OWN_EVENT_ARGS['google_calendar/create_event'],
    attendees: [GUEST],
    send_updates: 'none',
  },
  'google_calendar/update_event': { ...OWN_EVENT_ARGS['google_calendar/update_event'], send_updates: 'none' },
};

/** Answers the calendar's requests the way Google would, with one saved event the person organizes. */
function standInForGoogle(input: { guests: readonly string[] }): void {
  jest.spyOn(globalThis, 'fetch').mockImplementation(request => {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    if (url.includes('/token')) {
      return Promise.resolve(Response.json({ access_token: 'stand-in', expires_in: 3600, token_type: 'Bearer' }));
    }
    return Promise.resolve(
      Response.json({
        id: 'evt-1',
        status: 'confirmed',
        summary: 'Dentist',
        timeZone: 'Europe/Lisbon',
        organizer: { self: true },
        start: { dateTime: '2026-12-02T09:00:00Z' },
        end: { dateTime: '2026-12-02T10:00:00Z' },
        attendees: input.guests.map(email => ({ email })),
        items: [],
      }),
    );
  });
}

function ranWithoutACard(entry: Judged): boolean {
  return entry.decision.is_approval_required !== true && entry.decision.pre_dispatch_failure === undefined;
}

function keyOf(row: ToolRow): string {
  return `${row.server}/${row.name}`;
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
    const ranAlone = acting.filter(({ judged: entry }) => ranWithoutACard(entry));
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

describe("an event on the person's own calendar", () => {
  let table: ToolRow[] = [];
  let withNoGuests = new Map<string, Judged>();

  async function judgeAll(args: Record<string, Record<string, unknown>>): Promise<Map<string, Judged>> {
    const judged = new Map<string, Judged>();
    for (const row of table) {
      const key = keyOf(row);
      const outcome = await judge({ mode: 'online', row: { ...row, args: args[key] ?? row.args }, loading: 'direct' });
      judged.set(key, outcome.judged);
    }
    return judged;
  }

  beforeAll(async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in tests.'));
    table = (await toolTable()).filter(row => TOOL_KINDS[keyOf(row)] === 'acts');
    // Judged once: adding the same event a second time in one chat asks, which is a different rule.
    standInForGoogle({ guests: [] });
    withNoGuests = await judgeAll(OWN_EVENT_ARGS);
  }, 900_000);

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('is added or changed without a card when nobody else is on it, and no other tool that acts runs that way', () => {
    const ranAlone = [...withNoGuests].filter(([, entry]) => ranWithoutACard(entry));
    expect(Object.fromEntries(ranAlone.map(([tool, entry]) => [tool, entry.decision.tier_reason]))).toEqual(
      MAY_RUN_WITHOUT_A_CARD,
    );
  });

  it('leaves a line in the activity log when it is added or changed without a card', () => {
    for (const tool of Object.keys(MAY_RUN_WITHOUT_A_CARD)) {
      const log = withNoGuests.get(tool)?.audit ?? [];
      expect({ tool, log: log.map(row => row.outcome) }).toEqual({ tool, log: ['ran'] });
      expect(log[0]?.description).toContain('without asking, because nobody else is on the event');
    }
  });

  it('asks on a card first when the event has a guest', async () => {
    standInForGoogle({ guests: [GUEST] });
    const judged = await judgeAll(GUEST_EVENT_ARGS);
    expect([...judged].filter(([, entry]) => ranWithoutACard(entry)).map(([tool]) => tool)).toEqual([]);
    for (const tool of Object.keys(MAY_RUN_WITHOUT_A_CARD)) {
      expect({ tool, asks: judged.get(tool)?.decision.is_approval_required }).toEqual({ tool, asks: true });
      expect(judged.get(tool)?.decision.tier3_card).not.toBeNull();
    }
  }, 900_000);
});
