import { OpenAPIHono } from '@hono/zod-openapi';
import { InMemorySessionStore } from '@truefoundry/trueforge-core/agent-session';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import winston from 'winston';
import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeTurnCreatedEvent,
  makeTurnDoneEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';
import { createMemoryVaultReviewRouter } from '../../../src/apis/memoryVaultReview';
import type { RequestContext } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { MarkdownMemoryClient } from '../../../src/runtime/memory/markdownMemoryClient';

const ALICE: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'alice', type: 'user', display_name: 'alice' },
  roles: [],
  user_credential: null,
};

const SAVED_AT = '2026-10-02T10:00:00.000Z';
const NOTE = ['## ' + SAVED_AT, 'Likes tea.', '<!-- session_id: chat-1 -->', '> External source: no record'].join(
  '\n\n',
);
const ID = 'md:default:2026-10-02.md#0';
const BASE = '/api/v1/memory/vault/review';

describe('the review of older notes', () => {
  const originalDir = configuration.MEMORY_MARKDOWN_DIR;
  let baseDir: string;
  let app: OpenAPIHono;

  async function writeVault(namespace: string, notes: string[]): Promise<void> {
    const dir = path.join(baseDir, namespace, 'memory');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '2026-10-02.md'), `${notes.map(note => `${note}\n`).join('\n')}\n`, 'utf8');
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'vault-review-'));
    configuration.MEMORY_MARKDOWN_DIR = baseDir;
    await writeFile(path.join(baseDir, '.source-lines.json'), '{"done":true}\n', 'utf8');
    const store = new InMemorySessionStore<SessionCustom, TurnCustom>();
    await store.createSession({
      tenant_id: 'default',
      session_id: 'chat-1',
      created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
      is_incognito: false,
      private_expires_at: null,
    });
    await store.createTurn(
      makeCreateTurnInput<TurnCustom>({
        sessionId: 'chat-1',
        turnId: 't1',
        update_session_title_if_not_exist: 'Tea chat',
      }),
    );
    await store.appendToEvents({ session_id: 'chat-1', turn_id: 't1', events: [makeTurnCreatedEvent('t1')] });
    const state = { status: 'done' as const, output: null, required_actions: [], completed_at: SAVED_AT };
    await store.updateTurnState({
      session_id: 'chat-1',
      turn_id: 't1',
      state,
      turn_done_event: makeTurnDoneEvent(state),
    });
    app = new OpenAPIHono();
    app.route(
      '/api/v1/memory/vault',
      createMemoryVaultReviewRouter({
        resolveRequestContext: () => ALICE,
        logger: winston.createLogger({ silent: true }),
        sessionStore: store,
      }),
    );
    await writeVault('default', [NOTE]);
  });

  afterEach(async () => {
    configuration.MEMORY_MARKDOWN_DIR = originalDir;
    await rm(baseDir, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    app.request(BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('lists the notes that qualify and changes nothing', async () => {
    const response = await app.request(BASE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        notes: [
          {
            entry_id: ID,
            day: '2026-10-02',
            text: 'Likes tea.\n\n> External source: no record',
            chat_title: 'Tea chat',
          },
        ],
        note_count: 1,
        next_cursor: null,
      },
    });
    expect((await app.request(BASE)).status).toBe(200);
  });

  it('marks only the ids it was sent, and recall then reads the note as the person’s own', async () => {
    const response = await post({ entry_ids: [ID] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { marked_count: 1, marked_ids: [ID], refused: [] } });
    const client = new MarkdownMemoryClient({ baseDir, namespace: 'default' });
    const recalled = await client.recall({
      query: 'tea',
      maxTokens: 2_000,
      timeoutMs: 5_000,
    });
    expect(recalled.ok && recalled.results.map(item => item.metadata?.['origin'])).toEqual(['user_stated']);
    expect(await (await app.request(BASE)).json()).toMatchObject({ data: { notes: [] } });
  });

  it('marks nothing without ids and nothing by itself', async () => {
    expect((await post({ entry_ids: [] })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('refuses an id that is not a current candidate, with a reason in plain words', async () => {
    await writeVault('default', [NOTE, NOTE.replace('chat-1', 'chat-gone')]);
    const response = await post({ entry_ids: ['md:default:2026-10-02.md#1', 'md:default:2026-10-02.md#7'] });
    const body: unknown = await response.json();
    expect(body).toEqual({
      data: {
        marked_count: 0,
        marked_ids: [],
        refused: [
          {
            entry_id: 'md:default:2026-10-02.md#1',
            reason: 'Its chat is gone or cannot be read, so it stays external.',
          },
          { entry_id: 'md:default:2026-10-02.md#7', reason: 'This note is no longer there. Reload the list.' },
        ],
      },
    });
  });

  it('refuses more than 200 ids in one call', async () => {
    const ids = Array.from({ length: 201 }, (_unused, index) => `md:default:2026-10-02.md#${String(index)}`);
    expect((await post({ entry_ids: ids })).status).toBe(400);
  });

  it('refuses the ids of another vault', async () => {
    await writeVault('default__persona_Maya', [NOTE]);
    const response = await post({ entry_ids: ['md:default__persona_Maya:2026-10-02.md#0'] });
    expect(await response.json()).toMatchObject({ data: { marked_count: 0 } });
    const other = await post({ namespace: 'persona:Maya', entry_ids: [ID] });
    expect(await other.json()).toMatchObject({ data: { marked_count: 0 } });
  });
});
