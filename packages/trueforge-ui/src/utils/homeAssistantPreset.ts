/**
 * The Home Assistant preset's address rule, as the connect form applies it before anything is
 * saved: the endpoint Aman dials is the address plus `/mcp_server/sse`, over https, or over http
 * only on a private or loopback address (Home Assistant on a home network is usually http). The
 * server applies the same rule again when the connector is saved, so the two cannot drift into
 * saving something the server would refuse.
 */

const ENDPOINT_PATH = '/mcp_server/sse';

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) {
    return true;
  }
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** Whether the host is this computer or sits on a private network, matching the server's rule. */
function isPrivateNetworkHost(host: string): boolean {
  const lowered = host.trim().toLowerCase();
  const bare = lowered.startsWith('[') && lowered.endsWith(']') ? lowered.slice(1, -1) : lowered;
  if (bare === 'localhost' || bare === '::1') {
    return true;
  }
  if (isIpv4(bare)) {
    return isPrivateIpv4(bare);
  }
  if (bare.includes(':')) {
    return false;
  }
  return !bare.includes('.') || bare.endsWith('.local') || bare.endsWith('.ts.net');
}

/**
 * The endpoint for the address the person typed, or the one problem with it. An address with no
 * scheme is read as http, the way Home Assistant on a home network is reached.
 */
export function buildHomeAssistantEndpoint(address: string): { url: string } | { problem: string } {
  const trimmed = address.trim();
  if (trimmed === '') {
    return { problem: 'Type the address of your Home Assistant, like https://homeassistant.local:8123.' };
  }
  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { problem: 'That address could not be read. Check it and try again.' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { problem: 'The address must not include a name or password. Paste only the address.' };
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { problem: 'The address must not include a query or a fragment. Paste only the address.' };
  }
  if (parsed.protocol === 'http:' && !isPrivateNetworkHost(parsed.hostname)) {
    return {
      problem:
        'That address is not on your home network, so it needs https. Use the https address, or connect on your home network.',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { problem: 'The address must start with https://, or with http:// on your home network.' };
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  const endpointPath = path.endsWith(ENDPOINT_PATH) ? path : `${path}${ENDPOINT_PATH}`;
  return { url: `${parsed.origin}${endpointPath}` };
}
