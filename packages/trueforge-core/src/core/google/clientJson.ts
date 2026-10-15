/**
 * Checks on the user's own Google OAuth client before any consent: reading the JSON Google offers for
 * download, the shape of the id and secret, and whether the client type fits how this install is reached.
 * Pure, so the Settings panel runs the same checks in the browser. Problems are plain language.
 */
import { z } from 'zod';
import type { GoogleSetupInfo } from './setupMode';

export const CLIENT_TYPES = ['desktop', 'web'] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

const CLIENT_ID_PATTERN = /^\d{6,}-[a-z0-9]{8,}\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{12,}$/;

export const CLIENT_PROBLEM_CODES = [
  'invalid_client_id',
  'invalid_client_secret',
  'wrong_client_type',
  'redirect_uri_not_registered',
  'client_not_found',
  'unverified_response',
] as const;
export type ClientProblemCode = (typeof CLIENT_PROBLEM_CODES)[number];

export interface ClientProblem {
  code: ClientProblemCode;
  message: string;
}

const ClientKeysSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
  redirect_uris: z.array(z.string()).optional(),
});

/** Google nests the keys under `installed` for a Desktop app and `web` for a Web application. */
const ClientJsonSchema = z.union([z.object({ installed: ClientKeysSchema }), z.object({ web: ClientKeysSchema })]);

export interface ParsedClientJson {
  client_id: string;
  client_secret: string;
  client_type: ClientType;
  redirect_uris: string[];
}

/** Reads the downloaded client file; null when it is not a Desktop or Web client file. */
export function parseClientJson(raw: string): ParsedClientJson | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ClientJsonSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  const data = parsed.data;
  const isDesktop = 'installed' in data;
  const keys = 'installed' in data ? data.installed : data.web;
  return {
    client_id: keys.client_id,
    client_secret: keys.client_secret,
    client_type: isDesktop ? 'desktop' : 'web',
    redirect_uris: keys.redirect_uris ?? [],
  };
}

const CLIENT_TYPE_NAMES: Record<ClientType, string> = { desktop: 'Desktop app', web: 'Web application' };

/**
 * Everything wrong with the client that can be seen without asking Google. A client type that does not
 * fit this install is a problem on its own: a Web client cannot finish on an address Google refuses,
 * and a Desktop client cannot use a public callback.
 */
export function clientProblems(input: {
  client_id: string;
  client_secret: string;
  /** Null when only the id and secret were typed in; the type then cannot be checked. */
  client_type: ClientType | null;
  registered_redirect_uris: readonly string[];
  setup: GoogleSetupInfo;
}): ClientProblem[] {
  const problems: ClientProblem[] = [];
  if (!CLIENT_ID_PATTERN.test(input.client_id.trim())) {
    problems.push({
      code: 'invalid_client_id',
      message:
        'The client ID should look like 123456789-abcdefgh.apps.googleusercontent.com. Copy it again from the Google console.',
    });
  }
  if (!CLIENT_SECRET_PATTERN.test(input.client_secret.trim())) {
    problems.push({
      code: 'invalid_client_secret',
      message: 'The client secret looks incomplete. Copy the whole value from the Google console, with no spaces.',
    });
  }
  if (input.client_type !== null && input.client_type !== input.setup.client_type) {
    problems.push({
      code: 'wrong_client_type',
      message: `This is a ${CLIENT_TYPE_NAMES[input.client_type]} client, but this install needs a ${CLIENT_TYPE_NAMES[input.setup.client_type]}. Create a new client of the right type in the Google console.`,
    });
  } else if (
    input.setup.client_type === 'web' &&
    input.registered_redirect_uris.length > 0 &&
    !input.registered_redirect_uris.includes(input.setup.redirect_uri)
  ) {
    problems.push({
      code: 'redirect_uri_not_registered',
      message: `This Web client does not list ${input.setup.redirect_uri} as an authorized redirect URI. Add it in the Google console.`,
    });
  }
  return problems;
}
