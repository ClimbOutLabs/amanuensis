import { APICallError } from 'ai';

/**
 * Where a model's address points, as the host app knows it. `local_link` is the host's own bridge to a model on the
 * same computer; `elsewhere` is any other address.
 */
export type ModelAddressPlace = 'local_link' | 'elsewhere';

/** Tells the place of a model address from its host name; the host app supplies it, since only it knows its computer. */
export type PlaceOfModelHost = (hostname: string) => ModelAddressPlace;

// Socket failures that happen before a server sends any answer: nothing listened, the address could not be reached
// or named, or the connection was closed before a response began (the shape a refusal takes through a relay).
const NEVER_STARTED_CODES = new Set([
  'ECONNREFUSED',
  'ConnectionRefused',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'ConnectionClosed',
  'FailedToOpenSocket',
  'EPIPE',
]);

function errorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) {
    return undefined;
  }
  return typeof value.code === 'string' ? value.code : undefined;
}

/**
 * The model URL of a request whose connection never started: the AI SDK's call error with no status and no
 * response, caused by a socket failure that came before any answer. Undefined for anything else, a reply that
 * broke off mid-stream included, since that fails while reading a response the server had already begun.
 */
export function neverStartedModelUrl(raw: unknown): string | undefined {
  if (!APICallError.isInstance(raw) || raw.statusCode !== undefined || raw.responseHeaders !== undefined) {
    return undefined;
  }
  let current: unknown = raw.cause;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const code = errorCode(current);
    if (code !== undefined && NEVER_STARTED_CODES.has(code)) {
      return raw.url;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function hostOf(url: string): { hostname: string; host: string; port: string } {
  try {
    const parsed = new URL(url);
    return { hostname: parsed.hostname.replace(/^\[|\]$/g, ''), host: parsed.host, port: parsed.port };
  } catch {
    return { hostname: url, host: url, port: '' };
  }
}

/** The notice for a model connection that never started, in plain words, with the one thing to do next. */
export function modelUnreachableMessage({ url, place }: { url: string; place: ModelAddressPlace }): string {
  const { host, port } = hostOf(url);
  switch (place) {
    case 'local_link':
      return (
        'Aman could not connect to the model on this computer, so no reply was started. ' +
        `Nothing answered at port ${port === '' ? 'the port Aman uses' : port} on this computer. ` +
        'Start the model server on this computer, then send your message again.'
      );
    case 'elsewhere':
      return (
        `Aman could not connect to the model at ${host}, so no reply was started. ` +
        'Check that the model server is running and can be reached from this computer, then send your message again.'
      );
  }
}

/**
 * A model call whose connection never started. Never a ModelStreamFault: no reply began, so nothing broke off, and
 * the message says so in place of the stream-fault notice.
 */
export class ModelUnreachableError extends Error {
  readonly url: string;
  readonly place: ModelAddressPlace;

  constructor({ url, place, cause }: { url: string; place: ModelAddressPlace; cause: unknown }) {
    super(modelUnreachableMessage({ url, place }), { cause });
    this.name = 'ModelUnreachableError';
    this.url = url;
    this.place = place;
  }
}

/** The error to throw for a stream error part, when its connection never started; undefined otherwise. */
export function modelUnreachableErrorOf({
  raw,
  placeOfModelHost,
}: {
  raw: unknown;
  placeOfModelHost: PlaceOfModelHost | undefined;
}): ModelUnreachableError | undefined {
  const url = neverStartedModelUrl(raw);
  if (url === undefined) {
    return undefined;
  }
  const place = placeOfModelHost === undefined ? 'elsewhere' : placeOfModelHost(hostOf(url).hostname);
  return new ModelUnreachableError({ url, place, cause: raw });
}
