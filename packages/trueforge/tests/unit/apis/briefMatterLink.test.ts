/**
 * Regression suite for the morning brief: can Aman connect a new update to an ongoing matter?
 *
 * A person waits on delayed paperwork across four chats on four days. On day 9 a confirmation
 * email from a different organization records an escalation the person never mentioned to Aman.
 * On day 10 the ordinary scheduled brief runs in a fresh session. The deterministic gate checks
 * the evidence chain, not the wording of any brief: each chat is retained through the real retain
 * path, the reminder goes through the real reminder tool, the mailbox is a recorded Gmail stand-in,
 * and the brief runs through the production scheduled-run entry point with its ordinary task text.
 *
 * Whether a model actually connects the email to the matter is scored by the model eval case
 * `brief-matter-link`, not here: a scripted model must not earn credit for recognizing the
 * relationship. What this suite pins down is where the evidence stops traveling. On current main
 * the retained history and the reminder are stored but no tool offered to an unattended brief can
 * reach them, so the two availability tests are marked `failing`: they pass only while the gap
 * exists and turn red the day a fix lands, which is the signal to unmark them.
 *
 * All people, organizations and references in this file are invented for the fixture.
 */
import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { AgentSpecSchema, type Turn } from '@truefoundry/trueforge-core/agent-session';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { memoryBackgroundWorkSettled } from '../../../src/runtime/memory/memoryBackgroundWork';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';
import { GetTurnResponseSchema, ListTurnsResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import {
  briefMatterMailText,
  installBriefMatterMail,
  type BriefMatterMailScenario,
} from '../../fixtures/briefMatterMail';

jest.mock('node:dns/promises', () => {
  const actual = jest.requireActual<typeof import('node:dns/promises')>('node:dns/promises');
  return {
    ...actual,
    lookup: async (hostname: string, options?: { all?: boolean | undefined }) => {
      const entry = { address: hostname === 'localhost' ? '127.0.0.1' : '93.184.216.34', family: 4 };
      return options?.all === true ? [entry] : entry;
    },
  };
});

const AGENT_SPEC = AgentSpecSchema.parse({
  model: { name: MODEL_FQN },
  instructions: 'You are Aman, a personal assistant.',
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
});

const OWNER_SUBJECT = {
  subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
  subject_type: 'user' as const,
  subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
};

const DAY_1_TEXT =
  'I asked the Records Office for a certified copy of my file today. They assigned my request the reference R-1842 and said it would take a few weeks.';
const DAY_2_TEXT =
  'I also asked the Records Office for a certified copy of my property record today. They assigned that request the reference R-2077.';
const DAY_3_TEXT =
  'The certified copy still has not arrived. It is delayed. Who can I contact at the Records Office, and when would it make sense to escalate, maybe by filing a complaint with the Review Desk?';
const DAY_5_TEXT =
  'Please remind me on Sunday, November 8 at 9 in the morning to call the Records Office about the delayed certified copy. run:set_reminder';
const DAY_7_TEXT =
  'I called the Records Office this morning. They located request R-1842, but they gave me no delivery date. The certified copy is still pending.';
const REMINDER_WHAT = 'Call the Records Office about the delayed certified copy, request R-1842';
const REMINDER_AT = '2026-11-08T09:00:00.000Z';

/** A retained note claiming the complaint was filed. The day 3 discussion must never read as this. */
const FILING_CLAIM = /filed a complaint|complaint (?:was|has been) filed|submitted (?:a|the) complaint/i;

type RecordedRequest = ReturnType<ApprovalTestServer['model']['requests']>[number];

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** Fakes only the Date, so the server, the vault and the schedule store share one fixed timeline. */
function fakeClock(at: string): void {
  jest.useFakeTimers({
    now: new Date(at),
    doNotFake: [
      'nextTick',
      'setImmediate',
      'setTimeout',
      'setInterval',
      'clearTimeout',
      'clearInterval',
      'queueMicrotask',
      'performance',
      'hrtime',
      'cancelAnimationFrame',
      'requestAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
    ],
  });
}

/**
 * Answers the host's own model calls the way a faithful summary model would: the notes pass keeps
 * nothing, the relevance judge finds nothing helpful, and the turn summarizer keeps the facts the
 * person stated, in the summarizer's own note style. Keyed on the person's words in the exchange.
 */
function hostAnswer(messages: readonly { role: string; content?: unknown }[]): string | undefined {
  const text = messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
  if (text.includes('<knowledge-relevance-judge')) {
    return '{"helpful":[]}';
  }
  if (text.includes('"findings"')) {
    return '{"findings": [], "responses": []}';
  }
  if (text.includes('You pick out what is worth remembering')) {
    if (text.includes('gave me no delivery date')) {
      return JSON.stringify({
        facts: [
          'Called the Records Office about the delayed certified copy.',
          'The Records Office located request R-1842 but gave no delivery date for the certified copy.',
          'The certified copy is still pending.',
        ],
      });
    }
    if (text.includes('still has not arrived')) {
      return JSON.stringify({
        facts: [
          'The certified copy from the Records Office, request R-1842, has not arrived and is delayed.',
          'Considering whether to escalate the delay, possibly by filing a complaint with the Review Desk.',
        ],
      });
    }
    if (text.includes('assigned that request the reference')) {
      return JSON.stringify({
        facts: [
          'Asked the Records Office for a certified copy of their property record.',
          'The Records Office assigned the property record copy request the reference R-2077.',
        ],
      });
    }
    if (text.includes('assigned my request the reference')) {
      return JSON.stringify({
        facts: [
          'Asked the Records Office for a certified copy of their file.',
          'The Records Office assigned the certified copy request the reference R-1842.',
        ],
      });
    }
    return '{"facts": []}';
  }
  return undefined;
}

async function waitForTurn(server: ApprovalTestServer, sessionId: string, turnId: string): Promise<Turn> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const turn = GetTurnResponseSchema.parse(
      await (await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`)).json(),
    ).data;
    if (turn.state.status !== 'running') {
      return turn;
    }
    if (Date.now() > deadline) {
      throw new Error('turn never finished');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** One chat, one turn, in its own session, with the client time zone a real client sends. */
async function runChatTurn(
  server: ApprovalTestServer,
  options: { text: string; reply?: string; toolArguments?: Record<string, unknown> },
): Promise<{ turn: Turn; sessionId: string }> {
  if (options.toolArguments !== undefined) {
    server.model.next({ toolArguments: options.toolArguments });
  }
  if (options.reply !== undefined) {
    server.model.next({ reply: options.reply });
  }
  const created = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  const sessionId = z.object({ data: z.object({ id: z.string() }).loose() }).parse(await created.json()).data.id;
  const response = await server.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit({
      input: [{ type: 'user.message', content: options.text }],
      stream: false,
      client_timezone: 'UTC',
    }),
  );
  const body: unknown = await response.json();
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`turn failed (${String(response.status)}): ${JSON.stringify(body).slice(0, 500)}`);
  }
  const list = ListTurnsResponseSchema.parse(await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json());
  const turnId = list.data[0]?.id;
  if (turnId === undefined) {
    throw new Error('no turn listed');
  }
  return { turn: await waitForTurn(server, sessionId, turnId), sessionId };
}

/** Reads one day's retained note, waiting for the background retain to land it. */
async function readDayNote(memoryDir: string, day: string): Promise<string> {
  const path = join(memoryDir, 'default', 'memory', `${day}.md`);
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`no retained note for ${day}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

function describeScenario(scenario: BriefMatterMailScenario, options: { secondRequest: boolean }): void {
  describe(`morning brief matter link (${scenario})`, () => {
    let server: ApprovalTestServer;
    let memoryDir: string;
    const originalDir = configuration.MEMORY_MARKDOWN_DIR;
    const originalEmbeddings = configuration.MEMORY_EMBEDDINGS_ENABLED;
    let mail: ReturnType<typeof installBriefMatterMail> | undefined;
    let briefOpening: RecordedRequest | undefined;

    beforeAll(async () => {
      memoryDir = await mkdtemp(join(tmpdir(), `brief-matter-${scenario}-`));
      configuration.MEMORY_MARKDOWN_DIR = memoryDir;
      configuration.MEMORY_EMBEDDINGS_ENABLED = false;
      fakeClock('2026-11-02T09:00:00.000Z');
      server = await startApprovalTestServer();
      server.model.answerHostRequests(hostAnswer);
    }, 180_000);

    afterAll(async () => {
      mail?.restore();
      await server.close();
      jest.useRealTimers();
      configuration.MEMORY_MARKDOWN_DIR = originalDir;
      configuration.MEMORY_EMBEDDINGS_ENABLED = originalEmbeddings;
      await rm(memoryDir, { recursive: true, force: true });
    });

    it('retains the chats through the real retain path and records the reminder', async () => {
      const day1 = await runChatTurn(server, {
        text: DAY_1_TEXT,
        reply: 'Noted. The Records Office has your request as R-1842.',
      });
      expect(day1.turn.state.status).toBe('done');
      await memoryBackgroundWorkSettled({ timeoutMs: 10_000 });
      const day1Note = await readDayNote(memoryDir, '2026-11-02');
      expect(day1Note).toContain('R-1842');
      expect(day1Note).toContain('certified copy');

      if (options.secondRequest) {
        jest.setSystemTime(new Date('2026-11-03T09:00:00.000Z'));
        const day2 = await runChatTurn(server, {
          text: DAY_2_TEXT,
          reply: 'Noted. The property record copy is request R-2077.',
        });
        expect(day2.turn.state.status).toBe('done');
        await memoryBackgroundWorkSettled({ timeoutMs: 10_000 });
        const day2Note = await readDayNote(memoryDir, '2026-11-03');
        expect(day2Note).toContain('R-2077');
      }

      jest.setSystemTime(new Date('2026-11-04T09:00:00.000Z'));
      const day3 = await runChatTurn(server, {
        text: DAY_3_TEXT,
        reply:
          'You could call the Records Office first. If that goes nowhere, filing a complaint with the Review Desk is the escalation option.',
      });
      expect(day3.turn.state.status).toBe('done');
      await memoryBackgroundWorkSettled({ timeoutMs: 10_000 });
      const day3Note = await readDayNote(memoryDir, '2026-11-04');
      expect(day3Note).toContain('delayed');
      // Escalation was discussed as an option. The note keeps it as a consideration, not an event.
      expect(day3Note).toContain('Considering whether to escalate');

      jest.setSystemTime(new Date('2026-11-06T09:00:00.000Z'));
      const day5 = await runChatTurn(server, {
        text: DAY_5_TEXT,
        toolArguments: { what: REMINDER_WHAT, at: REMINDER_AT },
        reply: 'Reminder set for Sunday morning.',
      });
      expect(day5.turn.state.status).toBe('done');
      const schedules = await new SqliteScheduleStore(server.db()).listSchedules({
        tenant_id: 'default',
        limit: 20,
        page_token: undefined,
        agent_names: undefined,
        created_by_or_agent_ids: undefined,
      });
      const reminder = schedules.data.find(record => record.manifest.kind === 'reminder');
      if (reminder === undefined) {
        throw new Error('the reminder was not recorded');
      }
      // The real reminder path saves the words, the due time and the chat it came from. Nothing more.
      expect(reminder.manifest.task).toBe(REMINDER_WHAT);
      expect(reminder.manifest.run_at).toBe(REMINDER_AT);
      expect(reminder.manifest.origin_session_id).toBe(day5.sessionId);

      jest.setSystemTime(new Date('2026-11-08T10:00:00.000Z'));
      const day7 = await runChatTurn(server, {
        text: DAY_7_TEXT,
        reply: 'Thanks for the update. The copy is still outstanding.',
      });
      expect(day7.turn.state.status).toBe('done');
      await memoryBackgroundWorkSettled({ timeoutMs: 10_000 });
      const day7Note = await readDayNote(memoryDir, '2026-11-08');
      expect(day7Note).toContain('no delivery date');
      expect(day7Note).toContain('still pending');

      // Nothing retained anywhere along the timeline claims the complaint was filed. Before the
      // day 9 email, filing exists only as a discussed option.
      const allNotes = [day1Note, day3Note, day7Note].join('\n');
      expect(allNotes).not.toMatch(FILING_CLAIM);
    }, 300_000);

    it('runs the day 10 brief through the production scheduled-run entry point', async () => {
      if (scenario === 'ambiguous') {
        // The control holds at the fixture: the acknowledgment names no request at all.
        expect(briefMatterMailText(scenario)).not.toContain('R-1842');
        expect(briefMatterMailText(scenario)).not.toContain('R-2077');
      }
      if (scenario === 'none') {
        expect(briefMatterMailText(scenario)).not.toContain('Review Desk');
        expect(briefMatterMailText(scenario)).not.toContain('C-771');
      }

      jest.setSystemTime(new Date('2026-11-11T07:30:00.000Z'));
      const now = new Date().toISOString();
      const connectionStore = new SqliteGoogleConnectionStore(server.db());
      await connectionStore.save({
        tenant_id: 'default',
        created_by: STANDALONE_REQUEST_CONTEXT.subject.id,
        client_id: '123456789-abcdefghij.apps.googleusercontent.com',
        client_secret: 'GOCSPX-recorded',
        client_type: 'desktop',
        refresh_token: 'recorded-refresh-token',
        granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        account_email: 'owner@example.com',
        status: 'connected',
        created_at: now,
        updated_at: now,
      });
      const saved = await connectionStore.get({
        tenant_id: 'default',
        created_by: STANDALONE_REQUEST_CONTEXT.subject.id,
      });
      expect(saved?.account_email).toBe('owner@example.com');
      mail = installBriefMatterMail(scenario);

      const agent = await new SqliteAgentStore(server.db()).createAgent({
        host_managed: false,
        tenant_id: 'default',
        created_by_subject: OWNER_SUBJECT,
        name: `matter-brief-agent-${scenario}`,
        description: 'Morning brief matter link fixture',
        manifest: AGENT_SPEC,
        external_id: `matter-brief-agent-${scenario}`,
      });
      const scheduled = await new SqliteScheduleStore(server.db()).createScheduleAndRun({
        tenant_id: 'default',
        agent_id: agent.id,
        agent_name: agent.name,
        persona_id: null,
        name: 'morning-brief',
        manifest: ScheduleManifestSchema.parse({
          task: MORNING_BRIEF_PROMPT,
          cron: '30 7 * * *',
          timezone: 'UTC',
          status: 'active',
        }),
        created_by_subject: OWNER_SUBJECT,
        runFrom: new Date(),
      });
      const run = scheduled.pendingRun;
      if (run === undefined) {
        throw new Error('no pending run');
      }
      const requestCountBefore = server.model.requests().length;
      const execute = await server.request('/api/internal/schedules/runs/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}` },
        body: JSON.stringify({ schedule_run_id: run.id }),
      });
      expect(execute.status).toBe(204);
      const session = await new SqliteSessionStore(server.db()).getSessionByExternalId({
        tenant_id: 'default',
        external_id: run.id,
      });
      if (session === undefined) {
        throw new Error('no brief session');
      }
      const list = ListTurnsResponseSchema.parse(
        await (await server.request(`/api/v1/sessions/${session.session_id}/turns`)).json(),
      );
      const turnId = list.data[0]?.id;
      if (turnId === undefined) {
        throw new Error('no brief turn');
      }
      const briefTurn = await waitForTurn(server, session.session_id, turnId);
      expect(briefTurn.state.status).toBe('done');

      const requests = server.model.requests().slice(requestCountBefore);
      briefOpening = requests.find(request => JSON.stringify(request.messages).includes('Give me my morning brief'));
      if (briefOpening === undefined) {
        throw new Error('no model request carried the brief');
      }
      // The brief gets its ordinary task text, verbatim, and nothing about the fixture.
      expect(JSON.stringify(briefOpening.messages)).toContain(MORNING_BRIEF_PROMPT.slice(0, 120));
      // The mailbox is reachable through the tools a real brief is offered.
      expect(briefOpening.tools.map(tool => tool.function?.name)).toContain('list_inbox_threads');
      // The acknowledgment is not placed in the opening prompt. The brief has to go and read it.
      expect(JSON.stringify(briefOpening)).not.toContain('C-771');
    }, 300_000);

    if (scenario === 'linked') {
      // Baseline on current main: the paperwork history is retained in the daily notes, but an
      // unattended run gets no recall and no memory-reading tool, so the brief cannot reach it.
      it.failing('gives the brief a way to reach the stored paperwork history', () => {
        if (briefOpening === undefined) {
          throw new Error('the brief did not run');
        }
        const toolNames = briefOpening.tools.map(tool => tool.function?.name);
        const canReadMemory =
          toolNames.includes('list_pages') || toolNames.includes('read_page') || toolNames.includes('search_memory_notes');
        const historyInPrompt = JSON.stringify(briefOpening).includes('no delivery date');
        expect(canReadMemory || historyInPrompt).toBe(true);
      });

      // Baseline on current main: the reminder is in the schedule store, but the brief is offered
      // no tool that can list reminders or schedules, so the day 7 call it set up is invisible.
      it.failing('gives the brief a way to reach the reminder it set up', () => {
        if (briefOpening === undefined) {
          throw new Error('the brief did not run');
        }
        const toolNames = briefOpening.tools.map(tool => tool.function?.name);
        expect(toolNames.includes('list_reminders') || toolNames.includes('list_schedules')).toBe(true);
      });
    }
  });
}

describeScenario('linked', { secondRequest: false });
describeScenario('ambiguous', { secondRequest: true });
describeScenario('none', { secondRequest: false });
