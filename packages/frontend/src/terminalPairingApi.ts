import type { PairedTerminal, TerminalPairingApi, TerminalPairingConfirmation } from '@truefoundry/trueforge-ui';

import { apiPath } from './publicPath';

const LOOKUP_URL = '/api/v1/terminal-pairings/lookup';
const CONFIRM_URL = '/api/v1/terminal-pairings/confirm';
const TERMINAL_KEYS_URL = '/api/v1/settings/terminal-keys';
const COULD_NOT_REACH_LINE = "Couldn't reach the server. Check your connection and try again.";
const CONFIRM_DID_NOT_WORK_LINE =
  'That pairing did not work. On the terminal, start pairing again and use the new code.';
const LIST_DID_NOT_WORK_LINE = 'The paired terminals could not be loaded. Try again in a moment.';
const REVOKE_DID_NOT_WORK_LINE = 'That terminal could not be revoked. Try again in a moment.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The server's own line for a refused call, read defensively; undefined when it sent none. */
function serverErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const error: unknown = body.error;
  if (!isRecord(error)) {
    return undefined;
  }
  return readNonEmptyString(error.message);
}

/** The answer's `data`, read defensively; undefined when the body does not carry one. */
function dataOf(body: unknown): unknown {
  return isRecord(body) ? body.data : undefined;
}

function readDeviceName(body: unknown): string | undefined {
  const data = dataOf(body);
  return isRecord(data) ? readNonEmptyString(data.device_name) : undefined;
}

function readConfirmation(body: unknown): TerminalPairingConfirmation | undefined {
  const data = dataOf(body);
  if (!isRecord(data)) {
    return undefined;
  }
  const device_name = readNonEmptyString(data.device_name);
  const paired_at = readNonEmptyString(data.paired_at);
  return device_name === undefined || paired_at === undefined ? undefined : { device_name, paired_at };
}

function readPairedTerminal(value: unknown): PairedTerminal | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readNonEmptyString(value.id);
  const device_name = readNonEmptyString(value.device_name);
  const paired_at = readNonEmptyString(value.paired_at);
  const last_used_at = readNonEmptyString(value.last_used_at);
  const revoked_at = value.revoked_at;
  if (id === undefined || device_name === undefined || paired_at === undefined || last_used_at === undefined) {
    return undefined;
  }
  if (revoked_at !== null && typeof revoked_at !== 'string') {
    return undefined;
  }
  return { id, device_name, paired_at, last_used_at, revoked_at };
}

function readPairedTerminals(body: unknown): PairedTerminal[] | undefined {
  const data = dataOf(body);
  if (!Array.isArray(data)) {
    return undefined;
  }
  const terminals: PairedTerminal[] = [];
  for (const row of data) {
    const terminal = readPairedTerminal(row);
    if (terminal === undefined) {
      return undefined;
    }
    terminals.push(terminal);
  }
  return terminals;
}

/**
 * Backs `TerminalPairingProvider`: the pairing routes are not on the generated SDK
 * yet (the SDK regenerates from the OpenAPI spec, and these routes landed after the
 * last regeneration), so this is a plain fetch with the browser session cookie
 * through the app's auth-aware fetch, the same path the local account API takes.
 * Answers are read defensively, and a refusal surfaces the server's own plain line.
 */
export function createTerminalPairingApi(fetcher: typeof fetch): TerminalPairingApi {
  const call = async (url: string, init: RequestInit, didNotWorkLine: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(apiPath(url), { credentials: 'include', ...init });
    } catch (cause) {
      throw new Error(COULD_NOT_REACH_LINE, { cause });
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(serverErrorMessage(body) ?? didNotWorkLine);
    }
    return body;
  };

  return {
    /**
     * The one call here that never throws. The name is a hint the page shows
     * before the confirm, never a gate, so any failure at all (the server's one
     * refusal for a wrong, expired or used code, an unreachable server, an answer
     * in an unexpected shape) reads as no name, and the page shows the code alone.
     */
    async lookupPairing(input) {
      let response: Response;
      try {
        response = await fetcher(apiPath(LOOKUP_URL), {
          credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
      } catch {
        return null;
      }
      if (!response.ok) {
        return null;
      }
      const body: unknown = await response.json().catch(() => undefined);
      return readDeviceName(body) ?? null;
    },

    async confirmPairing(input) {
      const body = await call(
        CONFIRM_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
        CONFIRM_DID_NOT_WORK_LINE,
      );
      const confirmation = readConfirmation(body);
      if (confirmation === undefined) {
        throw new Error(CONFIRM_DID_NOT_WORK_LINE);
      }
      return confirmation;
    },

    async listPairedTerminals() {
      const body = await call(TERMINAL_KEYS_URL, { method: 'GET' }, LIST_DID_NOT_WORK_LINE);
      const terminals = readPairedTerminals(body);
      if (terminals === undefined) {
        throw new Error(LIST_DID_NOT_WORK_LINE);
      }
      return terminals;
    },

    async revokePairedTerminal(input) {
      await call(
        `${TERMINAL_KEYS_URL}/${encodeURIComponent(input.terminal_key_id)}`,
        { method: 'DELETE' },
        REVOKE_DID_NOT_WORK_LINE,
      );
    },
  };
}
