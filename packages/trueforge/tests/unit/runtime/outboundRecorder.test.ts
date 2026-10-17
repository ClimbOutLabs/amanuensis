import type { OutboundEventInput } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';

import { createOutboundRecorder, modelRequestObserver, recordMapRequest } from '../../../src/runtime/outboundRecorder';

const silent = createLogger({ silent: true });

function input(host: string): OutboundEventInput {
  return {
    tenant_id: 't1',
    kind: 'connector_call',
    host,
    model: null,
    tool_name: 'list_things',
    request_bytes: 10,
    recipient_count: null,
    subject: null,
    conversation_id: 'c1',
  };
}

function collector() {
  const rows: OutboundEventInput[] = [];
  return {
    rows,
    store: {
      record: (row: OutboundEventInput) => {
        rows.push(row);
        return Promise.resolve();
      },
    },
  };
}

describe('createOutboundRecorder', () => {
  it.each(['localhost', 'localhost:11434', '127.0.0.1:8080', '[::1]:9000'])(
    'does not record a request to this computer (%s)',
    async host => {
      const { rows, store } = collector();
      await createOutboundRecorder({ store, logger: silent }).record(input(host));
      expect(rows).toEqual([]);
    },
  );

  it.each(['api.example.com', 'search.example.com:8443', '10.1.2.3'])('records a request to %s', async host => {
    const { rows, store } = collector();
    await createOutboundRecorder({ store, logger: silent }).record(input(host));
    expect(rows.map(row => row.host)).toEqual([host]);
  });

  it('lets the host decide what counts as this computer', async () => {
    const { rows, store } = collector();
    await createOutboundRecorder({ store, logger: silent, isLocalHost: host => host.endsWith('.lan') }).record(
      input('spark.lan'),
    );
    expect(rows).toEqual([]);
  });

  it('logs and swallows a failed write so the request it describes still goes', async () => {
    const warn = jest.fn();
    const recorder = createOutboundRecorder({
      store: { record: () => Promise.reject(new Error('disk full')) },
      logger: Object.assign(createLogger({ silent: true }), { warn }),
    });
    await expect(recorder.record(input('api.example.com'))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('modelRequestObserver', () => {
  it('records the host, model and size for the chat, and nothing else', async () => {
    const { rows, store } = collector();
    const observer = modelRequestObserver({ writer: store, tenant_id: 't1', conversation_id: 'chat-1' });
    observer?.({ host: 'models.example.test', model_id: 'm1', request_bytes: 2048 });
    await Promise.resolve();

    expect(rows).toEqual([
      {
        tenant_id: 't1',
        kind: 'model_request',
        host: 'models.example.test',
        model: 'm1',
        tool_name: null,
        request_bytes: 2048,
        recipient_count: null,
        subject: null,
        conversation_id: 'chat-1',
      },
    ]);
  });

  it('records nothing without a writer', () => {
    expect(modelRequestObserver({ writer: undefined, tenant_id: 't1', conversation_id: 'c' })).toBeUndefined();
  });
});

describe('recordMapRequest', () => {
  it('records a map lookup with only the service host', async () => {
    const { rows, store } = collector();
    recordMapRequest({ writer: store, tenant_id: 't1', host: 'nominatim.example.org' });
    await Promise.resolve();

    expect(rows).toEqual([
      {
        tenant_id: 't1',
        kind: 'map_lookup',
        host: 'nominatim.example.org',
        model: null,
        tool_name: null,
        request_bytes: null,
        recipient_count: null,
        subject: null,
        conversation_id: null,
      },
    ]);
  });

  it('does nothing without a writer', () => {
    expect(() => {
      recordMapRequest({ writer: undefined, tenant_id: 't1', host: 'nominatim.example.org' });
    }).not.toThrow();
  });
});
