import type { PersistedTurnEvent, TurnRecord } from '@truefoundry/trueforge-core/agent-session';
import type { AuditRecordInput } from '@truefoundry/trueforge-core/core';
import { PRIVATE_DATA_READ_STATE_KEY } from '@truefoundry/trueforge-core/core/capabilities/builtins/PrivateDataRead';
import { Response as UndiciResponse } from 'undici';

import type { TurnCustom } from '../../../../src/db/sessionCustom';
import { ChatImageNotFoundError, createChatImageService } from '../../../../src/runtime/chatImages/chatImageService';
import type { ReencodeOutcome } from '../../../../src/runtime/chatImages/reencodeInSandbox';
import { EXAMPLE_COM_ADDRESS } from '../../../fixtures/exampleComAddress';
import { FakeChatImageStore } from '../../../fixtures/fakeChatImageStore';
import { FakeTurnArtifactStore } from '../../../fixtures/fakeTurnArtifactStore';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
const owner = { tenant_id: 'default', created_by: 'user-a' };
const ref = { owner, session_id: 's1', turn_id: 't1' };
const CREATED = '2026-10-17T00:00:00.000Z';
const SERVER_HELD_VALUE = 'invented-server-held-value';

function turnCreated(fileData: string[]): PersistedTurnEvent {
  return {
    type: 'turn.created',
    id: 'e0',
    turn_id: 't1',
    previous_turn_id: null,
    input: [
      {
        type: 'user.message',
        content: [
          { type: 'text', text: 'look' },
          ...fileData.map(data => ({ type: 'file' as const, name: 'a.png', data })),
        ],
      },
    ],
    state: { status: 'running' },
    created_at: CREATED,
    thread_id: null,
  };
}

function modelMessage(input: {
  id: string;
  content: string;
  calls?: { id: string; name: string; silent_search_query?: string }[];
}): PersistedTurnEvent {
  return {
    type: 'model.message',
    id: input.id,
    thread_id: 'main',
    created_at: CREATED,
    content: input.content,
    ...(input.calls === undefined
      ? {}
      : {
          tool_calls: input.calls.map(call => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: '{}' },
            tool_info: {
              type: 'mcp' as const,
              server_id: 'srv',
              server_name: 'srv',
              name: call.name,
              ...(call.silent_search_query === undefined ? {} : { silent_search_query: call.silent_search_query }),
            },
          })),
        }),
  };
}

function toolResponse(input: { id: string; tool_call_id: string; result: unknown }): PersistedTurnEvent {
  return {
    type: 'tool.response',
    id: input.id,
    thread_id: 'main',
    created_at: CREATED,
    tool_call_id: input.tool_call_id,
    content: JSON.stringify(input.result),
  };
}

const EMAIL_HTML =
  '<p>Sale!</p><img src="https://example.com/pixel.gif"><img src="https://example.org/banner.png"><img src="cid:logo">';

/** A stored turn whose main thread carries the flag the search classifier saves after a mail read. */
function turnWithPrivateRead(): TurnRecord<TurnCustom> {
  return {
    turn_id: 't1',
    session_id: 's1',
    first_turn_id: 't0',
    ancestor_ids: ['t0'],
    previous_turn_id: 't0',
    state: { status: 'running' },
    input: [],
    snapshot: {
      threads: {
        main: {
          thread_id: 'main',
          context: [],
          current_context_usage: { prompt_tokens: 0, completion_tokens: 0 },
          parent: null,
          agent_info: null,
          completion: null,
          capability_state: { [PRIVATE_DATA_READ_STATE_KEY]: true },
          tool_call_memo: undefined,
          task_state: undefined,
        },
      },
      mcp_servers: null,
      sandbox_info: null,
    },
    created_at: new Date(CREATED),
    updated_at: new Date(CREATED),
    custom: null,
  };
}

function setup(options: {
  events?: PersistedTurnEvent[];
  storedTurn?: TurnRecord<TurnCustom>;
  offline?: boolean;
  searchWithoutAsking?: boolean;
  reencode?: ReencodeOutcome;
}) {
  const events = options.events ?? [];
  const store = new FakeChatImageStore();
  const artifacts = new FakeTurnArtifactStore();
  const audits: AuditRecordInput[] = [];
  const fetched: string[] = [];
  let reencodes = 0;
  const service = createChatImageService({
    store,
    sessionStore: {
      listTurnEvents: () => Promise.resolve({ data: events, pagination: { limit: 200 } }),
      getTurn: () => Promise.resolve(options.storedTurn),
    },
    turnArtifactStore: artifacts,
    reencode: () => {
      reencodes += 1;
      return Promise.resolve(options.reencode ?? { ok: true, image: { bytes: PNG, type: 'png', width: 3, height: 2 } });
    },
    sentinel: {
      audit: { record: input => Promise.resolve(void audits.push(input)) },
      isOffline: () => Promise.resolve(options.offline ?? false),
      searchWithoutAsking: () => Promise.resolve(options.searchWithoutAsking ?? true),
      outboundSecrets: () => Promise.resolve([SERVER_HELD_VALUE]),
    },
    fetchDeps: {
      fetchImpl: async (url: unknown) => {
        fetched.push(String(url));
        return new UndiciResponse(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      },
      resolveAddresses: () => Promise.resolve([EXAMPLE_COM_ADDRESS]),
    },
  });
  return { service, store, artifacts, audits, fetched, reencodes: () => reencodes };
}

describe('local images', () => {
  it('re-encodes an upload once and reuses the stored image', async () => {
    const env = setup({ events: [turnCreated([`data:image/png;base64,${PNG.toString('base64')}`])] });
    const request = { source: { kind: 'upload' as const, index: 0 }, approved: false };
    const first = await env.service.showTurnImages({ ...ref, request });
    const second = await env.service.showTurnImages({ ...ref, request });
    expect(first).toEqual({ status: 'done', images: [expect.objectContaining({ status: 'shown', width: 3 })] });
    expect(second).toEqual(first);
    expect(env.reencodes()).toBe(1);
    expect([...env.store.images.values()][0]).toMatchObject({ origin: 'local', mime: 'image/png' });
  });

  it('never asks and never touches the network for a local image', async () => {
    const env = setup({ events: [turnCreated([`data:image/png;base64,${PNG.toString('base64')}`])] });
    await env.service.showTurnImages({ ...ref, request: { source: { kind: 'upload', index: 0 }, approved: false } });
    expect(env.fetched).toEqual([]);
    expect(env.audits).toEqual([]);
  });

  it('passes a sandbox refusal through', async () => {
    const env = setup({
      events: [turnCreated([`data:image/png;base64,${PNG.toString('base64')}`])],
      reencode: { ok: false, reason: 'sandbox_unavailable' },
    });
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'upload', index: 0 }, approved: false } }),
    ).resolves.toEqual({ status: 'done', images: [{ status: 'refused', reason: 'sandbox_unavailable' }] });
  });

  it('rejects an attachment index the turn does not have', async () => {
    const env = setup({ events: [turnCreated([])] });
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'upload', index: 3 }, approved: false } }),
    ).rejects.toBeInstanceOf(ChatImageNotFoundError);
  });

  it('shows a stored sandbox image and lists the turn images', async () => {
    const env = setup({
      events: [
        modelMessage({ id: 'e1', content: '', calls: [{ id: 'mail-1', name: 'read_email' }] }),
        toolResponse({ id: 'e2', tool_call_id: 'mail-1', result: { messageId: 'm1', bodyHtml: EMAIL_HTML } }),
      ],
    });
    await env.artifacts.recordStoredArtifact({
      tenant_id: 'default',
      session_id: 's1',
      turn_id: 't1',
      path: 'run_code/chart.png',
      name: 'chart.png',
      data: PNG,
      mime: 'application/octet-stream',
    });
    await env.artifacts.recordStoredArtifact({
      tenant_id: 'default',
      session_id: 's1',
      turn_id: 't1',
      path: 'run_code/data.csv',
      name: 'data.csv',
      data: Buffer.from('a,b'),
      mime: 'application/octet-stream',
    });
    await expect(env.service.listTurnImages(ref)).resolves.toEqual({
      artifacts: [{ path: 'run_code/chart.png', name: 'chart.png' }],
      emails: [{ tool_call_id: 'mail-1', count: 2 }],
    });
    await expect(
      env.service.showTurnImages({
        ...ref,
        request: { source: { kind: 'artifact', path: 'run_code/chart.png' }, approved: false },
      }),
    ).resolves.toMatchObject({ status: 'done', images: [{ status: 'shown' }] });
  });
});

describe('email images', () => {
  const events = [
    modelMessage({ id: 'e1', content: '', calls: [{ id: 'mail-1', name: 'read_email' }] }),
    toolResponse({ id: 'e2', tool_call_id: 'mail-1', result: { messageId: 'm1', bodyHtml: EMAIL_HTML } }),
  ];

  it('always asks first, even when searches run without asking', async () => {
    const env = setup({ events });
    await expect(
      env.service.showTurnImages({
        ...ref,
        request: { source: { kind: 'email', tool_call_id: 'mail-1' }, approved: false },
      }),
    ).resolves.toEqual({ status: 'ask', count: 2, host: null });
    expect(env.fetched).toEqual([]);
  });

  it('downloads each linked image once approved, with an audit row per download', async () => {
    const env = setup({ events });
    const result = await env.service.showTurnImages({
      ...ref,
      request: { source: { kind: 'email', tool_call_id: 'mail-1' }, approved: true },
    });
    expect(result).toMatchObject({ status: 'done', images: [{ status: 'shown' }, { status: 'shown' }] });
    expect(env.fetched).toEqual(['https://example.com/pixel.gif', 'https://example.org/banner.png']);
    expect(env.audits.map(row => [row.outcome, row.tool_name, row.description])).toEqual([
      ['approved', 'show_image', 'Downloaded an image: https://example.com/pixel.gif'],
      ['approved', 'show_image', 'Downloaded an image: https://example.org/banner.png'],
    ]);
    expect([...env.store.images.values()].every(image => image.origin === 'remote_approved')).toBe(true);
  });

  it('refuses while offline without any request', async () => {
    const env = setup({ events, offline: true });
    const result = await env.service.showTurnImages({
      ...ref,
      request: { source: { kind: 'email', tool_call_id: 'mail-1' }, approved: true },
    });
    expect(result).toEqual({
      status: 'done',
      images: [
        { status: 'refused', reason: 'offline' },
        { status: 'refused', reason: 'offline' },
      ],
    });
    expect(env.fetched).toEqual([]);
  });

  it('reads the linked images the Gmail tools list', async () => {
    const env = setup({
      events: [
        modelMessage({ id: 'e1', content: '', calls: [{ id: 'mail-2', name: 'read_email' }] }),
        toolResponse({
          id: 'e2',
          tool_call_id: 'mail-2',
          result: { id: 'm2', linked_images: ['https://example.com/logo.png', 'javascript:alert(1)'] },
        }),
      ],
    });
    await expect(env.service.listTurnImages(ref)).resolves.toMatchObject({
      emails: [{ tool_call_id: 'mail-2', count: 1 }],
    });
  });

  it('rejects a tool call that is not an email read of this turn', async () => {
    const env = setup({ events });
    await expect(
      env.service.showTurnImages({
        ...ref,
        request: { source: { kind: 'email', tool_call_id: 'other' }, approved: true },
      }),
    ).rejects.toBeInstanceOf(ChatImageNotFoundError);
  });
});

describe('reply images', () => {
  const returned = 'https://example.com/photos/harbor.png';
  const searchEvents = (reply: string) => [
    modelMessage({
      id: 'e1',
      content: '',
      calls: [{ id: 'search-1', name: 'web_search', silent_search_query: 'harbor' }],
    }),
    toolResponse({ id: 'e2', tool_call_id: 'search-1', result: { results: [{ url: returned }] } }),
    modelMessage({ id: 'e3', content: reply }),
  ];

  it('loads silently where a search would be silent, and records it', async () => {
    const env = setup({ events: searchEvents(`Here: ![harbor](${returned})`) });
    const result = await env.service.showTurnImages({
      ...ref,
      request: { source: { kind: 'reply', url: returned }, approved: false },
    });
    expect(result).toMatchObject({ status: 'done', images: [{ status: 'shown' }] });
    expect(env.fetched).toEqual([returned]);
    expect(env.audits).toMatchObject([{ outcome: 'ran', tier: 1 }]);
    expect([...env.store.images.values()][0]?.origin).toBe('remote_silent');
  });

  it('asks once this turn read mail, as a search would', async () => {
    const events = [
      modelMessage({ id: 'e0', content: '', calls: [{ id: 'mail-0', name: 'read_email' }] }),
      ...searchEvents(`![harbor](${returned})`),
    ];
    const env = setup({ events });
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'reply', url: returned }, approved: false } }),
    ).resolves.toMatchObject({ status: 'ask' });
    expect(env.fetched).toEqual([]);
  });

  it('asks once an earlier turn of the chat read mail', async () => {
    const env = setup({ events: searchEvents(`![harbor](${returned})`), storedTurn: turnWithPrivateRead() });
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'reply', url: returned }, approved: false } }),
    ).resolves.toMatchObject({ status: 'ask' });
  });

  it('asks for a link no search returned', async () => {
    const other = 'https://example.org/elsewhere.png';
    const env = setup({ events: searchEvents(`![x](${other})`) });
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'reply', url: other }, approved: false } }),
    ).resolves.toEqual({ status: 'ask', count: 1, host: 'example.org' });
    expect(env.fetched).toEqual([]);
  });

  it('asks when searches are set to ask', async () => {
    const env = setup({ events: searchEvents(`![x](${returned})`), searchWithoutAsking: false });
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'reply', url: returned }, approved: false } }),
    ).resolves.toMatchObject({ status: 'ask' });
  });

  it('asks when the outbound guard trips, and blocks a server secret even after approval', async () => {
    const leaky = `https://example.com/p.png?k=${SERVER_HELD_VALUE}`;
    const env = setup({ events: [modelMessage({ id: 'e1', content: `![x](${leaky})` })] });
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'reply', url: leaky }, approved: false } }),
    ).resolves.toMatchObject({ status: 'ask' });
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'reply', url: leaky }, approved: true } }),
    ).resolves.toEqual({ status: 'done', images: [{ status: 'refused', reason: 'blocked' }] });
    expect(env.fetched).toEqual([]);
    expect(env.audits).toEqual([
      expect.objectContaining({ outcome: 'auto_denied', description: 'Blocked an image from example.com' }),
    ]);
  });

  it('lets an approved link with a long token through the guard', async () => {
    const tracked = 'https://example.org/i/6f1c2a9b8e7d6c5b4a39281706f5e4d3.png';
    const env = setup({ events: [modelMessage({ id: 'e1', content: `![x](${tracked})` })] });
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'reply', url: tracked }, approved: true } }),
    ).resolves.toMatchObject({ status: 'done', images: [{ status: 'shown' }] });
    expect(env.audits).toMatchObject([{ outcome: 'approved', tier: 3 }]);
  });

  it('asks once the turn has shown its silent allowance', async () => {
    const env = setup({ events: searchEvents(`![x](${returned})`) });
    for (let i = 0; i < 20; i += 1) {
      await env.store.putImage({
        ...owner,
        session_id: 's1',
        turn_id: 't1',
        image_id: String(i).padStart(32, '0'),
        source_key: `reply:${String(i)}`,
        origin: 'remote_silent',
        mime: 'image/png',
        width: 1,
        height: 1,
        data: PNG,
        user_max_bytes: 1e9,
      });
    }
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'reply', url: returned }, approved: false } }),
    ).resolves.toMatchObject({ status: 'ask' });
  });

  it('rejects a link the turn never showed as an image', async () => {
    const env = setup({ events: searchEvents('No images here.') });
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'reply', url: returned }, approved: true } }),
    ).rejects.toBeInstanceOf(ChatImageNotFoundError);
  });
});
