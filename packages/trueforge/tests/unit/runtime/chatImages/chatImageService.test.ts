import type { PersistedTurnEvent } from '@truefoundry/trueforge-core/agent-session';
import type { AuditRecordInput } from '@truefoundry/trueforge-core/core';
import { Response as UndiciResponse } from 'undici';

import { ChatImageNotFoundError, createChatImageService } from '../../../../src/runtime/chatImages/chatImageService';
import type { ReencodeOutcome } from '../../../../src/runtime/chatImages/reencodeInSandbox';
import type { TurnImagesResult } from '../../../../src/schemas/chatImages';
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
  '<p>Sale!</p><img src="https://example.com/photo.gif"><img src="https://example.org/banner.png"><img src="cid:logo">';

function setup(options: {
  events?: PersistedTurnEvent[];
  offline?: boolean;
  reencode?: ReencodeOutcome;
  fetchStatus?: number;
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
    },
    turnArtifactStore: artifacts,
    reencode: () => {
      reencodes += 1;
      return Promise.resolve(options.reencode ?? { ok: true, image: { bytes: PNG, type: 'png', width: 3, height: 2 } });
    },
    sentinel: {
      audit: { record: input => Promise.resolve(void audits.push(input)) },
      isOffline: () => Promise.resolve(options.offline ?? false),
      outboundSecrets: () => Promise.resolve([SERVER_HELD_VALUE]),
    },
    fetchDeps: {
      fetchImpl: async (url: unknown) => {
        fetched.push(String(url));
        // Lets parallel requests overlap while their fetches are in flight.
        await new Promise(resolve => setTimeout(resolve, 5));
        const status = options.fetchStatus ?? 200;
        return new UndiciResponse(status === 200 ? PNG : 'gone', { status, headers: { 'content-type': 'image/png' } });
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
      path: 'tool_images/call-1/image-1.png',
      name: 'image-1.png',
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
      tool_images: [{ path: 'tool_images/call-1/image-1.png', name: 'image-1.png' }],
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

describe('uploads across turns', () => {
  const FIRST = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1]);
  const SECOND = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2, 2]);
  const uploadRequest = { source: { kind: 'upload' as const, index: 0 }, approved: false };

  function turnCreatedFor(turnId: string, data: Buffer): PersistedTurnEvent {
    return {
      type: 'turn.created',
      id: `e-${turnId}`,
      turn_id: turnId,
      previous_turn_id: null,
      input: [
        {
          type: 'user.message',
          content: [
            { type: 'text', text: 'look' },
            { type: 'file' as const, name: 'a.png', data: `data:image/png;base64,${data.toString('base64')}` },
          ],
        },
      ],
      state: { status: 'running' },
      created_at: CREATED,
      thread_id: null,
    };
  }

  function setupTwoTurns() {
    const eventsByTurn = new Map<string, PersistedTurnEvent[]>([
      ['t1', [turnCreatedFor('t1', FIRST)]],
      ['t2', [turnCreatedFor('t2', SECOND)]],
    ]);
    const store = new FakeChatImageStore();
    let reencodes = 0;
    const service = createChatImageService({
      store,
      sessionStore: {
        listTurnEvents: input =>
          Promise.resolve({ data: eventsByTurn.get(input.turn_id) ?? [], pagination: { limit: 200 } }),
      },
      turnArtifactStore: new FakeTurnArtifactStore(),
      // Keeps the uploaded bytes, so a test can tell one turn's picture from another's.
      reencode: (input: { bytes: Buffer }) => {
        reencodes += 1;
        return Promise.resolve({ ok: true, image: { bytes: input.bytes, type: 'png', width: 3, height: 2 } });
      },
      sentinel: {
        audit: { record: () => Promise.resolve() },
        isOffline: () => Promise.resolve(false),
        outboundSecrets: () => Promise.resolve([]),
      },
      fetchDeps: {
        fetchImpl: async () =>
          new UndiciResponse(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
        resolveAddresses: () => Promise.resolve([EXAMPLE_COM_ADDRESS]),
      },
    });
    return { service, store, reencodes: () => reencodes };
  }

  function shownImageId(result: TurnImagesResult): string {
    if (result.status !== 'done') {
      throw new Error('expected the images to be shown');
    }
    const image = result.images[0];
    if (image === undefined || image.status !== 'shown') {
      throw new Error('expected a shown image');
    }
    return image.image_id;
  }

  it('shows each turn its own upload when two turns attach a picture at the same position', async () => {
    const env = setupTwoTurns();
    const firstId = shownImageId(await env.service.showTurnImages({ ...ref, request: uploadRequest }));
    const secondId = shownImageId(
      await env.service.showTurnImages({ owner, session_id: 's1', turn_id: 't2', request: uploadRequest }),
    );
    expect(secondId).not.toBe(firstId);
    expect(env.reencodes()).toBe(2);
    expect(env.store.images.size).toBe(2);
    const first = await env.service.getImage({ tenant_id: 'default', session_id: 's1', image_id: firstId });
    const second = await env.service.getImage({ tenant_id: 'default', session_id: 's1', image_id: secondId });
    expect(first?.data).toEqual(FIRST);
    expect(second?.data).toEqual(SECOND);
    expect(second?.turn_id).toBe('t2');
  });

  it('reuses the stored image when the same turn shows its upload again', async () => {
    const env = setupTwoTurns();
    const first = await env.service.showTurnImages({ ...ref, request: uploadRequest });
    const second = await env.service.showTurnImages({ ...ref, request: uploadRequest });
    expect(second).toEqual(first);
    expect(env.reencodes()).toBe(1);
    expect(env.store.images.size).toBe(1);
  });
});

describe('email images', () => {
  const events = [
    modelMessage({ id: 'e1', content: '', calls: [{ id: 'mail-1', name: 'read_email' }] }),
    toolResponse({ id: 'e2', tool_call_id: 'mail-1', result: { messageId: 'm1', bodyHtml: EMAIL_HTML } }),
  ];

  it('always asks first', async () => {
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
    expect(env.fetched).toEqual(['https://example.com/photo.gif', 'https://example.org/banner.png']);
    expect(env.audits.map(row => [row.outcome, row.tool_name, row.description])).toEqual([
      ['approved', 'show_image', 'Downloaded an image: https://example.com/photo.gif'],
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

  it('never offers a tracking pixel an older stored result still lists', async () => {
    const env = setup({
      events: [
        modelMessage({ id: 'e1', content: '', calls: [{ id: 'mail-3', name: 'read_email' }] }),
        toolResponse({
          id: 'e2',
          tool_call_id: 'mail-3',
          result: {
            id: 'm3',
            linked_images: ['https://news.list-manage.com/track/open.php?u=abc', 'https://example.com/art.png'],
          },
        }),
      ],
    });
    await expect(env.service.listTurnImages(ref)).resolves.toMatchObject({
      emails: [{ tool_call_id: 'mail-3', count: 1 }],
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
  const asking = (url: string) => ({ ...ref, request: { source: { kind: 'reply' as const, url }, approved: false } });

  it('never loads a web image a search returned until the person asks', async () => {
    const env = setup({ events: searchEvents(`Here: ![harbor](${returned})`) });
    await expect(env.service.showTurnImages(asking(returned))).resolves.toEqual({
      status: 'ask',
      count: 1,
      host: 'example.com',
    });
    expect(env.fetched).toEqual([]);
    expect(env.audits).toEqual([]);
    expect(env.store.images.size).toBe(0);
  });

  it('loads a web image once the person asks, and records it as approved', async () => {
    const env = setup({ events: searchEvents(`Here: ![harbor](${returned})`) });
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'reply', url: returned }, approved: true } }),
    ).resolves.toMatchObject({ status: 'done', images: [{ status: 'shown' }] });
    expect(env.fetched).toEqual([returned]);
    expect(env.audits).toMatchObject([{ outcome: 'approved', tier: 3 }]);
    expect([...env.store.images.values()][0]?.origin).toBe('remote_approved');
  });

  it('asks for every image a reply links, however many it links', async () => {
    const links = Array.from({ length: 30 }, (_, i) => `https://example.com/p/${String(i)}.png`);
    const env = setup({
      events: [
        modelMessage({
          id: 'e1',
          content: '',
          calls: [{ id: 'search-1', name: 'web_search', silent_search_query: 'p' }],
        }),
        toolResponse({ id: 'e2', tool_call_id: 'search-1', result: { results: links.map(url => ({ url })) } }),
        modelMessage({ id: 'e3', content: links.map(url => `![p](${url})`).join('\n') }),
      ],
    });
    const results = await Promise.all(links.map(url => env.service.showTurnImages(asking(url))));
    expect(results.every(result => result.status === 'ask')).toBe(true);
    expect(env.fetched).toEqual([]);
  });

  it('blocks a link that carries a server secret, even after approval', async () => {
    const leaky = `https://example.com/p.png?k=${SERVER_HELD_VALUE}`;
    const env = setup({ events: [modelMessage({ id: 'e1', content: `![x](${leaky})` })] });
    await expect(env.service.showTurnImages(asking(leaky))).resolves.toMatchObject({ status: 'ask' });
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

  it('shows nothing inline for an email picture the reply copied, and never asks or fetches it', async () => {
    const env = setup({
      events: [
        modelMessage({ id: 'e1', content: '', calls: [{ id: 'mail-1', name: 'read_email' }] }),
        toolResponse({ id: 'e2', tool_call_id: 'mail-1', result: { messageId: 'm1', bodyHtml: EMAIL_HTML } }),
        modelMessage({ id: 'e3', content: 'Your sale email: ![banner](https://example.org/banner.png)' }),
      ],
    });
    await expect(env.service.showTurnImages(asking('https://example.org/banner.png'))).resolves.toEqual({
      status: 'done',
      images: [],
    });
    await expect(
      env.service.showTurnImages({
        ...ref,
        request: { source: { kind: 'reply', url: 'https://example.org/banner.png' }, approved: true },
      }),
    ).resolves.toEqual({ status: 'done', images: [] });
    expect(env.fetched).toEqual([]);
    expect(env.audits).toEqual([]);
  });

  it('never offers a tracking pixel the reply links', async () => {
    const pixel = 'https://u1.ct.sendgrid.net/wf/open?upn=xyz';
    const env = setup({ events: [modelMessage({ id: 'e1', content: `![](${pixel})` })] });
    await expect(env.service.showTurnImages(asking(pixel))).resolves.toEqual({ status: 'done', images: [] });
    expect(env.fetched).toEqual([]);
  });

  it('rejects a link the turn never showed as an image', async () => {
    const env = setup({ events: searchEvents('No images here.') });
    await expect(
      env.service.showTurnImages({ ...ref, request: { source: { kind: 'reply', url: returned }, approved: true } }),
    ).rejects.toBeInstanceOf(ChatImageNotFoundError);
  });
});
