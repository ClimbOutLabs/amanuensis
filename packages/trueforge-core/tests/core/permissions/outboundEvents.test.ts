import { OUTBOUND_EVENT_KINDS, isLoopbackHost } from '../../../src/core';
import { connectorCallEvent } from '../../../src/core/permissions/outboundEvents';

const base = { tenant_id: 't', conversation_id: 'c', search_provider: false } as const;

describe('isLoopbackHost', () => {
  it.each(['localhost', 'localhost:8080', '127.0.0.1', '127.0.0.1:11434', '127.5.6.7', '[::1]:3000', 'a.localhost'])(
    'treats %s as this computer',
    host => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['api.openai.com', 'search.parallel.ai', '10.0.0.5', '192.168.1.2:8000', 'localhost.example.com'])(
    'treats %s as another computer',
    host => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe('connectorCallEvent', () => {
  it('lists every kind a connector call can produce', () => {
    expect(OUTBOUND_EVENT_KINDS).toEqual(['model_request', 'email_sent', 'web_search', 'map_lookup', 'connector_call']);
  });

  it.each([
    ['send_email', 'email_sent'],
    ['send_draft', 'email_sent'],
    ['gmail_send_message', 'email_sent'],
    ['reply_to_email', 'email_sent'],
    ['forward_email', 'email_sent'],
    ['create_draft', 'connector_call'],
    ['list_inbox_threads', 'connector_call'],
    ['send_sms', 'connector_call'],
    ['create_issue', 'connector_call'],
  ])('classifies %s as %s', (tool_name, kind) => {
    const event = connectorCallEvent({ ...base, host: 'svc.example.com', tool_name, args: {} });
    expect(event?.kind).toBe(kind);
  });

  it('treats every call to the search provider as a web search', () => {
    const event = connectorCallEvent({
      ...base,
      search_provider: true,
      host: 'search.example.com',
      tool_name: 'send_email',
      args: { q: 'x' },
    });
    expect(event?.kind).toBe('web_search');
    expect(event?.subject).toBeNull();
  });

  it('counts each distinct recipient across fields and nested objects once', () => {
    const event = connectorCallEvent({
      ...base,
      host: 'svc.example.com',
      tool_name: 'send_email',
      args: { to: ['a@x.com', 'a@x.com'], bcc: [{ email: 'b@x.com' }] },
    });
    expect(event?.recipient_count).toBe(2);
  });

  it('measures the arguments in bytes and keeps no argument text', () => {
    const event = connectorCallEvent({
      ...base,
      host: 'svc.example.com',
      tool_name: 'list_things',
      args: { token: 'sk-live-abcdef', note: 'hello' },
    });
    expect(event?.request_bytes).toBe(new TextEncoder().encode('{"token":"sk-live-abcdef","note":"hello"}').length);
    expect(JSON.stringify(event)).not.toContain('sk-live-abcdef');
  });

  it('returns nothing for a source that is not a remote server', () => {
    expect(connectorCallEvent({ ...base, host: undefined, tool_name: 't', args: {} })).toBeNull();
  });
});
