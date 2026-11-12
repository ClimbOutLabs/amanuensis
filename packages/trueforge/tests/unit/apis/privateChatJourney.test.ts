/**
 * A private chat end to end over the real HTTP surface: it starts private, runs an action that
 * asks for approval, is approved, then is closed and deleted. Afterwards no table holds a row for
 * it except the receipts of what it did, the memory folder is unchanged, and the chat list and
 * the brief know nothing of it.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from '@hono/zod-openapi';
import type { Turn, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { sql } from 'kysely';

import configuration from '../../../src/config';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { INERT_SERVER_NAME, INERT_WRITE_TOOL } from '../../fixtures/inertMcpServer';
import { RUN_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;
/** The receipts of what a chat did; they outlive the chat by design. */
const RECEIPT_TABLES = new Set(['approval_token', 'sentinel_audit']);

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Use the inert connector exactly as instructed.',
  mcp_servers: [{ name: INERT_SERVER_NAME, preload: true, require_approval_for_tools: ['@write'] }],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

const SessionResponseSchema = z.object({ data: z.object({ id: z.string(), is_incognito: z.boolean() }).loose() });
const SessionListSchema = z.object({ data: z.array(z.object({ id: z.string() }).loose()) });
const NameRowsSchema = z.array(z.object({ name: z.string() }));
const CountRowsSchema = z.array(z.object({ n: z.number() }));

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function runTurn({
  server,
  sessionId,
  input,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  input: TurnInputItem[];
}): Promise<Turn> {
  const response = await server.request(`/api/v1/sessions/${sessionId}/turns`, jsonInit({ input, stream: true }));
  expect(response.status).toBe(200);
  let turnId: string | undefined;
  for (const line of (await response.text()).split('\n')) {
    if (line.startsWith('data: ')) {
      const event = TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length)));
      if (event.type === 'turn.created') {
        turnId = event.turn_id;
      }
    }
  }
  if (turnId === undefined) {
    throw new Error('the turn stream carried no turn.created event');
  }
  const turn = await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`);
  return GetTurnResponseSchema.parse(await turn.json()).data;
}

function pendingApproval(turn: Turn): { thread_id: string; tool_call_id: string } {
  if (turn.state.status === 'done') {
    for (const action of turn.state.required_actions) {
      const first = action.type === 'tool.approval_required' ? action.tool_calls[0] : undefined;
      if (action.type === 'tool.approval_required' && first !== undefined) {
        return { thread_id: action.thread_id, tool_call_id: first.id };
      }
    }
  }
  throw new Error(`expected the turn to wait for an approval: ${JSON.stringify(turn.state)}`);
}

/** A fingerprint of every file under `dir`, so any write to the memory folder shows. */
async function folderFingerprint(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      hash.update(full);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        hash.update(await readFile(full));
      }
    }
  };
  await walk(dir);
  return hash.digest('hex');
}

describe('a private chat from start to Close and delete', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer();
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  });

  async function count(query: ReturnType<typeof sql<{ n: number }>>): Promise<number> {
    const { rows } = await query.execute(server.db());
    return CountRowsSchema.parse(rows)[0]?.n ?? 0;
  }

  /** Rows that still name the chat, per table, for every table with a session_id column. */
  async function rowsNaming(sessionId: string): Promise<Record<string, number>> {
    const tables = NameRowsSchema.parse(
      (
        await sql<{
          name: string;
        }>`SELECT m.name AS name FROM sqlite_master m WHERE m.type = 'table' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) c WHERE c.name = 'session_id')`.execute(
          server.db(),
        )
      ).rows,
    ).map(row => row.name);
    const found: Record<string, number> = {};
    for (const table of tables) {
      const n = await count(
        sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)} WHERE session_id = ${sessionId}`,
      );
      if (n > 0) {
        found[table] = n;
      }
    }
    return found;
  }

  it(
    'runs an approved action, then leaves only its receipts behind',
    async () => {
      const memoryBefore = await folderFingerprint(configuration.MEMORY_MARKDOWN_DIR);

      const created = await server.request(
        '/api/v1/sessions',
        jsonInit({ agent: { spec: AGENT_SPEC }, is_incognito: true }),
      );
      expect(created.status).toBe(201);
      const session = SessionResponseSchema.parse(await created.json()).data;
      expect(session.is_incognito).toBe(true);

      // The action asks first, as in a normal chat, and runs once approved.
      const paused = await runTurn({
        server,
        sessionId: session.id,
        input: [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${INERT_WRITE_TOOL} please` }],
      });
      const resumed = await runTurn({
        server,
        sessionId: session.id,
        input: [
          { type: 'user.tool_approval', ...pendingApproval(paused), approval: { status: 'allow', scope: 'once' } },
        ],
      });
      expect(resumed.state.status).toBe('done');
      expect(server.mcp.writeInvocations()).toBe(1);

      const receiptsBefore = {
        approval_token: await count(sql<{ n: number }>`SELECT count(*) AS n FROM approval_token`),
        sentinel_audit: await count(sql<{ n: number }>`SELECT count(*) AS n FROM sentinel_audit`),
      };
      expect(receiptsBefore.approval_token).toBeGreaterThan(0);
      expect(receiptsBefore.sentinel_audit).toBeGreaterThan(0);
      expect(Object.keys(await rowsNaming(session.id))).toContain('turn');

      // A normal list leaves it out; the tab that holds it asks for it by name.
      const listed = SessionListSchema.parse(await (await server.request('/api/v1/sessions')).json());
      expect(listed.data.map(chat => chat.id)).not.toContain(session.id);
      const withPrivate = SessionListSchema.parse(
        await (await server.request('/api/v1/sessions?include_private=true')).json(),
      );
      expect(withPrivate.data.map(chat => chat.id)).toContain(session.id);

      // Close and delete.
      const deleted = await server.request(`/api/v1/sessions/${session.id}`, { method: 'DELETE' });
      expect(deleted.status).toBe(204);

      const left = await rowsNaming(session.id);
      expect(Object.keys(left).filter(table => !RECEIPT_TABLES.has(table))).toEqual([]);
      expect({
        approval_token: await count(sql<{ n: number }>`SELECT count(*) AS n FROM approval_token`),
        sentinel_audit: await count(sql<{ n: number }>`SELECT count(*) AS n FROM sentinel_audit`),
      }).toEqual(receiptsBefore);
      expect((await server.request(`/api/v1/sessions/${session.id}`)).status).toBe(404);
      expect(
        await count(
          sql<{ n: number }>`SELECT count(*) AS n FROM brief_item_completion WHERE instr(item_key, ${session.id}) > 0`,
        ),
      ).toBe(0);
      expect(await folderFingerprint(configuration.MEMORY_MARKDOWN_DIR)).toBe(memoryBefore);
    },
    TURN_TIMEOUT_MS,
  );
});
