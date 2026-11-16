/**
 * How this app reads a server refusal. The server answers an error with its
 * own plain line inside the error body, while the SDK wraps that answer in
 * an error whose message is a dump of the status and the raw body. What the
 * person sees is the server's own line, or a plain line written here, never
 * the dump. The pairing calls and the chat calls read refusals through this
 * one place.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The server's own line from a parsed error body: the JSON error message, when the body carries one. */
export function serverMessageOfBody(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) {
    return undefined;
  }
  return readNonEmptyString(body.error.message);
}

/** The server's own line from an error answer's text: the JSON error message, or the plain text body as sent. */
export function serverMessageOfBodyText(bodyText: string): string | undefined {
  const trimmed = bodyText.trim();
  if (trimmed === '') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const message = serverMessageOfBody(parsed);
    if (message !== undefined) {
      return message;
    }
  } catch {
    // Not JSON: the body is the message itself, as the address refusal sends it.
  }
  return trimmed;
}

/** The HTTP status an SDK error carries, when it carries one. */
export function statusCodeOfError(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const statusCode: unknown = error.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

/** True when the server refused the terminal key itself: it is no longer accepted, or it reached outside its scope. */
export function keyWasRefused(error: unknown): boolean {
  const status = statusCodeOfError(error);
  return status === 401 || status === 403;
}

/** What a failed chat call shows the person: the plain line, and whether pairing again is the fix. */
export interface ChatErrorLine {
  message: string;
  /** True when the key itself was refused, so trying again cannot help and pairing again is the fix. */
  keyRefused: boolean;
}

/**
 * The plain line a failed chat call shows. A refused key gets the refusal
 * line, and the caller adds the pair-again command for its screen. Any other
 * server answer gives the server's own line. An SDK error with no readable
 * body falls back to the caller's line, because its own message is the raw
 * dump. A plain error this app threw itself already carries its line.
 */
export function chatErrorLine(error: unknown, fallback: string): ChatErrorLine {
  if (keyWasRefused(error)) {
    return { message: "Aman no longer accepts this terminal's key.", keyRefused: true };
  }
  const fromBody = serverMessageOfBody(isRecord(error) ? error.body : undefined);
  if (fromBody !== undefined) {
    return { message: fromBody, keyRefused: false };
  }
  if (statusCodeOfError(error) !== undefined || (isRecord(error) && 'body' in error)) {
    return { message: fallback, keyRefused: false };
  }
  if (error instanceof Error && error.message !== '') {
    return { message: error.message, keyRefused: false };
  }
  return { message: fallback, keyRefused: false };
}
