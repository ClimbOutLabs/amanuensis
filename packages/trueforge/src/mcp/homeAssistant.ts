/**
 * The Home Assistant preset: from the address and long-lived access token the person pastes,
 * Aman builds the MCP endpoint itself, and a connection check says in one line whether the home
 * answered or what to fix. The token travels in the manifest's Authorization header, stored and
 * redacted like every other MCP header secret; nothing here logs it or returns it.
 */
import { McpConnectionError } from '@truefoundry/trueforge-core/core';
import { isHomeAssistantLiveContextTool } from '@truefoundry/trueforge-core/core/homeassistant/toolContract';
import { isPrivateNetworkHost } from '../config';
import type { HomeAssistantCheckResult } from '../schemas/homeAssistant';

/** The path Home Assistant's Model Context Protocol Server integration serves its SSE endpoint on. */
export const HOME_ASSISTANT_ENDPOINT_PATH = '/mcp_server/sse';

const CERTIFICATE_MESSAGE_PATTERN =
  /certificate|self[-\s]?signed|unable to verify|depth_zero|err_tls|cert_/i;

function addressProblemForProtocol(input: { protocol: string; hostname: string }): string | null {
  if (input.protocol === 'https:') {
    return null;
  }
  if (input.protocol === 'http:') {
    return isPrivateNetworkHost(input.hostname)
      ? null
      : 'That address is not on your home network, so it needs https. Use the https address, or connect on your home network.';
  }
  return 'The address must start with https://, or with http:// on your home network.';
}

/**
 * The endpoint Aman dials for the address the person pasted, or the one problem with it. An
 * address with no scheme is read as http, the way Home Assistant on a home network is reached;
 * the protocol rule then still refuses http anywhere but a private or loopback address.
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
  const problem = addressProblemForProtocol({ protocol: parsed.protocol, hostname: parsed.hostname });
  if (problem !== null) {
    return { problem };
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  const endpointPath = path.endsWith(HOME_ASSISTANT_ENDPOINT_PATH) ? path : `${path}${HOME_ASSISTANT_ENDPOINT_PATH}`;
  return { url: `${parsed.origin}${endpointPath}` };
}

/**
 * The problem with a stored Home Assistant endpoint, or null when it is one Aman may dial: the
 * preset's own path, over https, or over http only on a private or loopback address.
 */
export function homeAssistantUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'The Home Assistant address could not be read. Check it and try again.';
  }
  if (!parsed.pathname.replace(/\/+$/, '').endsWith(HOME_ASSISTANT_ENDPOINT_PATH)) {
    return `A Home Assistant connector must point at its ${HOME_ASSISTANT_ENDPOINT_PATH} address.`;
  }
  return addressProblemForProtocol({ protocol: parsed.protocol, hostname: parsed.hostname });
}

/** The part of an MCP client the check drives: the handshake's tool list and one tool call. */
export interface HomeAssistantProbeClient {
  listTools(): Promise<{ tools: readonly { name: string }[] } | { authRequired: true }>;
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<
    { texts: readonly string[] } | { authRequired: true }
  >;
}

/** Exposed entities in a live-context answer: one line each, starting with a dash. */
export function countHomeAssistantEntities(liveContextText: string): number {
  return liveContextText.split('\n').filter(line => line.trimStart().startsWith('- ')).length;
}

const TOKEN_REFUSED_REASON =
  'Home Assistant refused the token. Make a new long-lived access token in Home Assistant, then paste it here.';
const INTEGRATION_MISSING_REASON =
  'Home Assistant answered, but the Model Context Protocol Server integration is not installed. ' +
  'Add it in Home Assistant under Settings, Devices and services, then try again.';
const CERTIFICATE_REASON =
  'The address uses a certificate that cannot be checked, often a self-signed one. ' +
  'Use the http address on your home network, or the https address Tailscale gives your Home Assistant, then try again.';
const UNREACHABLE_REASON =
  'Nothing answered at that address. Check the address and that Home Assistant is running, then try again.';

/**
 * The one fix for a failed dial, classified from the connection error the MCP client raised.
 * When both transports fail the client wraps them into one 502 whose message carries each
 * transport's HTTP status, so the statuses are read from the message as well as the code.
 */
export function classifyHomeAssistantFailure(error: unknown): { code: 'unreachable' | 'token_refused' | 'integration_missing' | 'certificate' | 'error'; reason: string } {
  if (error instanceof McpConnectionError) {
    if (error.statusCode === 401 || error.statusCode === 403 || /\b40[13]\b/.test(error.message)) {
      return { code: 'token_refused', reason: TOKEN_REFUSED_REASON };
    }
    if (error.statusCode === 404 || /\b404\b/.test(error.message)) {
      return { code: 'integration_missing', reason: INTEGRATION_MISSING_REASON };
    }
    if (CERTIFICATE_MESSAGE_PATTERN.test(error.message)) {
      return { code: 'certificate', reason: CERTIFICATE_REASON };
    }
    return { code: 'unreachable', reason: UNREACHABLE_REASON };
  }
  if (error instanceof Error && CERTIFICATE_MESSAGE_PATTERN.test(error.message)) {
    return { code: 'certificate', reason: CERTIFICATE_REASON };
  }
  return { code: 'error', reason: 'The connection check failed. Try again.' };
}

/**
 * One live check of a saved Home Assistant connector: handshake, tool list, and one live-context
 * read for the exposed entity count. Changes nothing, and never carries the token anywhere.
 */
export async function checkHomeAssistant(client: HomeAssistantProbeClient): Promise<HomeAssistantCheckResult> {
  let tools: readonly { name: string }[];
  try {
    const listed = await client.listTools();
    if ('authRequired' in listed) {
      return { status: 'failed', code: 'token_refused', reason: TOKEN_REFUSED_REASON };
    }
    tools = listed.tools;
  } catch (error) {
    return { status: 'failed', ...classifyHomeAssistantFailure(error) };
  }
  const liveContext = tools.find(tool => isHomeAssistantLiveContextTool(tool.name));
  if (liveContext === undefined) {
    return { status: 'ok', tool_count: tools.length, entity_count: null };
  }
  try {
    const result = await client.callTool({ name: liveContext.name, arguments: {} });
    if ('authRequired' in result) {
      return { status: 'failed', code: 'token_refused', reason: TOKEN_REFUSED_REASON };
    }
    return {
      status: 'ok',
      tool_count: tools.length,
      entity_count: countHomeAssistantEntities(result.texts.join('\n')),
    };
  } catch (error) {
    return { status: 'failed', ...classifyHomeAssistantFailure(error) };
  }
}
