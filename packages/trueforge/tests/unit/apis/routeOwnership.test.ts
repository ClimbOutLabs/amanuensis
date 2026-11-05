/**
 * Two signed-in users over the whole HTTP surface: Bob tries every id-taking route with Alice's ids and may neither
 * read nor change what she owns. Runs on SQLite, and on Postgres when `PG_STORE_TESTS_ADMIN_URL` names a server;
 * every route must refuse a caller with no sign-in, except the few that are public on purpose.
 */
import { z } from '@hono/zod-openapi';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import configuration from '../../../src/config';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import { INERT_SERVER_NAME, INERT_WRITE_TOOL } from '../../fixtures/inertMcpServer';
import {
  ADMIN_USER,
  MODEL_FQN,
  startOwnershipServer,
  type OwnershipEngine,
  type OwnershipServer,
} from '../../fixtures/ownershipServer';
import { RUN_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';

/** Planted in everything Alice owns, so any response carrying it to Bob is a leak. */
const SECRET = 'alice-private-marker-7f3a91';

const TURN_TIMEOUT_MS = 60_000;

/** Routes anyone may call without signing in: liveness, the sign-in pages, provider callbacks and API docs. */
const PUBLIC_ROUTES = new Set([
  'GET /healthz',
  'GET /api/v1/auth/login',
  'GET /api/v1/auth/callback',
  'POST /api/v1/auth/logout',
  'GET /api/v1/mcp-servers/oauth/callback',
  'GET /api/v1/docs',
  'GET /api/v1/openapi.json',
]);

/** Routes that answer any signed-in user for an id they did not create, because the record is shared on purpose. */
const SHARED_BY_DESIGN = new Set(['GET /api/v1/agents/:agent_id', 'GET /api/v1/agents/:agent_id/code-snippets']);

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: `Use the inert connector. ${SECRET}`,
  mcp_servers: [
    {
      name: INERT_SERVER_NAME,
      preload: true,
      require_approval_for_tools: ['@write', '@destructive', '@unclassified'],
    },
  ],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

const IdSchema = z.object({ data: z.object({ id: z.string() }).loose() });
const SpaceCreatedSchema = z.object({ data: z.object({ space: z.object({ id: z.string() }).loose() }).loose() });
const VaultListSchema = z.object({ data: z.array(z.object({ id: z.string(), text: z.string() }).loose()) });
const PendingTurnSchema = z.object({
  data: z
    .object({
      state: z
        .object({
          status: z.string(),
          required_actions: z.array(z.object({ type: z.string() }).loose()).optional(),
        })
        .loose(),
    })
    .loose(),
});
const ApprovalActionSchema = z.object({
  type: z.literal('tool.approval_required'),
  thread_id: z.string(),
  tool_calls: z.array(z.object({ id: z.string() }).loose()),
});

interface Seeded {
  sessionId: string;
  externalId: string;
  turnId: string;
  threadId: string;
  toolCallId: string;
  agentId: string;
  scheduleId: string;
  personaId: string;
  documentId: string;
  spaceId: string;
  folderId: string;
  spaceFolderId: string;
  repositoryId: string;
  vaultEntryId: string;
}

async function bodyOf(response: Response): Promise<{ text: string; json: unknown }> {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

function describeRouteOwnership(engine: OwnershipEngine): void {
  describe(`route ownership on ${engine}`, () => {
    let server: OwnershipServer | undefined;
    let seeded: Seeded;
    let memoryDir: string;
    const originalMemory = {
      backend: configuration.MEMORY_BACKEND,
      directory: configuration.MEMORY_MARKDOWN_DIR,
      embeddings: configuration.MEMORY_EMBEDDINGS_ENABLED,
      summarize: configuration.MEMORY_SUMMARIZE,
    };

    function live(): OwnershipServer {
      if (server === undefined) {
        throw new Error('server not started');
      }
      return server;
    }

    async function call(input: { user: string; path: string; method?: string; json?: unknown }): Promise<Response> {
      return await live().request(input);
    }

    async function callOk({
      user,
      path: requestPath,
      method,
      json,
      status,
    }: {
      user: string;
      path: string;
      method?: string;
      json?: unknown;
      status: number;
    }): Promise<unknown> {
      const response = await call({
        user,
        path: requestPath,
        ...(method === undefined ? {} : { method }),
        ...(json === undefined ? {} : { json }),
      });
      const body = await bodyOf(response);
      if (response.status !== status) {
        throw new Error(
          `${method ?? 'GET'} ${requestPath} as ${user}: expected ${String(status)}, got ${String(response.status)}: ${body.text}`,
        );
      }
      return body.json;
    }

    async function runTurn({ sessionId, content }: { sessionId: string; content: string }): Promise<string> {
      const response = await call({
        user: ALICE,
        path: `/api/v1/sessions/${sessionId}/turns`,
        method: 'POST',
        json: { input: [{ type: 'user.message', content }], stream: true },
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          const event = TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length)));
          if (event.type === 'turn.created') {
            return event.turn_id;
          }
        }
      }
      throw new Error(`no turn.created in stream: ${text.slice(0, 300)}`);
    }

    beforeAll(async () => {
      memoryDir = await mkdtemp(path.join(tmpdir(), 'tfy-ownership-memory-'));
      configuration.MEMORY_BACKEND = 'markdown';
      configuration.MEMORY_MARKDOWN_DIR = memoryDir;
      configuration.MEMORY_EMBEDDINGS_ENABLED = false;
      configuration.MEMORY_SUMMARIZE = false;
      server = await startOwnershipServer(engine);
      if (server === undefined) {
        return;
      }

      const session = IdSchema.parse(
        await callOk({
          user: ALICE,
          path: '/api/v1/sessions',
          method: 'POST',
          json: { agent: { spec: AGENT_SPEC }, metadata: { note: SECRET } },
          status: 201,
        }),
      ).data.id;
      const externalId = 'alice-external-id';
      await callOk({
        user: ALICE,
        path: '/api/internal/sessions/get-or-create-by-external-id',
        method: 'POST',
        json: { external_id: externalId, agent: { spec: AGENT_SPEC } },
        status: 201,
      });
      const turnId = await runTurn({
        sessionId: session,
        content: `${RUN_DIRECTIVE_PREFIX}${INERT_WRITE_TOOL} ${SECRET}`,
      });
      const turn = PendingTurnSchema.parse(
        await callOk({ user: ALICE, path: `/api/v1/sessions/${session}/turns/${turnId}`, status: 200 }),
      );
      const approval = ApprovalActionSchema.parse(
        (turn.data.state.required_actions ?? []).find(action => action.type === 'tool.approval_required'),
      );
      const toolCallId = approval.tool_calls[0]?.id;
      if (toolCallId === undefined) {
        throw new Error('the held write has no tool call');
      }

      const agentId = IdSchema.parse(
        await callOk({
          user: ALICE,
          path: '/api/v1/agents',
          method: 'POST',
          json: {
            name: 'alice-agent',
            description: SECRET,
            manifest: { model: { name: MODEL_FQN }, instructions: SECRET },
          },
          status: 201,
        }),
      ).data.id;
      const scheduleId = IdSchema.parse(
        await callOk({
          user: ALICE,
          path: '/api/v1/schedules',
          method: 'POST',
          json: {
            agent_name: 'alice-agent',
            name: 'alice-schedule',
            manifest: { task: SECRET, cron: '0 13 * * *', timezone: 'UTC' },
          },
          status: 201,
        }),
      ).data.id;
      const personaId = IdSchema.parse(
        await callOk({
          user: ALICE,
          path: '/api/v1/personas',
          method: 'POST',
          json: {
            persona: { display_name: 'Zara', aliases: [], instructions: SECRET, model_name: MODEL_FQN },
          },
          status: 201,
        }),
      ).data.id;
      const documentId = IdSchema.parse(
        await callOk({
          user: ALICE,
          path: `/api/v1/personas/${personaId}/knowledge`,
          method: 'POST',
          json: { kind: 'text', title: 'Alice notes', text: SECRET },
          status: 201,
        }),
      ).data.id;
      const spaceId = SpaceCreatedSchema.parse(
        await callOk({
          user: ALICE,
          path: '/api/v1/spaces',
          method: 'POST',
          json: {
            space: { name: 'Alice space', purpose: SECRET, status: 'active', body: SECRET },
            expected_aggregate_revision: 0,
          },
          status: 201,
        }),
      ).data.space.id;
      const folderId = IdSchema.parse(
        await callOk({
          user: ALICE,
          path: '/api/v1/session-folders',
          method: 'POST',
          json: { name: 'Alice folder' },
          status: 201,
        }),
      ).data.id;
      await callOk({
        user: ALICE,
        path: `/api/v1/sessions/${session}/folder`,
        method: 'PUT',
        json: { folder_id: folderId },
        status: 200,
      });
      const spaceFolderId = IdSchema.parse(
        await callOk({
          user: ALICE,
          path: '/api/v1/space-folders',
          method: 'POST',
          json: { name: 'Alice space folder' },
          status: 201,
        }),
      ).data.id;
      await callOk({
        user: ALICE,
        path: `/api/v1/spaces/${spaceId}/folder`,
        method: 'PUT',
        json: { folder_id: spaceFolderId },
        status: 200,
      });
      const repositoryId = IdSchema.parse(
        await callOk({
          user: ALICE,
          path: '/api/v1/repositories',
          method: 'POST',
          json: { repository: { name: 'alice-repo', clone_url: 'https://example.test/alice.git' } },
          status: 201,
        }),
      ).data.id;
      await callOk({
        user: ALICE,
        path: '/api/v1/memory/vault/import',
        method: 'POST',
        json: { entries: [{ text: `Alice remembers ${SECRET}` }] },
        status: 201,
      });
      const vault = VaultListSchema.parse(await callOk({ user: ALICE, path: '/api/v1/memory/vault', status: 200 }));
      const vaultEntryId = vault.data[0]?.id;
      if (vaultEntryId === undefined) {
        throw new Error('the vault import left no entry');
      }
      await callOk({
        user: ALICE,
        path: '/api/v1/personalization/profile',
        method: 'PUT',
        json: {
          profile: {
            assistant_name: null,
            assistant_identity: null,
            voice_guidance: null,
            user_profile: `About Alice ${SECRET}`,
            pinned_preferences: [],
          },
        },
        status: 200,
      });

      seeded = {
        sessionId: session,
        externalId,
        turnId,
        threadId: approval.thread_id,
        toolCallId,
        agentId,
        scheduleId,
        personaId,
        documentId,
        spaceId,
        folderId,
        spaceFolderId,
        repositoryId,
        vaultEntryId,
      };
    }, 120_000);

    afterAll(async () => {
      configuration.MEMORY_BACKEND = originalMemory.backend;
      configuration.MEMORY_MARKDOWN_DIR = originalMemory.directory;
      configuration.MEMORY_EMBEDDINGS_ENABLED = originalMemory.embeddings;
      configuration.MEMORY_SUMMARIZE = originalMemory.summarize;
      await server?.close();
      await rm(memoryDir, { recursive: true, force: true });
    });

    /** Bob must be refused with 403 or 404, and the refusal must not echo anything Alice owns. */
    async function refusalProblem(input: {
      path: string;
      method?: string;
      json?: unknown;
      idempotent?: boolean;
    }): Promise<string | undefined> {
      const { idempotent, ...request } = input;
      const response = await call({ user: BOB, ...request });
      const body = await bodyOf(response);
      const label = `${input.method ?? 'GET'} ${input.path}`;
      // A delete that finds nothing of Bob's answers 200 by design; the integrity test proves Alice's survives.
      if (![403, 404, ...(idempotent === true ? [200] : [])].includes(response.status)) {
        return `${label} answered ${String(response.status)}: ${body.text.slice(0, 200)}`;
      }
      return body.text.includes(SECRET) ? `${label} echoed Alice data` : undefined;
    }

    function crossReferenceProbes(
      bobSession: string,
    ): { name: string; path: string; method?: string; json?: unknown }[] {
      const s = seeded;
      const mine = `/api/v1/sessions/${bobSession}`;
      return [
        { name: 'her turn through his session', path: `${mine}/turns/${s.turnId}` },
        { name: 'her turn events through his session', path: `${mine}/turns/${s.turnId}/events` },
        { name: 'her turn artifacts through his session', path: `${mine}/turns/${s.turnId}/artifacts` },
        {
          name: 'her sandbox file through his session',
          path: `${mine}/turns/${s.turnId}/download-sandbox-file?path=x`,
        },
        { name: 'her turn stream through his session', path: `${mine}/turns/${s.turnId}/subscribe` },
        {
          name: 'her persona on his session',
          path: `${mine}/persona`,
          method: 'PUT',
          json: { persona_id: s.personaId },
        },
        { name: 'her folder on his session', path: `${mine}/folder`, method: 'PUT', json: { folder_id: s.folderId } },
        {
          name: 'her repository on his session',
          path: `${mine}/repository`,
          method: 'PUT',
          json: { repository_id: s.repositoryId, workspace_cwd: '/tmp/x', expected_revision: 0 },
        },
        {
          name: 'chain his turn onto her turn',
          path: `${mine}/turns`,
          method: 'POST',
          json: {
            input: [{ type: 'user.message', content: 'summarize our chat' }],
            previous_turn_id: s.turnId,
            stream: false,
          },
        },
      ];
    }

    function probes(): { name: string; path: string; method?: string; json?: unknown; idempotent?: boolean }[] {
      const s = seeded;
      const sessions = `/api/v1/sessions/${s.sessionId}`;
      const turns = `${sessions}/turns`;
      const turn = `${turns}/${s.turnId}`;
      return [
        { name: 'get session', path: sessions },
        { name: 'rename session', path: sessions, method: 'PATCH', json: { title: 'pwned' } },
        { name: 'delete session', path: sessions, method: 'DELETE' },
        { name: 'cancel session', path: `${sessions}/cancel`, method: 'POST' },
        { name: 'session events', path: `${sessions}/events` },
        { name: 'bug report', path: `${sessions}/bug-report`, method: 'POST', json: { description: 'x' } },
        { name: 'list plan grants', path: `${sessions}/implementation-plan-grants` },
        { name: 'revoke plan grant', path: `${sessions}/implementation-plan-grants/g1`, method: 'DELETE' },
        { name: 'audit log', path: `${sessions}/audit-log` },
        { name: 'get session persona', path: `${sessions}/persona` },
        {
          name: 'set session persona',
          path: `${sessions}/persona`,
          method: 'PUT',
          json: { persona_id: s.personaId },
        },
        { name: 'persona activations', path: `${sessions}/persona-activations` },
        { name: 'set session folder', path: `${sessions}/folder`, method: 'PUT', json: { folder_id: s.folderId } },
        { name: 'clear session folder', path: `${sessions}/folder`, method: 'DELETE' },
        { name: 'get session repository', path: `${sessions}/repository` },
        {
          name: 'bind session repository',
          path: `${sessions}/repository`,
          method: 'PUT',
          json: { repository_id: s.repositoryId, workspace_cwd: '/tmp/x', expected_revision: 0 },
        },
        { name: 'unbind session repository', path: `${sessions}/repository`, method: 'DELETE' },
        { name: 'list turns', path: turns },
        { name: 'get turn', path: turn },
        { name: 'turn events', path: `${turn}/events` },
        { name: 'turn artifacts', path: `${turn}/artifacts` },
        { name: 'turn sandbox download', path: `${turn}/download-sandbox-file?path=/etc/passwd` },
        { name: 'subscribe turn', path: `${turn}/subscribe` },
        {
          name: 'start turn in her session',
          path: turns,
          method: 'POST',
          json: { input: [{ type: 'user.message', content: 'hi' }], stream: false },
        },
        {
          name: 'answer her held action in her session',
          path: turns,
          method: 'POST',
          json: {
            input: [
              {
                type: 'user.tool_approval',
                thread_id: s.threadId,
                tool_call_id: s.toolCallId,
                approval: { status: 'allow', scope: 'always' },
              },
            ],
            stream: false,
          },
        },
        {
          name: 'by external id',
          path: '/api/internal/sessions/get-or-create-by-external-id',
          method: 'POST',
          json: { external_id: s.externalId, agent: { spec: AGENT_SPEC } },
        },
        { name: 'get schedule', path: `/api/v1/schedules/${s.scheduleId}` },
        {
          name: 'update schedule',
          path: `/api/v1/schedules/${s.scheduleId}`,
          method: 'PUT',
          json: { name: 'pwned', manifest: { task: 'pwned', cron: '0 1 * * *', timezone: 'UTC' } },
        },
        { name: 'delete schedule', path: `/api/v1/schedules/${s.scheduleId}`, method: 'DELETE' },
        { name: 'schedule runs', path: `/api/v1/schedules/${s.scheduleId}/runs` },
        { name: 'run schedule', path: '/api/v1/schedules/runs', method: 'POST', json: { schedule_id: s.scheduleId } },
        {
          name: 'update agent',
          path: `/api/v1/agents/${s.agentId}`,
          method: 'PUT',
          json: { manifest: { model: { name: MODEL_FQN }, instructions: 'pwned' } },
        },
        { name: 'delete agent', path: `/api/v1/agents/${s.agentId}`, method: 'DELETE' },
        {
          name: 'update persona',
          path: `/api/v1/personas/${s.personaId}`,
          method: 'PUT',
          json: { persona: { display_name: 'pwned', aliases: [], instructions: 'pwned', model_name: MODEL_FQN } },
        },
        { name: 'delete persona', path: `/api/v1/personas/${s.personaId}`, method: 'DELETE' },
        { name: 'persona context', path: `/api/v1/personas/${s.personaId}/context` },
        { name: 'list knowledge', path: `/api/v1/personas/${s.personaId}/knowledge` },
        {
          name: 'upload knowledge',
          path: `/api/v1/personas/${s.personaId}/knowledge`,
          method: 'POST',
          json: { kind: 'text', title: 'planted', text: 'planted' },
        },
        {
          name: 'delete knowledge',
          path: `/api/v1/personas/${s.personaId}/knowledge/${s.documentId}`,
          method: 'DELETE',
        },
        { name: 'knowledge model', path: `/api/v1/personas/${s.personaId}/knowledge/embedding-model` },
        { name: 'get space', path: `/api/v1/spaces/${s.spaceId}` },
        {
          name: 'update space',
          path: `/api/v1/spaces/${s.spaceId}`,
          method: 'PUT',
          json: {
            space: { name: 'pwned', purpose: 'pwned', status: 'active', body: 'pwned' },
            expected_revision: 1,
            expected_aggregate_revision: 0,
          },
        },
        {
          name: 'revert space',
          path: `/api/v1/spaces/${s.spaceId}/revert`,
          method: 'POST',
          json: { revision: 1, expected_revision: 1, expected_aggregate_revision: 0 },
        },
        { name: 'delete space', path: `/api/v1/spaces/${s.spaceId}?expected_revision=1`, method: 'DELETE' },
        {
          name: 'rename folder',
          path: `/api/v1/session-folders/${s.folderId}`,
          method: 'PUT',
          json: { name: 'pwned' },
        },
        { name: 'delete folder', path: `/api/v1/session-folders/${s.folderId}`, method: 'DELETE', idempotent: true },
        {
          name: 'rename space folder',
          path: `/api/v1/space-folders/${s.spaceFolderId}`,
          method: 'PUT',
          json: { name: 'pwned' },
        },
        {
          name: 'delete space folder',
          path: `/api/v1/space-folders/${s.spaceFolderId}`,
          method: 'DELETE',
          idempotent: true,
        },
        {
          name: 'move her space',
          path: `/api/v1/spaces/${s.spaceId}/folder`,
          method: 'PUT',
          json: { folder_id: s.spaceFolderId },
        },
        { name: 'unfile her space', path: `/api/v1/spaces/${s.spaceId}/folder`, method: 'DELETE' },
        { name: 'get repository', path: `/api/v1/repositories/${s.repositoryId}` },
        { name: 'repository commands', path: `/api/v1/repositories/${s.repositoryId}/commands` },
        {
          name: 'change repository command',
          path: `/api/v1/repositories/${s.repositoryId}/commands/verify`,
          method: 'PUT',
          json: { purpose: 'verify', command: 'rm -rf /', timeout_ms: 1000, expected_revision: 0 },
        },
        {
          name: 'delete repository command',
          path: `/api/v1/repositories/${s.repositoryId}/commands/verify`,
          method: 'DELETE',
        },
        { name: 'repository proposals', path: `/api/v1/repositories/${s.repositoryId}/command-proposals` },
        {
          name: 'confirm proposal',
          path: `/api/v1/repositories/${s.repositoryId}/command-proposals/p1/confirm`,
          method: 'POST',
          json: { command_id: 'verify', timeout_ms: 1000, expected_revision: 0 },
        },
        {
          name: 'dismiss proposal',
          path: `/api/v1/repositories/${s.repositoryId}/command-proposals/p1`,
          method: 'DELETE',
        },
      ];
    }

    it('probes only routes that are really mounted, so a 404 means refused and not mistyped', () => {
      if (server === undefined) {
        return;
      }
      const patterns = live().routes.map(route => ({
        method: route.method,
        pattern: new RegExp(`^${route.path.replace(/:[A-Za-z_]+/g, '[^/]+')}$`),
      }));
      const unmounted = [...probes(), ...crossReferenceProbes('bob-session')]
        .filter(probe => {
          const pathname = probe.path.split('?')[0] ?? probe.path;
          return !patterns.some(route => route.method === (probe.method ?? 'GET') && route.pattern.test(pathname));
        })
        .map(probe => `${probe.method ?? 'GET'} ${probe.path}`);
      expect(unmounted).toEqual([]);
    });

    it('hides Alice records on every mounted GET route that takes one of her ids', async () => {
      if (server === undefined) {
        return;
      }
      const s = seeded;
      const owned: Record<string, string> = {
        session_id: s.sessionId,
        turn_id: s.turnId,
        schedule_id: s.scheduleId,
        persona_id: s.personaId,
        document_id: s.documentId,
        space_id: s.spaceId,
        folder_id: s.folderId,
        repository_id: s.repositoryId,
        entry_id: s.vaultEntryId,
        agent_id: s.agentId,
      };
      const problems: string[] = [];
      const seen = new Set<string>();
      for (const route of live().routes) {
        const key = `${route.method} ${route.path}`;
        const params = [...route.path.matchAll(/:([A-Za-z_]+)/g)].map(match => match[1] ?? '');
        if (route.method !== 'GET' || seen.has(key) || !params.some(param => param in owned)) {
          continue;
        }
        seen.add(key);
        const url = route.path.replace(/:([A-Za-z_]+)/g, (_match, param: string) =>
          encodeURIComponent(owned[param] ?? 'inert'),
        );
        const response = await call({ user: BOB, path: url.includes('download-sandbox-file') ? `${url}?path=x` : url });
        const body = await bodyOf(response);
        const refused = [403, 404].includes(response.status);
        if (!SHARED_BY_DESIGN.has(key) && (!refused || body.text.includes(SECRET))) {
          problems.push(`${key} answered ${String(response.status)}`);
        }
      }
      expect(problems).toEqual([]);
      expect(seen.size).toBeGreaterThan(10);
    });

    it(
      'refuses user B on every id-taking route with user A ids',
      async () => {
        if (server === undefined) {
          return;
        }
        const problems: string[] = [];
        for (const probe of probes()) {
          const problem = await refusalProblem(probe);
          if (problem !== undefined) {
            problems.push(`${probe.name}: ${problem}`);
          }
        }
        expect(problems).toEqual([]);
      },
      TURN_TIMEOUT_MS,
    );

    it('leaves everything Alice owns exactly as it was', async () => {
      if (server === undefined) {
        return;
      }
      const s = seeded;
      const sessionBody = await bodyOf(await call({ user: ALICE, path: `/api/v1/sessions/${s.sessionId}` }));
      expect(sessionBody.text).toContain(SECRET);
      expect(sessionBody.text).not.toContain('pwned');
      for (const owned of [
        `/api/v1/schedules/${s.scheduleId}`,
        `/api/v1/spaces/${s.spaceId}`,
        `/api/v1/repositories/${s.repositoryId}`,
        `/api/v1/personas/${s.personaId}/knowledge`,
        `/api/v1/sessions/${s.sessionId}/turns/${s.turnId}`,
      ]) {
        const response = await call({ user: ALICE, path: owned });
        const body = await bodyOf(response);
        expect({ owned, status: response.status }).toEqual({ owned, status: 200 });
        expect(body.text).not.toContain('pwned');
        expect(body.text).not.toContain('planted');
      }
      const list = await bodyOf(await call({ user: ALICE, path: '/api/v1/session-folders' }));
      expect(list.text).toContain(s.folderId);
      expect(list.text).not.toContain('pwned');
      const spaceFolders = await bodyOf(await call({ user: ALICE, path: '/api/v1/space-folders' }));
      expect(spaceFolders.text).toContain(s.spaceFolderId);
      expect(spaceFolders.text).not.toContain('pwned');
      const personas = await bodyOf(await call({ user: ALICE, path: '/api/v1/personas' }));
      expect(personas.text).toContain(s.personaId);
      expect(personas.text).not.toContain('pwned');
      const agent = await bodyOf(await call({ user: ALICE, path: `/api/v1/agents/${s.agentId}` }));
      expect(agent.text).not.toContain('pwned');
      expect(live().mcp.writeInvocations()).toBe(0);
      const turn = PendingTurnSchema.parse(
        (await bodyOf(await call({ user: ALICE, path: `/api/v1/sessions/${s.sessionId}/turns/${s.turnId}` }))).json,
      );
      expect(turn.data.state.required_actions?.map(action => action.type)).toContain('tool.approval_required');
    });

    it('never lists, counts or exposes Alice records in Bob lists', async () => {
      if (server === undefined) {
        return;
      }
      for (const listing of [
        '/api/v1/sessions',
        '/api/v1/schedules',
        '/api/v1/personas',
        '/api/v1/spaces',
        '/api/v1/session-folders',
        '/api/v1/space-folders',
        '/api/v1/repositories',
        '/api/v1/personalization/profile',
        '/api/v1/personalization/context',
        '/api/v1/user/settings/sentinel',
        `/api/v1/mcp-servers/${INERT_SERVER_NAME}/tool-grants`,
      ]) {
        const response = await call({ user: BOB, path: listing });
        const body = await bodyOf(response);
        expect({ listing, status: response.status < 500 }).toEqual({ listing, status: true });
        expect({ listing, leaked: body.text.includes(SECRET) || body.text.includes(seeded.sessionId) }).toEqual({
          listing,
          leaked: false,
        });
        for (const id of [
          seeded.scheduleId,
          seeded.personaId,
          seeded.spaceId,
          seeded.folderId,
          seeded.spaceFolderId,
          seeded.repositoryId,
        ]) {
          expect({ listing, leaked: body.text.includes(id) }).toEqual({ listing, leaked: false });
        }
      }
    });

    /**
     * Open finding, not yet fixed: the vault and turn memory are keyed by tenant, and every hosted user shares one
     * tenant. `it.failing` keeps the strict assertions and turns red the day the leak is closed, which is the
     * cue to make this a plain `it`.
     */
    it.failing('keeps Alice memory vault to Alice: Bob reads, edits, deletes and shares none of it', async () => {
      if (server === undefined) {
        return;
      }
      const s = seeded;
      for (const read of ['/api/v1/memory/vault', '/api/v1/memory/vault/export', '/api/v1/memory/vault/sharing']) {
        const body = await bodyOf(await call({ user: BOB, path: read }));
        expect({ read, leaked: body.text.includes(SECRET) }).toEqual({ read, leaked: false });
      }
      const update = await call({
        user: BOB,
        path: `/api/v1/memory/vault/${encodeURIComponent(s.vaultEntryId)}`,
        method: 'PUT',
        json: { text: 'pwned memory' },
      });
      expect([403, 404]).toContain(update.status);
      const deleted = await call({
        user: BOB,
        path: `/api/v1/memory/vault/${encodeURIComponent(s.vaultEntryId)}`,
        method: 'DELETE',
      });
      expect([403, 404]).toContain(deleted.status);
      await call({
        user: ALICE,
        path: '/api/v1/memory/vault/sharing',
        method: 'PUT',
        json: { shares: { [s.personaId]: ['default'] } },
      });
      await call({ user: BOB, path: '/api/v1/memory/vault/sharing', method: 'PUT', json: { shares: {} } });
      const aliceVault = await bodyOf(await call({ user: ALICE, path: '/api/v1/memory/vault' }));
      expect(aliceVault.text).toContain(SECRET);
      expect(aliceVault.text).not.toContain('pwned memory');
      const aliceSharing = await bodyOf(await call({ user: ALICE, path: '/api/v1/memory/vault/sharing' }));
      expect(aliceSharing.text).toContain(s.personaId);
    });

    it.failing(
      'keeps Alice remembered facts out of what Bob turn shows the model',
      async () => {
        if (server === undefined) {
          throw new Error('no server');
        }
        const bobSession = IdSchema.parse(
          await callOk({
            user: BOB,
            path: '/api/v1/sessions',
            method: 'POST',
            json: { agent: { spec: AGENT_SPEC } },
            status: 201,
          }),
        ).data.id;
        const before = live().model.requests().length;
        const response = await call({
          user: BOB,
          path: `/api/v1/sessions/${bobSession}/turns`,
          method: 'POST',
          json: { input: [{ type: 'user.message', content: 'what do you remember about me?' }], stream: true },
        });
        await response.text();
        const shown = live()
          .model.requests()
          .slice(before)
          .some(request => JSON.stringify(request.messages).includes(SECRET));
        expect(shown).toBe(false);
      },
      TURN_TIMEOUT_MS,
    );

    it('reports no permissions to Bob on Alice sessions and schedules', async () => {
      if (server === undefined) {
        return;
      }
      for (const [resourceType, id] of [
        ['session', seeded.sessionId],
        ['schedule', seeded.scheduleId],
      ] as const) {
        const body = z.object({ data: z.record(z.string(), z.array(z.string())) }).parse(
          await callOk({
            user: BOB,
            path: '/api/internal/list-permissions',
            method: 'POST',
            json: { resource_type: resourceType, resource_ids: [id] },
            status: 200,
          }),
        );
        expect({ resourceType, permissions: body.data[id] }).toEqual({ resourceType, permissions: [] });
      }
    });

    it('keeps Alice profile and settings to Alice when Bob writes his own', async () => {
      if (server === undefined) {
        return;
      }
      await call({
        user: BOB,
        path: '/api/v1/personalization/profile',
        method: 'PUT',
        json: {
          profile: {
            assistant_name: null,
            assistant_identity: null,
            voice_guidance: null,
            user_profile: 'About Bob',
            pinned_preferences: [],
          },
        },
      });
      await call({ user: BOB, path: '/api/v1/personalization/profile', method: 'DELETE' });
      await call({ user: BOB, path: '/api/v1/user/settings/sentinel', method: 'PATCH', json: { offline_mode: true } });
      const alice = await bodyOf(await call({ user: ALICE, path: '/api/v1/personalization/profile' }));
      expect(alice.text).toContain(SECRET);
      const aliceSentinel = await bodyOf(await call({ user: ALICE, path: '/api/v1/user/settings/sentinel' }));
      expect(aliceSentinel.text).not.toContain('"offline_mode":true');
    });

    it('does not let Bob answer Alice held write from a session of his own', async () => {
      if (server === undefined) {
        return;
      }
      const s = seeded;
      const bobSession = IdSchema.parse(
        await callOk({
          user: BOB,
          path: '/api/v1/sessions',
          method: 'POST',
          json: { agent: { spec: AGENT_SPEC } },
          status: 201,
        }),
      ).data.id;
      for (const previous of [s.turnId, 'none', 'auto']) {
        const response = await call({
          user: BOB,
          path: `/api/v1/sessions/${bobSession}/turns`,
          method: 'POST',
          json: {
            input: [
              {
                type: 'user.tool_approval',
                thread_id: s.threadId,
                tool_call_id: s.toolCallId,
                approval: { status: 'allow', scope: 'always' },
              },
            ],
            previous_turn_id: previous,
            stream: false,
          },
        });
        await response.text();
        expect({ previous, ran: live().mcp.writeInvocations() }).toEqual({ previous, ran: 0 });
      }
      const grants = await bodyOf(
        await call({ user: BOB, path: `/api/v1/mcp-servers/${INERT_SERVER_NAME}/tool-grants` }),
      );
      expect(grants.text).not.toContain(INERT_WRITE_TOOL);
    });

    it('does not let Bob wire his own session to Alice turn, persona, folder or repository', async () => {
      if (server === undefined) {
        return;
      }
      const bobSession = IdSchema.parse(
        await callOk({
          user: BOB,
          path: '/api/v1/sessions',
          method: 'POST',
          json: { agent: { spec: AGENT_SPEC } },
          status: 201,
        }),
      ).data.id;
      const crossProbes = crossReferenceProbes(bobSession);
      const modelRequestsBefore = live().model.requests().length;
      const problems: string[] = [];
      for (const probe of crossProbes) {
        const problem = await refusalProblem(probe);
        if (problem !== undefined) {
          problems.push(`${probe.name}: ${problem}`);
        }
      }
      expect(problems).toEqual([]);
      const seenByModel = live()
        .model.requests()
        .slice(modelRequestsBefore)
        .some(request => JSON.stringify(request.messages).includes(SECRET));
      expect(seenByModel).toBe(false);
    });

    it('lets a member (non-admin) reach no settings route', async () => {
      if (server === undefined) {
        return;
      }
      for (const route of live().routes.filter(r => r.path.startsWith('/api/v1/settings'))) {
        const response = await call({
          user: BOB,
          path: route.path.replace(/:[A-Za-z_]+/g, 'x'),
          method: route.method,
          json: route.method === 'GET' ? undefined : {},
        });
        expect({ route: `${route.method} ${route.path}`, status: response.status }).toEqual({
          route: `${route.method} ${route.path}`,
          status: 403,
        });
      }
      const adminRead = await call({ user: ADMIN_USER, path: '/api/v1/settings/model-providers' });
      expect(adminRead.status).toBe(200);
    });

    it('refuses every route to a caller who is not signed in, except the public ones', async () => {
      if (server === undefined) {
        return;
      }
      const open: string[] = [];
      for (const route of live().routes) {
        const key = `${route.method} ${route.path}`;
        if (PUBLIC_ROUTES.has(key)) {
          continue;
        }
        const response = await live().requestAnonymous({
          path: route.path.replace(/:[A-Za-z_]+/g, 'x'),
          method: route.method,
        });
        await response.text();
        if (![401, 403].includes(response.status)) {
          open.push(`${key} -> ${String(response.status)}`);
        }
      }
      expect(open).toEqual([]);
    });
  });
}

describeRouteOwnership('sqlite');
// Postgres runs where a server is configured, as in the other suites that reach Postgres, and is skipped otherwise.
if (process.env['PG_STORE_TESTS_ADMIN_URL'] !== undefined) {
  describeRouteOwnership('postgres');
}
