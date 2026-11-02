import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { createLogger } from 'winston';

import configuration from '../../../src/config';
import { browserCapability } from '../../../src/runtime/browserCapability';

const SECRET = 'browser-test-secret-0123456789abcdef0123';
const TAB = { tenant_id: 'tenant-1', created_by: 'person-1', chat_id: 'chat-1' };

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** The capability's tools, with the sidecar answered by `reply` and every request it would have sent recorded. */
function mount(reply: (path: string) => { status?: number; json: unknown }) {
  const sent: SentRequest[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === 'string' ? init.body : '{}';
    const body: unknown = JSON.parse(bodyText);
    sent.push({
      url,
      headers: Object.fromEntries(headers.entries()),
      body: typeof body === 'object' && body !== null ? Object.fromEntries(Object.entries(body)) : {},
    });
    const answer = reply(new URL(url).pathname);
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 });
  });
  const capability = browserCapability({
    tracing: NOOP_AGENT_TRACING,
    logger: createLogger({ silent: true }),
    tab: TAB,
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('the browser capability has no tool set');
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await toolSet.callTool({ name, arguments: args });
    if (!('result' in response)) {
      throw new Error('expected a tool result');
    }
    return response.result;
  };
  return { sent, call };
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first?.type === 'text' && typeof first.text === 'string' ? first.text : '';
}

const original = {
  BROWSER_URL: configuration.BROWSER_URL,
  BROWSER_SECRET: configuration.BROWSER_SECRET,
};

beforeEach(() => {
  Object.assign(configuration, { BROWSER_URL: 'http://browser-relay:8792', BROWSER_SECRET: SECRET });
});

afterEach(() => {
  Object.assign(configuration, original);
  jest.restoreAllMocks();
});

describe('browser capability', () => {
  it("sends the person's profile and this chat's tab with the secret, and returns the page text", async () => {
    const { sent, call } = mount(() => ({ json: { status: 'ok', text: '# Account\nhttps://hulu.com/account' } }));
    const result = await call('browser_open', { url: 'https://hulu.com/account' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('# Account');
    expect(sent).toEqual([
      {
        url: 'http://browser-relay:8792/open',
        headers: expect.objectContaining({ 'x-browser-secret': SECRET }),
        body: { url: 'https://hulu.com/account', owner: 'tenant-1:person-1', tab: 'chat-1' },
      },
    ]);
  });

  it('keeps the same person in another tenant in a different profile', async () => {
    const { sent, call } = mount(() => ({ json: { status: 'ok', text: '' } }));
    await call('browser_read');
    expect(sent[0]?.body).toMatchObject({ owner: 'tenant-1:person-1', tab: 'chat-1' });
    expect(sent[0]?.body['owner']).not.toBe('person-1');
  });

  it('says plainly why an address was refused', async () => {
    const { call } = mount(() => ({ json: { status: 'refused', reason: 'private_network' } }));
    const result = await call('browser_open', { url: 'http://192.168.1.1/' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('private network');
  });

  it('reports a page that moved to another site without any of its text', async () => {
    const { call } = mount(() => ({ json: { status: 'moved', url: 'https://mail.example/inbox' } }));
    const result = await call('browser_back');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('https://mail.example/inbox');
    expect(textOf(result)).toContain('browser_open');
  });

  it('tells the chat to open the page again when its tab was closed to make room', async () => {
    const { call } = mount(() => ({ json: { status: 'closed' } }));
    const result = await call('browser_read');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Open the page again with browser_open');
  });

  it.each([
    ['an unknown status', { status: 'surprise', text: 'x' }],
    ['a missing text', { status: 'ok' }],
    ['a refusal without its reason', { status: 'refused' }],
    ['not an object', 'ok'],
  ])('treats a reply with %s as a failure, not as page text', async (_label, json) => {
    const { call } = mount(() => ({ json }));
    const result = await call('browser_read');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('could not do that');
  });

  it('shows a screenshot to the person, and gives the model only a note that it did', async () => {
    const { call } = mount(() => ({ json: { status: 'ok', png_base64: 'iVBORw0KGgo=' } }));
    const result = await call('browser_screenshot');
    expect(JSON.parse(textOf(result))).toEqual({ status: 'ok', shown_to_person: true });
    expect(result.content).toContainEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  });

  it('says the browser is not set up when the server has no address for it', async () => {
    Object.assign(configuration, { BROWSER_URL: undefined });
    const { sent, call } = mount(() => ({ json: { status: 'ok', text: '' } }));
    const result = await call('browser_read');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not set up');
    expect(sent).toEqual([]);
  });
});
