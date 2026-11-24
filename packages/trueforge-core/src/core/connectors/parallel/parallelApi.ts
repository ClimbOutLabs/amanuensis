import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolSchema } from '../../mcp/IMCPServer';
import type { RemoteMcpConnection } from '../../mcp/remoteMcpClient';
import { isRecord } from '../../util/records';
import operations from './operations.json' with { type: 'json' };

/** The product API preset is opt-in and uses a different credential from Parallel account administration. */
export const PARALLEL_PRODUCT_URL = 'https://api.parallel.ai/';

interface Operation {
  name: string;
  method: string;
  path: string;
  description: string;
  query: string[];
  inputs: Record<string, unknown>;
  required: string[];
  body: Record<string, unknown> | null;
  beta: boolean;
}

const byName = new Map<string, Operation>(operations.map(operation => [operation.name, operation]));

function schema(operation: Operation): ToolSchema {
  const properties: Record<string, unknown> = { ...operation.inputs };
  const required = [...operation.required];
  if (operation.body !== null) {
    properties['body'] = operation.body;
    required.push('body');
  }
  if (operation.beta) properties['parallel_beta'] = { type: 'string', description: 'Optional Parallel beta features.' };
  return {
    name: operation.name,
    description: operation.description + ' on Parallel.',
    inputSchema: { type: 'object', required, properties, additionalProperties: false },
  };
}

function invalid(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** A long-running event feed yields one complete event per call, then releases the connection. */
async function readAnswer(response: Response, maxBytes: number, firstEvent: boolean): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error('Parallel returned too much data. Ask for fewer results and try again.');
      text += decoder.decode(part.value, { stream: true });
      if (firstEvent) {
        const end = /\r?\n\r?\n/g;
        for (let match = end.exec(text); match !== null; match = end.exec(text)) {
          const event = text.slice(0, match.index);
          if (/^data:/m.test(event)) return event;
          text = text.slice(end.lastIndex);
          end.lastIndex = 0;
        }
      }
    }
  } finally {
    await reader.cancel();
  }
}

export function parallelProductConnection(options: {
  headers: Record<string, string>;
  fetch: FetchLike;
  signal: AbortSignal;
  requestTimeoutMs: number;
  maxBytes: number;
}): RemoteMcpConnection {
  const list = Array.from(byName.values(), schema);
  async function callTool(params: CallToolRequest['params']): Promise<CallToolResult> {
    const operation = byName.get(params.name);
    if (!operation) return invalid('Choose a tool from the Parallel connector and try again.');
    const args = params.arguments ?? {};
    const headers = new Headers(options.headers);
    const key = headers.get('x-api-key');
    if (!key) return invalid('Add your Parallel API key in Settings, then try again.');
    let path = operation.path;
    const query = new URLSearchParams();
    for (const name of Object.keys(operation.inputs)) {
      const value = args[name];
      if (operation.query.includes(name)) {
        if (value === undefined || value === null) continue;
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
            return invalid('Check the filters and try again.');
          }
          query.append(name, String(entry));
        }
      } else {
        if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) {
          return invalid('Use the identifier returned by Parallel and try again.');
        }
        path = path.replace(`{${name}}`, value);
      }
    }
    if (operation.beta && typeof args['parallel_beta'] === 'string')
      headers.set('parallel-beta', args['parallel_beta']);
    const body = args['body'];
    if (operation.body !== null && !isRecord(body)) return invalid('Supply the Parallel request fields in body.');
    if (operation.body !== null) headers.set('content-type', 'application/json');
    const url = new URL(path, PARALLEL_PRODUCT_URL);
    url.search = query.toString();
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.requestTimeoutMs)]);
    const response = await options.fetch(url, {
      method: operation.method,
      headers,
      signal,
      redirect: 'error',
      ...(operation.body === null ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const next =
        response.status === 401 || response.status === 403
          ? 'Check the connector key and its access.'
          : response.status === 429
            ? 'Wait before trying again.'
            : 'Check the request and your Parallel account.';
      return invalid(`Parallel returned HTTP ${String(response.status)}. ${next}`);
    }
    const feed = response.headers.get('content-type')?.includes('text/event-stream') === true;
    const text = await readAnswer(response, options.maxBytes, feed && operation.query.includes('last_event_id'));
    return { content: [{ type: 'text', text: text.replaceAll(key, '[redacted]') }] };
  }
  return {
    sessionId: null,
    transportType: 'streamable-http',
    listTools: () => Promise.resolve({ tools: list }),
    callTool,
    close: () => Promise.resolve(),
  };
}
