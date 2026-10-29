import type { PersistedTurnEvent } from '@truefoundry/trueforge-core/agent-session';
import { Response as UndiciResponse } from 'undici';

import {
  createChatPictureService,
  type ChatPictureOutcome,
} from '../../../../src/runtime/chatPictures/chatPictureService';
import { EXAMPLE_COM_ADDRESS } from '../../../fixtures/exampleComAddress';

const SESSION_ID = 'session-1';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const FOX = 'https://upload.wikimedia.org/wikipedia/commons/3/3c/Red_Fox.jpg';
const OTHER = 'https://upload.wikimedia.org/wikipedia/commons/4/4d/Invented_Fox.jpg';
const CREATED = '2026-10-21T00:00:00.000Z';

function modelMessage(input: {
  id: string;
  content: string;
  calls?: { id: string; name: string }[];
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

function service(events: PersistedTurnEvent[]) {
  const seen: string[] = [];
  const fetchImpl = async (url: unknown): Promise<UndiciResponse> => {
    seen.push(String(url));
    return new UndiciResponse(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const pictures = createChatPictureService({
    sessionStore: {
      listSessionEvents: () =>
        Promise.resolve({ data: events.map(event => ({ turn_id: 'turn-1', event })), pagination: { limit: 200 } }),
    },
    fetchDeps: { fetchImpl, resolveAddresses: () => Promise.resolve([EXAMPLE_COM_ADDRESS]) },
    now: () => 0,
  });
  const get = (url: string): Promise<ChatPictureOutcome> => pictures.get({ session_id: SESSION_ID, url });
  return { seen, get };
}

describe('chat picture service', () => {
  it('serves a picture from a search result in this chat, and keeps it briefly in memory', async () => {
    const { seen, get } = service([
      modelMessage({ id: 'm1', content: '', calls: [{ id: 'c1', name: 'web_search' }] }),
      toolResponse({ id: 't1', tool_call_id: 'c1', result: { results: [{ title: 'Red Fox', url: FOX }] } }),
    ]);
    await expect(get(FOX)).resolves.toEqual({ status: 'shown', bytes: PNG, mime: 'image/png' });
    await expect(get(FOX)).resolves.toEqual({ status: 'shown', bytes: PNG, mime: 'image/png' });
    expect(seen).toEqual([FOX]);
  });

  it('serves a picture a search result listed, though no result link named the file', async () => {
    const { seen, get } = service([
      modelMessage({ id: 'm1', content: '', calls: [{ id: 'c1', name: 'web_search' }] }),
      toolResponse({
        id: 't1',
        tool_call_id: 'c1',
        result: { results: [{ title: 'Red Fox', url: 'https://example.com/foxes', images: [{ url: FOX }] }] },
      }),
    ]);
    await expect(get(FOX)).resolves.toEqual({ status: 'shown', bytes: PNG, mime: 'image/png' });
    expect(seen).toEqual([FOX]);
  });

  it('serves a picture from a page the chat opened, though no result named the file', async () => {
    const { seen, get } = service([
      modelMessage({ id: 'm1', content: '', calls: [{ id: 'c1', name: 'web_fetch' }] }),
      toolResponse({ id: 't1', tool_call_id: 'c1', result: `# File:Red Fox.jpg\n<img src="${FOX}" alt="Red fox">` }),
    ]);
    await expect(get(FOX)).resolves.toEqual({ status: 'shown', bytes: PNG, mime: 'image/png' });
    expect(seen).toEqual([FOX]);
  });

  it('serves a picture the reply itself showed', async () => {
    const { get } = service([modelMessage({ id: 'm1', content: `Look: ![A red fox](${FOX})` })]);
    await expect(get(FOX)).resolves.toEqual({ status: 'shown', bytes: PNG, mime: 'image/png' });
  });

  it('refuses a picture no stored turn shows, without fetching it', async () => {
    const { seen, get } = service([
      modelMessage({ id: 'm1', content: '', calls: [{ id: 'c1', name: 'web_search' }] }),
      toolResponse({ id: 't1', tool_call_id: 'c1', result: { results: [{ title: 'Red Fox', url: FOX }] } }),
    ]);
    await expect(get(OTHER)).resolves.toEqual({ status: 'not_in_chat' });
    expect(seen).toEqual([]);
  });

  it('does not count a picture that only appears in a non-search tool result', async () => {
    const { seen, get } = service([
      modelMessage({ id: 'm1', content: '', calls: [{ id: 'c1', name: 'read_email' }] }),
      toolResponse({ id: 't1', tool_call_id: 'c1', result: { bodyHtml: `<img src="${FOX}">` } }),
    ]);
    await expect(get(FOX)).resolves.toEqual({ status: 'not_in_chat' });
    expect(seen).toEqual([]);
  });

  it('does not count a picture from a call no model message names', async () => {
    const { seen, get } = service([
      toolResponse({ id: 't1', tool_call_id: 'c1', result: { results: [{ title: 'Red Fox', url: FOX }] } }),
    ]);
    await expect(get(FOX)).resolves.toEqual({ status: 'not_in_chat' });
    expect(seen).toEqual([]);
  });
});
