import type { BrowserElementReview } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import type { ToolInvocationContext } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
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
  const call = async (name: string, args: Record<string, unknown> = {}, context?: ToolInvocationContext) => {
    const response = await toolSet.callTool({ name, arguments: args }, undefined, context);
    if (!('result' in response)) {
      throw new Error('expected a tool result');
    }
    return response.result;
  };
  return { sent, call, toolSet };
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

  it('tells a chat with no page open to open one', async () => {
    const { call } = mount(() => ({ json: { status: 'closed' } }));
    const result = await call('browser_read');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Open the page with browser_open');
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
  it('registers all eight browser tools', async () => {
    const { toolSet } = mount(() => ({ json: { status: 'ok', text: '' } }));
    const response = await toolSet.listTools();
    if (!('result' in response)) {
      throw new Error('expected a resolved listTools response');
    }
    expect(response.result.tools.map(tool => tool.name).sort()).toEqual(
      [
        'browser_open',
        'browser_read',
        'browser_scroll',
        'browser_back',
        'browser_screenshot',
        'browser_type',
        'browser_select',
        'browser_click',
      ].sort(),
    );
  });

  const CHECKED: BrowserElementReview = {
    site: 'shop.example',
    accessible_name: 'Help center',
    role: 'link',
    is_form_submit: false,
    form_values: {},
    link_url: 'https://shop.example/help',
  };
  const FIELD: BrowserElementReview = { ...CHECKED, accessible_name: 'Name', role: 'textbox', link_url: null };
  const checkedContext = (review: BrowserElementReview): ToolInvocationContext => ({
    admission_provenance: { source: 'automatic' },
    browser_element_precondition: review,
  });

  it('browser_type refuses a sensitive field with the plain reason', async () => {
    const { sent, call } = mount(() => ({ json: { status: 'refused', reason: 'sensitive_field' } }));
    const result = await call('browser_type', { ref: 'e1', text: 'hunter2' }, checkedContext(FIELD));
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result)).message).toBe(
      'This field is for a password, a payment detail or a one-time code. Ask the person to type it themselves.',
    );
    expect(sent[0]?.url).toBe('http://browser-relay:8792/type');
    expect(sent[0]?.body).toEqual({
      ref: 'e1',
      text: 'hunter2',
      expect: FIELD,
      owner: 'tenant-1:person-1',
      tab: 'chat-1',
    });
  });

  it('browser_select sends the option with the read it was checked against', async () => {
    const { sent, call } = mount(() => ({ json: { status: 'ok', text: '# Picked' } }));
    const result = await call('browser_select', { ref: 'e2', option: 'Premium' }, checkedContext(FIELD));
    expect(result.isError).toBeUndefined();
    expect(sent[0]?.url).toBe('http://browser-relay:8792/select');
    expect(sent[0]?.body).toEqual({
      ref: 'e2',
      option: 'Premium',
      expect: FIELD,
      owner: 'tenant-1:person-1',
      tab: 'chat-1',
    });
  });

  it('browser_click sends the ref with the read it was checked against, and returns the page it lands on', async () => {
    const { sent, call } = mount(() => ({ json: { status: 'ok', text: '# Done' } }));
    const result = await call('browser_click', { ref: 'e3' }, checkedContext(CHECKED));
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('# Done');
    expect(sent[0]?.url).toBe('http://browser-relay:8792/click');
    expect(sent[0]?.body).toEqual({
      ref: 'e3',
      expect: CHECKED,
      owner: 'tenant-1:person-1',
      tab: 'chat-1',
    });
  });

  it('a disabled, read-only or covered element, or a line break for a one-line field, is refused with a plain reason', async () => {
    for (const [reason, message] of [
      [
        'disabled',
        'That part of the page is switched off right now, so it was not touched. Read the page again, then try again.',
      ],
      ['read_only', 'That field cannot be changed, so nothing was typed. Read the page again to find the right field.'],
      [
        'line_break',
        'That field holds one line, and the text has a line break or tab, which would press Enter or Tab. Nothing was typed. Type it as one line.',
      ],
      [
        'covered',
        'Something else on the page is covering that part, so it was not touched. Read the page again, then try again.',
      ],
    ] as const) {
      const { call } = mount(() => ({ json: { status: 'refused', reason } }));
      const result = await call('browser_click', { ref: 'e3' }, checkedContext(CHECKED));
      expect(result.isError).toBe(true);
      expect(JSON.parse(textOf(result)).message).toBe(message);
    }
  });

  it('an action with no checked read is refused without calling the browser', async () => {
    const { sent, call } = mount(() => ({ json: { status: 'ok', text: '# Done' } }));
    for (const [name, args] of [
      ['browser_click', { ref: 'e3' }],
      ['browser_type', { ref: 'e1', text: 'hi' }],
      ['browser_select', { ref: 'e2', option: 'Premium' }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(JSON.parse(textOf(result)).message).toBe(
        'Aman could not check that part of the page first, so it was not touched. Read the page again, then try again.',
      );
    }
    expect(sent).toEqual([]);
  });

  it('an action tells the model to read again when the page changed since it was checked', async () => {
    const { call } = mount(() => ({ json: { status: 'refused', reason: 'changed' } }));
    const result = await call('browser_click', { ref: 'e3' }, checkedContext(CHECKED));
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result)).message).toBe(
      'That part of the page changed after Aman checked it, so it was not touched. Read the page again, then try again.',
    );
  });

  it("toolCallInfo stamps a click, type or select with the sidecar's dry-run read, not from model text", async () => {
    const read = {
      site: 'shop.example',
      accessible_name: 'Place order',
      role: 'button',
      is_form_submit: true,
      form_values: { card_last4: '4242' },
      link_url: null,
    };
    const { sent, toolSet } = mount(path =>
      path === '/element-info' ? { json: { status: 'ok', ...read } } : { json: { status: 'ok', text: '' } },
    );
    for (const [name, args] of [
      ['browser_click', { ref: 'e3' }],
      ['browser_type', { ref: 'e3', text: 'x' }],
      ['browser_select', { ref: 'e3', option: 'y' }],
    ] as const) {
      const info = await toolSet.toolCallInfo({ name, arguments: args });
      expect(info.browser_element).toEqual(read);
    }
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({
      url: 'http://browser-relay:8792/element-info',
      headers: expect.objectContaining({ 'x-browser-secret': SECRET }),
      body: { ref: 'e3', owner: 'tenant-1:person-1', tab: 'chat-1' },
    });
  });

  it('toolCallInfo reads nothing for a tool that does not act on an element', async () => {
    const { sent, toolSet } = mount(() => ({ json: { status: 'ok', text: '' } }));
    const info = await toolSet.toolCallInfo({ name: 'browser_read', arguments: {} });
    expect(info.browser_element).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('toolCallInfo leaves browser_element unset when the read says the tab moved to another site', async () => {
    const { toolSet } = mount(path =>
      path === '/element-info'
        ? { json: { status: 'moved', url: 'https://mail.example/inbox' } }
        : { json: { status: 'ok', text: '' } },
    );
    const info = await toolSet.toolCallInfo({ name: 'browser_click', arguments: { ref: 'e3' } });
    expect(info.browser_element).toBeUndefined();
  });

  it('toolCallInfo leaves browser_element unset when the sidecar cannot be reached, failing closed', async () => {
    const { toolSet } = mount(() => ({ json: { status: 'ok', text: '' } }));
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const info = await toolSet.toolCallInfo({ name: 'browser_click', arguments: { ref: 'e3' } });
    expect(info.browser_element).toBeUndefined();
  });
});
