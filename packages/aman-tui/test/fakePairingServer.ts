import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** The refusal line Step 1 sends for a wrong, expired, or used pairing code. */
export const PAIRING_GONE_MESSAGE = 'That pairing is not there any more. On the terminal, start pairing again.';

/** The plain-text refusal Step 1's request guard sends for an unlisted address. */
export const ADDRESS_NOT_LISTED_MESSAGE =
  "This address is not one Aman is set up for. If this computer's address changed, run this on the computer that runs Aman: aman doctor network --fix";

/** A made-up terminal key in Step 1's shape: the prefix plus base64url bytes. */
export const FAKE_TERMINAL_KEY = `aman_tk_${'Zm9vYmFy'.repeat(5)}abc`;

export type CompleteStep = 'waiting' | 'paired' | 'gone';

export interface RecordedRequest {
  path: string;
  origin: string | undefined;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') {
    return {};
  }
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * A fake Aman server speaking Step 1's pairing routes with their exact shapes.
 * The complete route follows a script: each call takes the next step, and the
 * last step repeats. A paired step hands the key over once because the script
 * moves past it.
 */
export class FakePairingServer {
  readonly requests: RecordedRequest[] = [];
  #server: Server | null = null;
  #completeScript: CompleteStep[];
  #refuseStartAsUnlistedAddress: boolean;

  constructor(options: { completeScript?: CompleteStep[]; refuseStartAsUnlistedAddress?: boolean } = {}) {
    this.#completeScript = [...(options.completeScript ?? ['waiting', 'paired', 'gone'])];
    this.#refuseStartAsUnlistedAddress = options.refuseStartAsUnlistedAddress ?? false;
  }

  get baseUrl(): string {
    if (this.#server === null) {
      throw new Error('The fake server is not listening yet.');
    }
    const address = this.#server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The fake server has no port.');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async listen(): Promise<void> {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once('error', reject);
      this.#server?.listen(0, '127.0.0.1', resolve);
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.#server === null) {
        resolve();
        return;
      }
      this.#server.close(error => (error === undefined ? resolve() : reject(error)));
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? '';
    const body = await readBody(request);
    this.requests.push({
      path,
      origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
      authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
      body,
    });

    if (path === '/api/v1/terminal-pairings' && request.method === 'POST') {
      if (this.#refuseStartAsUnlistedAddress) {
        response.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(ADDRESS_NOT_LISTED_MESSAGE);
        return;
      }
      sendJson(response, 201, {
        data: {
          pairing_id: 'pairing-nora-1',
          code: 'WXYZ-2345',
          confirm_url: `${this.baseUrl}/pair-terminal?code=WXYZ-2345`,
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      });
      return;
    }

    if (path === '/api/v1/terminal-pairings/complete' && request.method === 'POST') {
      const step = this.#completeScript.length > 1 ? this.#completeScript.shift() : this.#completeScript[0];
      if (step === 'waiting') {
        sendJson(response, 200, { data: { status: 'waiting' } });
        return;
      }
      if (step === 'paired') {
        sendJson(response, 200, {
          data: { status: 'paired', terminal_key: FAKE_TERMINAL_KEY, device_name: 'Pippa' },
        });
        return;
      }
      sendJson(response, 404, { error: { message: PAIRING_GONE_MESSAGE } });
      return;
    }

    if (path === '/api/v1/terminal-pairings/revoke-current' && request.method === 'POST') {
      if (request.headers.authorization === `Bearer ${FAKE_TERMINAL_KEY}`) {
        sendJson(response, 200, { data: { revoked: true } });
        return;
      }
      sendJson(response, 401, { error: { message: 'Authentication required.' } });
      return;
    }

    sendJson(response, 404, { error: { message: 'Not found.' } });
  }
}
