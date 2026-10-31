import { createSentinelHostContext } from '@truefoundry/trueforge-core/core';
import type { AuditLogWriter, AuditRecordInput } from '@truefoundry/trueforge-core/core/permissions/audit';
import { defaultSentinelServices } from '@truefoundry/trueforge-core/core/permissions/context';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { createLogger, transports } from 'winston';
import { browserCapability, callBrowserSidecar } from '../../../src/runtime/browserCapability';

jest.mock('../../../src/config', () => {
  const actual = jest.requireActual<typeof import('../../../src/config')>('../../../src/config');
  return {
    ...actual,
    __esModule: true,
    default: {
      ...actual.default,
      BROWSER_ENABLED: true,
      BROWSER_URL: 'http://browser-test:8792',
      BROWSER_SECRET: 'x'.repeat(32),
      BROWSER_NAV_TIMEOUT_MS: 5000,
    },
  };
});

const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
global.fetch = fetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const logger = createLogger({ transports: [new transports.Console({ silent: true })] });

/** An in-memory audit log, for asserting on what a caught click records. */
function recordingAuditWriter(): { writer: AuditLogWriter; records: AuditRecordInput[] } {
  const records: AuditRecordInput[] = [];
  return {
    records,
    writer: {
      record: input => {
        records.push(input);
        return Promise.resolve();
      },
    },
  };
}

function browserToolSet(audit: AuditLogWriter | null = null) {
  const capability = browserCapability({
    tracing: NOOP_AGENT_TRACING,
    logger,
    owner: 'owner-1',
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'owner-1',
      conversation_id: 'c1',
      services: { ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }), audit },
    }),
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('browserCapability did not register a tool set');
  }
  return toolSet;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('callBrowserSidecar', () => {
  it('sends the shared secret header and the owner in the body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok', text: 'hello' }));
    const result = await callBrowserSidecar({ path: '/read', owner: 'owner-1' });
    expect(result).toEqual({ ok: true, body: { status: 'ok', text: 'hello' } });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://browser-test:8792/read');
    expect((init?.headers as Record<string, string>)['x-browser-secret']).toBe('x'.repeat(32));
    expect(JSON.parse(String(init?.body))).toEqual({ owner: 'owner-1' });
  });

  it('reads as unreachable when the sidecar cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await callBrowserSidecar({ path: '/read', owner: 'owner-1' });
    expect(result).toEqual({ ok: false, message: 'The browser could not be reached.' });
  });
});

describe('browser tools', () => {
  it('registers all eight tools', async () => {
    const toolSet = browserToolSet();
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

  it('browser_open returns the page text on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok', text: '# Hulu\nhttps://hulu.com' }));
    const toolSet = browserToolSet();
    const response = await toolSet.callTool({ name: 'browser_open', arguments: { url: 'https://hulu.com' } });
    if (!('result' in response)) {
      throw new Error('expected a resolved tool result');
    }
    expect(response.result.isError).not.toBe(true);
    const [content] = response.result.content;
    expect(content?.type === 'text' ? content.text : undefined).toContain('Hulu');
  });

  it('browser_open surfaces a plain refusal message for a private address', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'refused', reason: 'private_network' }));
    const toolSet = browserToolSet();
    const response = await toolSet.callTool({ name: 'browser_open', arguments: { url: 'http://127.0.0.1/' } });
    if (!('result' in response)) {
      throw new Error('expected a resolved tool result');
    }
    expect(response.result.isError).toBe(true);
    const [content] = response.result.content;
    const text = content?.type === 'text' ? content.text : '';
    expect(JSON.parse(text).message).toMatch(/private network/);
  });

  it('browser_type surfaces the exact refusal text for a sensitive field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'refused', reason: 'sensitive_field' }));
    const toolSet = browserToolSet();
    const response = await toolSet.callTool({
      name: 'browser_type',
      arguments: { ref: 'e1', text: 'hunter2' },
    });
    if (!('result' in response)) {
      throw new Error('expected a resolved tool result');
    }
    expect(response.result.isError).toBe(true);
    const [content] = response.result.content;
    const text = content?.type === 'text' ? content.text : '';
    expect(JSON.parse(text).message).toBe(
      'This field is for a password or payment detail. Ask the person to type it themselves.',
    );
  });

  it('browser_screenshot never puts the image in the tool result text', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok', png_base64: 'aGVsbG8=' }));
    const toolSet = browserToolSet();
    const response = await toolSet.callTool({ name: 'browser_screenshot', arguments: {} });
    if (!('result' in response)) {
      throw new Error('expected a resolved tool result');
    }
    const [content] = response.result.content;
    const text = content?.type === 'text' ? content.text : '';
    expect(text).not.toContain('aGVsbG8=');
    expect(JSON.parse(text)).toEqual({ status: 'ok', saved: true });
  });

  it("toolCallInfo stamps browser_click and its screenshot from the sidecar's dry-run read, not from model text", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 'ok',
        site: 'shop.example',
        accessible_name: 'Place order',
        is_form_submit: true,
        form_values: { card_last4: '4242' },
        png_base64: 'aGVsbG8=',
      }),
    );
    const toolSet = browserToolSet();
    const info = await toolSet.toolCallInfo({ name: 'browser_click', arguments: { ref: 'e3' } });
    expect(info.browser_click).toEqual({
      site: 'shop.example',
      accessible_name: 'Place order',
      is_form_submit: true,
      form_values: { card_last4: '4242' },
    });
    expect(info.browser_click_screenshot).toBe('data:image/png;base64,aGVsbG8=');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://browser-test:8792/click-info');
    expect(JSON.parse(String(init?.body))).toEqual({ owner: 'owner-1', ref: 'e3' });
  });

  it('toolCallInfo leaves the screenshot unset when the sidecar has none, without failing the whole stamp', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 'ok',
        site: 'shop.example',
        accessible_name: 'Cancel',
        is_form_submit: false,
        form_values: {},
        png_base64: null,
      }),
    );
    const toolSet = browserToolSet();
    const info = await toolSet.toolCallInfo({ name: 'browser_click', arguments: { ref: 'e3' } });
    expect(info.browser_click).toBeDefined();
    expect(info.browser_click_screenshot).toBeUndefined();
  });

  it('toolCallInfo leaves browser_click unset when the sidecar cannot be reached, failing closed', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const toolSet = browserToolSet();
    const info = await toolSet.toolCallInfo({ name: 'browser_click', arguments: { ref: 'e3' } });
    expect(info.browser_click).toBeUndefined();
  });

  it('liveMintParams re-reads the click at dispatch, so the generic approval check catches it changing', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 'ok',
        site: 'shop.example',
        // The label changed since the card was approved: "Place order" became "Add item".
        accessible_name: 'Add item',
        is_form_submit: true,
        form_values: {},
      }),
    );
    const toolSet = browserToolSet();
    const live = await toolSet.liveMintParams?.({ name: 'browser_click', arguments: { ref: 'e3' } });
    expect(live).toEqual({
      ref: 'e3',
      review: { site: 'shop.example', accessible_name: 'Add item', is_form_submit: true, form_values: {} },
    });
  });

  it('liveMintParams throws when the sidecar cannot be reached, so dispatch refuses instead of guessing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const toolSet = browserToolSet();
    await expect(toolSet.liveMintParams?.({ name: 'browser_click', arguments: { ref: 'e3' } })).rejects.toThrow();
  });

  it('liveMintParams is a no-op for tools other than browser_click', async () => {
    const toolSet = browserToolSet();
    const live = await toolSet.liveMintParams?.({ name: 'browser_open', arguments: { url: 'https://hulu.com' } });
    expect(live).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a click the sidecar gate caught writes a receipt, and tells the model plainly to stop', async () => {
    const { writer, records } = recordingAuditWriter();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 'needs_approval',
        site: 'shop.example',
        accessible_name: 'Continue',
        form_values: { plan: 'yearly' },
      }),
    );
    const toolSet = browserToolSet(writer);
    const response = await toolSet.callTool({ name: 'browser_click', arguments: { ref: 'e5' } });
    if (!('result' in response)) {
      throw new Error('expected a resolved tool result');
    }
    expect(response.result.isError).toBe(true);
    const [content] = response.result.content;
    const body = JSON.parse(content?.type === 'text' ? content.text : '{}') as { status: string; message: string };
    expect(body.status).toBe('needs_approval');
    expect(body.message).toMatch(/Continue/);
    expect(body.message).toMatch(/shop\.example/);
    expect(body.message).toMatch(/plan: yearly/);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tenant_id: 't1',
      created_by: 'owner-1',
      tier: 3,
      tool_name: 'browser_click',
      outcome: 'auto_denied',
    });
    expect(records[0]?.description).toMatch(/Continue/);
    expect(records[0]?.description).toMatch(/shop\.example/);
  });

  it('an approved click that goes through writes no gate receipt: it was never caught', async () => {
    const { writer, records } = recordingAuditWriter();
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok', text: 'Order placed' }));
    const toolSet = browserToolSet(writer);
    await toolSet.callTool({ name: 'browser_click', arguments: { ref: 'e5' } }, { status: 'allow' });
    expect(records).toHaveLength(0);
  });
});
