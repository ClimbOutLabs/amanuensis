import { OpenAPIHono } from '@hono/zod-openapi';
import type { AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import { AgentSpecSchema, SessionHandle, Sessions, TurnHandle } from '@truefoundry/trueforge-core/agent-session';
import { SandboxNotAvailableError, type SandboxProvider } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';
import { createTurnsRouter, toContentDisposition } from '../../../src/apis/turns';
import { TrueForgeAuthorizer } from '../../../src/auth/authorizer';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteRepositoryStore } from '../../../src/db/sqlite/repository-store/SqliteRepositoryStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteSpaceStore } from '../../../src/db/sqlite/space-store/SqliteSpaceStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { SqliteTurnArtifactStore } from '../../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { buildRunCodeHarvestSink } from '../../../src/runtime/artifacts/persistRunCodeHarvests';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { FakeSandboxProvider } from '../../fixtures/fakeSandboxProvider';

/** Parsed rather than built literally, so config defaults match what the create route stores. */
function agentSpec(): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: 'openai/gpt-4o' },
    config: { sandbox: { enabled: true } },
  });
}

async function buildApp(options?: { sandboxProvider?: SandboxProvider | undefined }) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const sessionStore = new SqliteSessionStore(db);
  const sessions = new Sessions<SessionCustom, TurnCustom>({ sessionStore });
  const tokenStore = new SqliteOAuthTokenStore(db);
  const turnArtifactStore = new SqliteTurnArtifactStore(db);
  const app = new OpenAPIHono();

  app.route(
    '/',
    createTurnsRouter({
      mcpCatalog: McpCatalog.load(),
      globalSettingsStore: new SqliteGlobalSettingsStore(db),
      sessions,
      sessionStore,
      activeTurns: new ActiveTurnRegistry(),
      turnDrains: new TurnDrainRegistry(),
      resolveModelProviderStore: () => new SqliteModelProviderStore(db),
      resolveMcpServerStore: () =>
        new McpServerWithAuthStore({
          store: new SqliteMcpServerStore(db),
          tokenStore,
          clientName: 'test-client',
        }),
      tokenStore,
      resolveSkillStore: () => new SqliteSkillStore(db),
      resolveAgentStore: () => new SqliteAgentStore(db),
      personalizationStore: new SqlitePersonalizationStore(db),
      personaStore: new SqlitePersonaStore(db),
      spaceStore: new SqliteSpaceStore(db),
      repositoryStore: new SqliteRepositoryStore(db),
      turnArtifactStore,
      eventSubscriptions: new EventSubscriptionRegistry(undefined),
      resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
      sandboxProviderResolver:
        options?.sandboxProvider === undefined ? undefined : () => Promise.resolve(options.sandboxProvider),
      logger: createLogger({ silent: true }),
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
      authorizer: new TrueForgeAuthorizer(),
    }),
  );

  return { app, sessions, sessionStore, turnArtifactStore };
}

/**
 * Creates a session and gives it one turn whose snapshot already carries `sandbox_info`, without
 * running a real turn: `Sessions.get` is scripted to hand back a `SessionHandle` whose
 * `getTurn` resolves to a `TurnHandle` built straight from the record (the same technique
 * `turns.test.ts`'s `scriptedSessions` uses). The route reads `session.record` and
 * `turn.record.snapshot` exactly as it would from a real session, so this only fakes *how* the
 * record was produced, not its shape.
 */
async function createSessionWithSandboxTurn(params: {
  sessionStore: SqliteSessionStore;
  sessions: Sessions<SessionCustom, TurnCustom>;
  sessionId: string;
  turnId: string;
  sandboxId: string | null;
}): Promise<void> {
  await params.sessionStore.createSession({
    tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
    session_id: params.sessionId,
    created_by_subject: {
      subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
      subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
      subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
    },
    agent: { type: 'inline', spec: agentSpec() },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  const record = await params.sessionStore.getSession({
    tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
    session_id: params.sessionId,
  });
  if (record === undefined) {
    throw new Error(`test session ${params.sessionId} was never created`);
  }
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const turn = TurnHandle.fromRecord<TurnCustom>({
    store: params.sessionStore,
    turn: {
      turn_id: params.turnId,
      session_id: params.sessionId,
      first_turn_id: params.turnId,
      ancestor_ids: [],
      previous_turn_id: null,
      state: { status: 'done', output: null, required_actions: [], completed_at: createdAt.toISOString() },
      input: [],
      snapshot: {
        threads: {},
        mcp_servers: null,
        sandbox_info: params.sandboxId === null ? null : { sandbox_id: params.sandboxId },
      },
      created_at: createdAt,
      updated_at: createdAt,
      custom: null,
    },
  });
  const handle = new SessionHandle<SessionCustom, TurnCustom>({ store: params.sessionStore, session: record });
  jest.spyOn(handle, 'getTurn').mockResolvedValue(turn);
  jest.spyOn(params.sessions, 'get').mockResolvedValue(handle);
}

function downloadUrl({
  sessionId,
  turnId = 'turn-1',
  path,
}: {
  sessionId: string;
  turnId?: string;
  path: string;
}): string {
  return `http://localhost/${sessionId}/turns/${turnId}/download-sandbox-file?path=${encodeURIComponent(path)}`;
}

describe('GET /{session_id}/turns/{turn_id}/download-sandbox-file', () => {
  it('rejects a malformed path before touching the session', async () => {
    const { app } = await buildApp();

    for (const path of [
      '../etc/passwd',
      '/a/../../etc/passwd',
      '/tmp/nul\0.txt',
      `/tmp/${'a'.repeat(300)}`,
      `/${'a/'.repeat(3000)}b`,
    ]) {
      const response = await app.request(downloadUrl({ sessionId: 'missing', path }));

      expect(response.status).toBe(400);
    }
  });

  it('accepts a path relative to the sandbox working directory', async () => {
    const { app } = await buildApp();

    const response = await app.request(downloadUrl({ sessionId: 'missing', path: 'report.pdf' }));

    expect(response.status).toBe(404);
  });

  // PATH_MAX counts the terminating NUL, so 4096 is already too long for the kernel and must be
  // rejected here rather than reaching the provider as an opaque backend failure.
  it('rejects a path at PATH_MAX but allows one byte shorter', async () => {
    const { app } = await buildApp();
    // Short segments so the length that trips is the whole path, not NAME_MAX.
    const pathOfLength = (length: number) => {
      let path = '/tmp';
      while (path.length < length) path += `/${'a'.repeat(Math.min(50, length - path.length - 1))}`;
      return path.slice(0, length);
    };

    expect((await app.request(downloadUrl({ sessionId: 'missing', path: pathOfLength(4096) }))).status).toBe(400);
    // Not 400: the shape is fine, so it fails later on the session lookup instead.
    expect((await app.request(downloadUrl({ sessionId: 'missing', path: pathOfLength(4095) }))).status).toBe(404);
  });

  it('returns 404 for an unknown session', async () => {
    const { app } = await buildApp();

    const response = await app.request(downloadUrl({ sessionId: 'missing', path: '/workspace/report.pdf' }));

    expect(response.status).toBe(404);
  });

  it('returns 404 for a turn that does not exist in the session', async () => {
    const { app, sessions } = await buildApp();
    const session = await sessions.create({
      tenant_id: 'default',
      session_id: 'no-turn',
      created_by_subject: {
        subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
        subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
        subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
      },
      agent: { type: 'inline', spec: agentSpec() },
      external_id: null,
    });

    const response = await app.request(downloadUrl({ sessionId: session.session_id, path: '/workspace/report.pdf' }));

    expect(response.status).toBe(404);
  });

  it('serves the persisted copy when one exists, without touching the sandbox provider', async () => {
    const provider = new FakeSandboxProvider(new Map()); // any downloadFile call here would 404 and fail the test
    const { app, sessions, sessionStore, turnArtifactStore } = await buildApp({ sandboxProvider: provider });
    await createSessionWithSandboxTurn({
      sessionStore,
      sessions,
      sessionId: 's1',
      turnId: 'turn-1',
      sandboxId: 'sbx-1',
    });
    const data = Buffer.from('the finished tribute video');
    await turnArtifactStore.recordStoredArtifact({
      tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
      session_id: 's1',
      turn_id: 'turn-1',
      path: '/opt/tf/workspace/tribute.mp4',
      name: 'tribute.mp4',
      data,
      mime: 'application/octet-stream',
    });

    const response = await app.request(downloadUrl({ sessionId: 's1', path: '/opt/tf/workspace/tribute.mp4' }));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    expect(response.headers.get('content-length')).toBe(String(data.length));
  });

  it('falls back to the live sandbox when no persisted artifact exists for the turn/path', async () => {
    const data = Buffer.from('fresh from the sandbox');
    const provider = new FakeSandboxProvider(new Map([['/workspace/live.txt', data]]));
    const { app, sessions, sessionStore } = await buildApp({ sandboxProvider: provider });
    await createSessionWithSandboxTurn({
      sessionStore,
      sessions,
      sessionId: 's1',
      turnId: 'turn-1',
      sandboxId: 'sbx-1',
    });

    const response = await app.request(downloadUrl({ sessionId: 's1', path: '/workspace/live.txt' }));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
  });

  it('returns 413 with a clear reason for a file that was skipped for size, without calling the sandbox', async () => {
    const provider = new FakeSandboxProvider(new Map());
    const { app, sessions, sessionStore, turnArtifactStore } = await buildApp({ sandboxProvider: provider });
    await createSessionWithSandboxTurn({
      sessionStore,
      sessions,
      sessionId: 's1',
      turnId: 'turn-1',
      sandboxId: 'sbx-1',
    });
    await turnArtifactStore.recordSkippedArtifact({
      tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
      session_id: 's1',
      turn_id: 'turn-1',
      path: '/tmp/huge.bin',
      name: 'huge.bin',
      status: 'skipped_size',
      skip_reason: 'File too large: /tmp/huge.bin (30000000 bytes, max 26214400)',
      size: 30_000_000,
    });

    const response = await app.request(downloadUrl({ sessionId: 's1', path: '/tmp/huge.bin' }));

    expect(response.status).toBe(413);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: { message: 'This file was not kept: File too large: /tmp/huge.bin (30000000 bytes, max 26214400)' },
    });
  });

  it('says what happened, not "sandbox unavailable", when no persisted copy exists and the sandbox is gone', async () => {
    const provider = new FakeSandboxProvider(new Map([['/tmp/gone.txt', new SandboxNotAvailableError('sbx-1')]]));
    const { app, sessions, sessionStore } = await buildApp({ sandboxProvider: provider });
    await createSessionWithSandboxTurn({
      sessionStore,
      sessions,
      sessionId: 's1',
      turnId: 'turn-1',
      sandboxId: 'sbx-1',
    });

    const response = await app.request(downloadUrl({ sessionId: 's1', path: '/tmp/gone.txt' }));

    expect(response.status).toBe(410);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: {
        message:
          'This file was not kept: the sandbox was stopped after this turn finished, and no persisted copy was found for this file.',
      },
    });
  });

  it('uses the skipped_missing reason when the sandbox is also gone for a file it never had', async () => {
    const provider = new FakeSandboxProvider(
      new Map([['/tmp/never-there.txt', new SandboxNotAvailableError('sbx-1')]]),
    );
    const { app, sessions, sessionStore, turnArtifactStore } = await buildApp({ sandboxProvider: provider });
    await createSessionWithSandboxTurn({
      sessionStore,
      sessions,
      sessionId: 's1',
      turnId: 'turn-1',
      sandboxId: 'sbx-1',
    });
    await turnArtifactStore.recordSkippedArtifact({
      tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
      session_id: 's1',
      turn_id: 'turn-1',
      path: '/tmp/never-there.txt',
      name: 'never-there.txt',
      status: 'skipped_missing',
      skip_reason: 'File not found: /tmp/never-there.txt',
    });

    const response = await app.request(downloadUrl({ sessionId: 's1', path: '/tmp/never-there.txt' }));

    expect(response.status).toBe(410);
    const body: unknown = await response.json();
    expect(body).toEqual({ error: { message: 'This file was not kept: File not found: /tmp/never-there.txt' } });
  });
});

describe('GET /{session_id}/turns/{turn_id}/artifacts', () => {
  function artifactsUrl({ sessionId, turnId = 'turn-1' }: { sessionId: string; turnId?: string }): string {
    return `http://localhost/${sessionId}/turns/${turnId}/artifacts`;
  }

  it('lists run_code harvests under their run_code/<name> paths, newest first', async () => {
    const { app, sessions, sessionStore, turnArtifactStore } = await buildApp();
    await createSessionWithSandboxTurn({
      sessionStore,
      sessions,
      sessionId: 's1',
      turnId: 'turn-1',
      sandboxId: 'sbx-1',
    });
    const sink = buildRunCodeHarvestSink({
      store: turnArtifactStore,
      tenantId: STANDALONE_REQUEST_CONTEXT.tenant_id,
      sessionId: 's1',
      turnId: 'turn-1',
      logger: createLogger({ silent: true }),
    });
    const plot = Buffer.from('fake png bytes');
    await sink([{ name: 'plot.png', bytes: plot, size_bytes: plot.length, sha256: 'x' }]);

    const response = await app.request(artifactsUrl({ sessionId: 's1' }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { path: string; name: string; status: string; size: number | null }[];
    };
    expect(body.data.map(row => row.path)).toEqual(['run_code/plot.png']);
    expect(body.data[0]).toMatchObject({ name: 'plot.png', status: 'stored', size: plot.length });
  });

  it('returns an empty list for a turn with no persisted artifacts', async () => {
    const { app, sessions, sessionStore } = await buildApp();
    await createSessionWithSandboxTurn({
      sessionStore,
      sessions,
      sessionId: 's1',
      turnId: 'turn-1',
      sandboxId: 'sbx-1',
    });

    // The harness mock returns the scripted turn for any turn id; the store
    // lookup still uses the requested id, so an artifact-less turn lists empty.
    const response = await app.request(artifactsUrl({ sessionId: 's1', turnId: 'nope' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [] });
  });
});

describe('run_code harvest download journey', () => {
  it('serves sink-persisted bytes through the download route at the run_code/<name> path', async () => {
    const provider = new FakeSandboxProvider(new Map()); // any live-sandbox read here would fail the test
    const { app, sessions, sessionStore, turnArtifactStore } = await buildApp({ sandboxProvider: provider });
    await createSessionWithSandboxTurn({
      sessionStore,
      sessions,
      sessionId: 's1',
      turnId: 'turn-1',
      sandboxId: 'sbx-1',
    });
    const data = Buffer.from('fake png bytes');
    const sink = buildRunCodeHarvestSink({
      store: turnArtifactStore,
      tenantId: STANDALONE_REQUEST_CONTEXT.tenant_id,
      sessionId: 's1',
      turnId: 'turn-1',
      logger: createLogger({ silent: true }),
    });
    await sink([{ name: 'plot.png', bytes: data, size_bytes: data.length, sha256: 'x' }]);

    const response = await app.request(downloadUrl({ sessionId: 's1', path: 'run_code/plot.png' }));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    expect(response.headers.get('content-disposition')).toContain('plot.png');
  });
});

describe('toContentDisposition', () => {
  it('names the file after the last path segment', () => {
    expect(toContentDisposition('/workspace/out/report.pdf')).toBe(`attachment; filename*=UTF-8''report.pdf`);
  });

  it('falls back when the path has no usable segment', () => {
    expect(toContentDisposition('/')).toBe(`attachment; filename*=UTF-8''download`);
  });

  it('percent-encodes a name that cannot be written into a header directly', () => {
    expect(toContentDisposition('/w/中文.csv')).toBe(`attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.csv`);
  });

  it('encodes the characters RFC 5987 disallows but encodeURIComponent keeps', () => {
    expect(toContentDisposition(`/w/quote'(1)*.txt`)).toBe(`attachment; filename*=UTF-8''quote%27%281%29%2A.txt`);
  });

  it('produces a header the Response constructor accepts for any name', () => {
    for (const path of ['/w/中文报告.csv', '/w/emoji-🎉.txt', '/w/a\r\nX-Injected: 1.txt', '/w/a"b\\c.txt']) {
      const header = toContentDisposition(path);

      expect(new Response('x', { headers: { 'Content-Disposition': header } }).headers.get('content-disposition')).toBe(
        header,
      );
    }
  });
});
