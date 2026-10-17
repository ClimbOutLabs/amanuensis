import {
  extractErrorLogFields,
  isLoopbackHost,
  type ModelRequestEvent,
  type OutboundEventWriter,
} from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

/** How long a row is kept; the page itself reads only the last 24 hours. */
export const OUTBOUND_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Wraps a store so a failed write is logged and never stops the request it describes. Requests to
 * this computer itself (`isLocalHost`, loopback by default) never left it and are not recorded.
 */
export function createOutboundRecorder({
  store,
  logger,
  isLocalHost = isLoopbackHost,
}: {
  store: OutboundEventWriter;
  logger: Logger;
  isLocalHost?: ((host: string) => boolean) | undefined;
}): OutboundEventWriter {
  return {
    async record(input) {
      if (isLocalHost(input.host)) {
        return;
      }
      try {
        await store.record(input);
      } catch (error) {
        logger.warn('Could not record an outbound request', extractErrorLogFields(error));
      }
    },
  };
}

/** Observer for one chat's model requests, for the model client; absent `writer` records nothing. */
export function modelRequestObserver({
  writer,
  tenant_id,
  conversation_id,
}: {
  writer: OutboundEventWriter | undefined;
  tenant_id: string;
  conversation_id: string | null;
}): ((event: ModelRequestEvent) => void) | undefined {
  if (writer === undefined) {
    return undefined;
  }
  return event => {
    void writer.record({
      tenant_id,
      kind: 'model_request',
      host: event.host,
      model: event.model_id,
      tool_name: null,
      request_bytes: event.request_bytes,
      recipient_count: null,
      subject: null,
      conversation_id,
    });
  };
}

/** Records one map lookup or tile fetch. */
export function recordMapRequest({
  writer,
  tenant_id,
  host,
}: {
  writer: OutboundEventWriter | undefined;
  tenant_id: string;
  host: string;
}): void {
  if (writer === undefined) {
    return;
  }
  void writer.record({
    tenant_id,
    kind: 'map_lookup',
    host,
    model: null,
    tool_name: null,
    request_bytes: null,
    recipient_count: null,
    subject: null,
    conversation_id: null,
  });
}
