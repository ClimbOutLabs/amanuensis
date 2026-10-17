/**
 * How Google sends the user back to Aman, which decides what kind of client the user creates. Google only
 * accepts a public https address (or a loopback address, for a Desktop app) as the place to return to, and
 * the default install is reached by any LAN, Tailscale or host name, so three modes exist:
 *  - web: this install has a public https address and the browser is on it. The user makes a Web client with
 *    that exact callback; a browser anywhere else would arrive at that address without its session.
 *  - loopback: the browser is on this machine. A Desktop client returns straight to this server.
 *  - paste: the browser is elsewhere. A Desktop client returns to an address that cannot load, and the user
 *    pastes that address back so the code and state can be read from it.
 */
import { z } from 'zod';
import { CLIENT_TYPES } from './clientJson.js';

export const GOOGLE_CALLBACK_PATH = '/api/v1/user/settings/google/oauth/callback';

/** Where a paste-mode consent ends: an address nothing serves, whose bar holds the code and state. */
export const PASTE_REDIRECT_URI = 'http://127.0.0.1:53682/callback';

const PASTE_REDIRECT_HOST_AND_PATH = PASTE_REDIRECT_URI.replace(/^http:\/\//, '');

const GOOGLE_SETUP_MODES = ['web', 'loopback', 'paste'] as const;

export const GoogleSetupInfoSchema = z.object({
  mode: z
    .enum(GOOGLE_SETUP_MODES)
    .describe(
      'web: this install has a public https address and a Web client returns to it. loopback: the browser is on this machine. paste: the user pastes the address Google sends the browser to.',
    ),
  client_type: z.enum(CLIENT_TYPES).describe('The kind of Google client this install needs.'),
  redirect_uri: z.string().describe('The exact redirect URI to register (Web client) or that the consent returns to.'),
});
export type GoogleSetupInfo = z.infer<typeof GoogleSetupInfoSchema>;

/** Names Google treats as private even though they look public: a Tailscale name is only reachable on its tailnet. */
const PRIVATE_DOMAINS = ['ts.net'];

const PRIVATE_NAME_SUFFIXES = [
  'local',
  'localhost',
  'internal',
  'lan',
  'home',
  'localdomain',
  'corp',
  'intranet',
  'private',
  'test',
  'example',
  'invalid',
  'arpa',
];

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * The base address when it is a public https origin Google will accept as a Web client redirect (a real
 * dotted host name that is not an IP address or a private-network name); null otherwise.
 */
export function publicHttpsBase(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (PRIVATE_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    return null;
  }
  const labels = url.hostname.split('.');
  const suffix = labels[labels.length - 1] ?? '';
  const isPublicName =
    labels.length >= 2 &&
    !isIpLiteral(url.hostname) &&
    /^[a-z]{2,}$/.test(suffix) &&
    !PRIVATE_NAME_SUFFIXES.includes(suffix);
  if (url.protocol !== 'https:' || !isPublicName) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

export function resolveGoogleSetup(input: { public_base_url: string; request_url: string }): GoogleSetupInfo {
  const publicBase = publicHttpsBase(input.public_base_url);
  const request = new URL(input.request_url);
  if (publicBase !== null && new URL(publicBase).origin === request.origin) {
    return { mode: 'web', client_type: 'web', redirect_uri: `${publicBase}${GOOGLE_CALLBACK_PATH}` };
  }
  if (isLoopbackHostname(request.hostname)) {
    return { mode: 'loopback', client_type: 'desktop', redirect_uri: `${request.origin}${GOOGLE_CALLBACK_PATH}` };
  }
  return { mode: 'paste', client_type: 'desktop', redirect_uri: PASTE_REDIRECT_URI };
}

type PastedAddress = { ok: true; code: string; state: string } | { ok: false; message: string };

/** Reads the code and state out of the address the user copied from the browser bar after consent. */
export function parsePastedAddress(text: string): PastedAddress {
  let url: URL;
  const trimmed = text.trim();
  // Safari hides the scheme, so an address copied from it starts at the host; only the return address is completed.
  const complete = trimmed.startsWith(PASTE_REDIRECT_HOST_AND_PATH) ? `http://${trimmed}` : trimmed;
  try {
    url = new URL(complete);
  } catch {
    return {
      ok: false,
      message: 'That is not a web address. Copy the whole address from the browser bar, starting with http.',
    };
  }
  // Any other page is refused before its parameters are read, so it can never use up the attempt in progress.
  if (`${url.origin}${url.pathname}` !== PASTE_REDIRECT_URI) {
    return {
      ok: false,
      message: `That is not the page Google sent you to. Copy the address from the page that failed to load; it starts with ${PASTE_REDIRECT_URI}.`,
    };
  }
  const error = url.searchParams.get('error');
  if (error !== null) {
    return { ok: false, message: 'Google did not grant access. Start again and approve the request.' };
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (code === null || code === '' || state === null || state === '') {
    return {
      ok: false,
      message: 'That address has no code or state in it. Copy the whole address from the page that failed to load.',
    };
  }
  return { ok: true, code, state };
}
