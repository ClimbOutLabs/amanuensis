/**
 * The pairing calls, as plain fetches. The generated SDK has no terminal pairing
 * methods yet, because the SDK is regenerated from the OpenAPI spec and these
 * routes landed after the last regeneration; the web app's pairing calls take
 * the same plain-fetch path for the same reason. Answers are read defensively,
 * and a refusal surfaces the server's own line exactly as it was sent.
 *
 * The start and complete calls are signed out and change state, so they carry
 * an Origin header naming the instance address. The server's request guard
 * refuses a state-changing call that has neither an Origin it lists nor a
 * Bearer token, and this app never weakens that check to make pairing work.
 */
export interface PairingStart {
  pairingId: string;
  code: string;
  confirmUrl: string;
  expiresAt: string;
}

export type PairingCompletion = { status: 'waiting' } | { status: 'paired'; terminalKey: string; deviceName: string };

/** A refusal from the server. `serverMessage` is the server's own line, verbatim. */
export class PairingRefusedError extends Error {
  readonly serverMessage: string;
  readonly status: number;

  constructor(serverMessage: string, status: number, cause?: unknown) {
    super(serverMessage, cause === undefined ? undefined : { cause });
    this.name = 'PairingRefusedError';
    this.serverMessage = serverMessage;
    this.status = status;
  }
}

const START_DID_NOT_WORK_LINE = 'Pairing could not be started. Check the address and try again.';
const COMPLETE_DID_NOT_WORK_LINE = 'That pairing is not there any more. On the terminal, start pairing again.';
const REVOKE_DID_NOT_WORK_LINE = 'The key could not be revoked. Open Settings on the web and revoke it there.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function dataOf(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const data: unknown = body.data;
  return isRecord(data) ? data : undefined;
}

/** The server's own line from an error answer: the JSON error message, or the plain text body as sent. */
function serverMessageOf(bodyText: string): string | undefined {
  const trimmed = bodyText.trim();
  if (trimmed === '') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = readNonEmptyString(parsed.error.message);
      if (message !== undefined) {
        return message;
      }
    }
  } catch {
    // Not JSON: the body is the message itself, as the address refusal sends it.
  }
  return trimmed;
}

export interface PairingClient {
  start(deviceName: string): Promise<PairingStart>;
  complete(options: { pairingId: string; code: string }): Promise<PairingCompletion>;
  revokeCurrent(terminalKey: string): Promise<void>;
}

export function createPairingClient(options: { baseUrl: string; fetch?: typeof fetch }): PairingClient {
  const fetcher = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
  const origin = new URL(base).origin;

  const call = async (route: string, init: RequestInit, didNotWorkLine: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(`${base}${route}`, init);
    } catch (cause) {
      throw new PairingRefusedError(
        `Aman could not be reached at ${base}. Check the address and your connection, then try again.`,
        0,
        cause,
      );
    }
    const bodyText = await response.text().catch(() => '');
    if (!response.ok) {
      throw new PairingRefusedError(serverMessageOf(bodyText) ?? didNotWorkLine, response.status);
    }
    try {
      return JSON.parse(bodyText);
    } catch (cause) {
      throw new PairingRefusedError(didNotWorkLine, response.status, cause);
    }
  };

  const signedOutInit = (body: Record<string, string>): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });

  return {
    async start(deviceName: string): Promise<PairingStart> {
      const body = await call(
        '/api/v1/terminal-pairings',
        signedOutInit({ device_name: deviceName }),
        START_DID_NOT_WORK_LINE,
      );
      const data = dataOf(body);
      const pairingId = data === undefined ? undefined : readNonEmptyString(data.pairing_id);
      const code = data === undefined ? undefined : readNonEmptyString(data.code);
      const confirmUrl = data === undefined ? undefined : readNonEmptyString(data.confirm_url);
      const expiresAt = data === undefined ? undefined : readNonEmptyString(data.expires_at);
      if (pairingId === undefined || code === undefined || confirmUrl === undefined || expiresAt === undefined) {
        throw new PairingRefusedError(START_DID_NOT_WORK_LINE, 201);
      }
      return { pairingId, code, confirmUrl, expiresAt };
    },

    async complete(options: { pairingId: string; code: string }): Promise<PairingCompletion> {
      const body = await call(
        '/api/v1/terminal-pairings/complete',
        signedOutInit({ pairing_id: options.pairingId, code: options.code }),
        COMPLETE_DID_NOT_WORK_LINE,
      );
      const data = dataOf(body);
      if (data !== undefined && data.status === 'waiting') {
        return { status: 'waiting' };
      }
      const terminalKey = data === undefined ? undefined : readNonEmptyString(data.terminal_key);
      const deviceName = data === undefined ? undefined : readNonEmptyString(data.device_name);
      if (data !== undefined && data.status === 'paired' && terminalKey !== undefined && deviceName !== undefined) {
        return { status: 'paired', terminalKey, deviceName };
      }
      throw new PairingRefusedError(COMPLETE_DID_NOT_WORK_LINE, 200);
    },

    async revokeCurrent(terminalKey: string): Promise<void> {
      await call(
        '/api/v1/terminal-pairings/revoke-current',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${terminalKey}` },
          body: JSON.stringify({}),
        },
        REVOKE_DID_NOT_WORK_LINE,
      );
    },
  };
}
