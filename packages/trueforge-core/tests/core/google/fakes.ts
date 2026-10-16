import { Writable } from 'node:stream';
import { createLogger, format, transports, type Logger } from 'winston';
import type {
  GoogleConnectionRecord,
  GoogleConnectionStore,
  GoogleConnectionVersion,
  GoogleOwner,
  PendingGoogleAuthorization,
  PendingGoogleAuthorizationStore,
} from '../../../src/core/google/connection';

export const OWNER: GoogleOwner = { tenant_id: 't1', created_by: 'u1' };

function keyOf(owner: GoogleOwner): string {
  return `${owner.tenant_id}/${owner.created_by}`;
}

export class FakeConnections implements GoogleConnectionStore {
  readonly records = new Map<string, GoogleConnectionRecord>();
  get(owner: GoogleOwner): Promise<GoogleConnectionRecord | null> {
    return Promise.resolve(this.records.get(keyOf(owner)) ?? null);
  }

  save(record: GoogleConnectionRecord): Promise<void> {
    this.records.set(keyOf(record), record);
    return Promise.resolve();
  }

  /** Mirrors the stores: a write applies only while the row still is the one the caller read. */
  #matching(input: { owner: GoogleOwner; expected: GoogleConnectionVersion }): GoogleConnectionRecord | undefined {
    const record = this.records.get(keyOf(input.owner));
    return record?.refresh_token === input.expected.refresh_token && record.updated_at === input.expected.updated_at
      ? record
      : undefined;
  }

  markNeedsReconnect(input: { owner: GoogleOwner; expected: GoogleConnectionVersion }): Promise<boolean> {
    const record = this.#matching(input);
    if (record !== undefined) {
      this.records.set(keyOf(input.owner), { ...record, status: 'needs_reconnect' });
    }
    return Promise.resolve(record !== undefined);
  }

  setAccountEmail(input: {
    owner: GoogleOwner;
    expected: GoogleConnectionVersion;
    account_email: string;
    updated_at: string;
  }): Promise<boolean> {
    const record = this.#matching(input);
    if (record !== undefined) {
      this.records.set(keyOf(input.owner), {
        ...record,
        account_email: input.account_email,
        updated_at: input.updated_at,
      });
    }
    return Promise.resolve(record !== undefined);
  }

  delete(owner: GoogleOwner): Promise<void> {
    this.records.delete(keyOf(owner));
    return Promise.resolve();
  }
}

export class FakePending implements PendingGoogleAuthorizationStore {
  readonly records = new Map<string, PendingGoogleAuthorization>();

  savePending(pending: PendingGoogleAuthorization): Promise<void> {
    this.records.set(keyOf(pending), pending);
    return Promise.resolve();
  }

  takePending(input: GoogleOwner & { state_hash: string }): Promise<PendingGoogleAuthorization | null> {
    const pending = this.records.get(keyOf(input));
    if (pending?.state_hash !== input.state_hash) {
      return Promise.resolve(null);
    }
    this.records.delete(keyOf(input));
    return Promise.resolve(pending);
  }

  hasPending(owner: GoogleOwner): Promise<boolean> {
    return Promise.resolve(this.records.has(keyOf(owner)));
  }

  clearPending(owner: GoogleOwner): Promise<void> {
    this.records.delete(keyOf(owner));
    return Promise.resolve();
  }
}

export function connectedRecord(overrides: Partial<GoogleConnectionRecord> = {}): GoogleConnectionRecord {
  return {
    ...OWNER,
    client_id: '123456789-abcdefghij.apps.googleusercontent.com',
    client_secret: 'secret-secret-secret',
    client_type: 'desktop',
    refresh_token: 'refresh-1',
    granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    account_email: 'ada@example.com',
    status: 'connected',
    created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

interface RecordedRequest {
  url: string;
  method: string;
  body: URLSearchParams | null;
  authorization: string | null;
}

/** A scripted stand-in for Google: answers by URL, records every request. */
export class FakeGoogle {
  readonly requests: RecordedRequest[] = [];
  readonly #handlers = new Map<string, (request: RecordedRequest) => Response>();

  on(url: string, handler: (request: RecordedRequest) => Response): void {
    this.#handlers.set(url, handler);
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const request: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null,
      authorization: headers.get('authorization'),
    };
    this.requests.push(request);
    const handler = this.#handlers.get(url.split('?')[0] ?? url);
    return Promise.resolve(handler === undefined ? new Response('unexpected', { status: 500 }) : handler(request));
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A logger that keeps every line it emits, so a test can check what was logged and that no secret was. */
export function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({
    level: 'debug',
    format: format.json(),
    transports: [new transports.Stream({ stream })],
  });
  return { logger, lines };
}
