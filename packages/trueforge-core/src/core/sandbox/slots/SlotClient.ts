import { request } from 'node:http';
import { z } from 'zod';
import {
  SlotErrorBodySchema,
  SlotExecResponseSchema,
  SlotFsReadResponseSchema,
  SlotHealthResponseSchema,
  SlotRunCodeResponseSchema,
  type SlotErrorCode,
  type SlotExecRequest,
  type SlotExecResponse,
  type SlotFsReadResponse,
  type SlotHealthResponse,
  type SlotRunCodeRequest,
  type SlotRunCodeResponse,
} from './slotContract';

/** Larger than the agent's biggest legitimate reply (two 4 MiB streams plus 128 MiB of base64 files). */
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

export type SlotCallError =
  | { kind: 'unreachable'; message: string }
  | { kind: 'agent'; code: SlotErrorCode; message: string }
  | { kind: 'aborted'; message: string }
  | { kind: 'protocol'; message: string };

export type SlotCallResult<T> = { ok: true; value: T } | { ok: false; error: SlotCallError };

interface RawResponse {
  status: number;
  body: Buffer;
}

function isConnectFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return ['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'ECONNRESET', 'EPIPE'].includes(String(error.code));
}

/** HTTP client for one slot agent over its Unix socket. Every reply is validated against the contract. */
export class SlotClient {
  constructor(private readonly socketPath: string) {}

  health(input: { signal: AbortSignal | undefined; timeoutMs: number }): Promise<SlotCallResult<SlotHealthResponse>> {
    return this.call({
      method: 'GET',
      path: '/v1/health',
      body: undefined,
      schema: SlotHealthResponseSchema,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
  }

  runCode(input: {
    request: SlotRunCodeRequest;
    signal: AbortSignal | undefined;
  }): Promise<SlotCallResult<SlotRunCodeResponse>> {
    return this.call({
      method: 'POST',
      path: '/v1/run_code',
      body: input.request,
      schema: SlotRunCodeResponseSchema,
      signal: input.signal,
      timeoutMs: undefined,
    });
  }

  exec(input: {
    request: SlotExecRequest;
    signal: AbortSignal | undefined;
  }): Promise<SlotCallResult<SlotExecResponse>> {
    return this.call({
      method: 'POST',
      path: '/v1/exec',
      body: input.request,
      schema: SlotExecResponseSchema,
      signal: input.signal,
      timeoutMs: undefined,
    });
  }

  fsRead(input: {
    sessionId: string;
    path: string;
    signal: AbortSignal | undefined;
  }): Promise<SlotCallResult<SlotFsReadResponse>> {
    return this.call({
      method: 'POST',
      path: '/v1/fs_read',
      body: { session_id: input.sessionId, path: input.path },
      schema: SlotFsReadResponseSchema,
      signal: input.signal,
      timeoutMs: 60_000,
    });
  }

  async fsWrite(input: {
    sessionId: string;
    path: string;
    content: Buffer;
    mode: number;
    signal: AbortSignal | undefined;
  }): Promise<SlotCallResult<undefined>> {
    return this.call({
      method: 'POST',
      path: '/v1/fs_write',
      body: {
        session_id: input.sessionId,
        path: input.path,
        content_base64: input.content.toString('base64'),
        mode: input.mode,
      },
      schema: z.undefined(),
      signal: input.signal,
      timeoutMs: 60_000,
    });
  }

  async destroySession(input: {
    sessionId: string;
    signal: AbortSignal | undefined;
  }): Promise<SlotCallResult<undefined>> {
    return this.call({
      method: 'POST',
      path: '/v1/destroy_session',
      body: { session_id: input.sessionId },
      schema: z.undefined(),
      signal: input.signal,
      timeoutMs: 60_000,
    });
  }

  private async call<T>(input: {
    method: 'GET' | 'POST';
    path: string;
    body: unknown;
    schema: z.ZodType<T>;
    signal: AbortSignal | undefined;
    timeoutMs: number | undefined;
  }): Promise<SlotCallResult<T>> {
    let raw: RawResponse;
    try {
      raw = await this.send(input);
    } catch (error) {
      if (input.signal?.aborted === true) {
        return { ok: false, error: { kind: 'aborted', message: 'the call was cancelled' } };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { kind: isConnectFailure(error) ? 'unreachable' : 'protocol', message } };
    }
    if (raw.status >= 200 && raw.status < 300) {
      if (raw.status === 204) {
        const parsed = input.schema.safeParse(undefined);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, error: { kind: 'protocol', message: 'unexpected empty reply' } };
      }
      return this.parseBody({ body: raw.body, schema: input.schema });
    }
    return { ok: false, error: this.parseError(raw) };
  }

  private parseBody<T>(input: { body: Buffer; schema: z.ZodType<T> }): SlotCallResult<T> {
    let json: unknown;
    try {
      json = JSON.parse(input.body.toString('utf8'));
    } catch (error) {
      return { ok: false, error: { kind: 'protocol', message: `reply is not JSON: ${String(error)}` } };
    }
    const parsed = input.schema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, error: { kind: 'protocol', message: 'reply does not match the slot contract' } };
    }
    return { ok: true, value: parsed.data };
  }

  private parseError(raw: RawResponse): SlotCallError {
    try {
      const parsed = SlotErrorBodySchema.safeParse(JSON.parse(raw.body.toString('utf8')));
      if (parsed.success) {
        return { kind: 'agent', code: parsed.data.error.code, message: parsed.data.error.message };
      }
    } catch {
      // Falls through to the generic protocol error.
    }
    return { kind: 'protocol', message: `slot answered HTTP ${String(raw.status)}` };
  }

  private send(input: {
    method: 'GET' | 'POST';
    path: string;
    body: unknown;
    signal: AbortSignal | undefined;
    timeoutMs: number | undefined;
  }): Promise<RawResponse> {
    const payload = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body), 'utf8');
    return new Promise<RawResponse>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: input.path,
          method: input.method,
          headers:
            payload === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': String(payload.byteLength) },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
        },
        res => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > MAX_RESPONSE_BYTES) {
              req.destroy(new Error('slot reply exceeds the size bound'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error('slot did not answer in time'));
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
}
