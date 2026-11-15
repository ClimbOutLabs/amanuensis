import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { DriveApi } from '../../../src/core/drive/driveApi';
import { DriveToolSet } from '../../../src/core/drive/DriveToolSet';
import { GoogleAccessTokens } from '../../../src/core/google/GoogleAccessTokens';
import { GOOGLE_TOKEN_URL } from '../../../src/core/google/oauth';
import type { GoogleFeature } from '../../../src/core/google/scopes';
import type { ToolInvocationContext } from '../../../src/core/mcp/IMCPServer';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  forUnattendedRun,
} from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { connectedRecord, FakeConnections, OWNER } from '../google/fakes';

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export type Route = (url: URL, init: RequestInit | undefined) => Response | undefined;

/** A scripted stand-in for Google: answers by route, records every request URL and JSON body. */
export function scriptedGoogle(routes: Route[]) {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    urls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (
      typeof init?.body === 'string' &&
      (url.hostname === 'www.googleapis.com' ||
        url.hostname === 'docs.googleapis.com' ||
        url.hostname === 'sheets.googleapis.com')
    ) {
      bodies.push(JSON.parse(init.body));
    }
    if (url.href.startsWith(GOOGLE_TOKEN_URL)) {
      return Promise.resolve(json({ access_token: 'at', expires_in: 3600 }));
    }
    for (const route of routes) {
      const response = route(url, init);
      if (response !== undefined) {
        return Promise.resolve(response);
      }
    }
    return Promise.resolve(new Response('', { status: 404 }));
  };
  return { fetchImpl, urls, bodies };
}

export async function build(input: { routes: Route[]; features?: GoogleFeature[]; unattended?: boolean }) {
  const connections = new FakeConnections();
  await connections.save(
    connectedRecord({
      granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.file'],
    }),
  );
  const google = scriptedGoogle(input.routes);
  const api = new DriveApi({
    tokens: new GoogleAccessTokens({ now: undefined, connections, owner: OWNER, fetchImpl: google.fetchImpl }),
    fetchImpl: google.fetchImpl,
    sleep: () => Promise.resolve(),
  });
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  const sentinel = createSentinelHostContext({
    ...OWNER,
    conversation_id: 'c1',
    services: input.unattended === true ? forUnattendedRun(services) : services,
  });
  const tools = new DriveToolSet({
    tracing: NOOP_AGENT_TRACING,
    api,
    account: 'ada@example.com',
    features: input.features ?? ['gmail_read', 'drive_files'],
    sentinel,
  });
  return { tools, google, sentinel, connections };
}

export function text(response: Awaited<ReturnType<DriveToolSet['callTool']>>): string {
  if (!('result' in response)) {
    throw new Error('expected a tool result');
  }
  const [block] = response.result.content;
  return block?.type === 'text' ? block.text : '';
}

/** The route answers one exact path on any Google host. */
export const route =
  (path: string, body: unknown, status = 200): Route =>
  url =>
    url.pathname === path ? json(body, status) : undefined;

/**
 * What the host does before it runs an approved call: re-checks the approval minted for the card against the
 * call as the tool set sees it now. Returns why the approval no longer holds, or undefined when it still does.
 */
export async function approvalProblem(input: {
  tools: DriveToolSet;
  sentinel: ReturnType<typeof createSentinelHostContext>;
  info: Awaited<ReturnType<DriveToolSet['toolCallInfo']>>;
  call: CallToolRequest['params'];
}): Promise<string | undefined> {
  let live: Record<string, unknown> | undefined;
  try {
    live = await input.tools.liveMintParams(input.call);
  } catch {
    return 'The approved action could not be re-checked; request approval again.';
  }
  return await verifyPreDispatch({
    call: {
      tool_name: input.call.name,
      tool_type: input.info.type,
      canonical_params: live ?? input.call.arguments ?? {},
      tier: 3,
      approval_token_id: input.info.approval_token_id ?? null,
      approval_binding: null,
      shell_binding: null,
    },
    ctx: { ...input.sentinel, repository_id: null, agent_intent: null, offline: false },
  });
}

/** What the host hands a tool with an approved call: the params the approval was minted over. */
export function approvedContext(info: Awaited<ReturnType<DriveToolSet['toolCallInfo']>>): ToolInvocationContext {
  return {
    admission_provenance: { source: 'user_approval', decision: 'allow' },
    approved_params: info.mint_canonical_params,
  };
}

/** Google's 403 for a missing grant, as the API words it. */
export const INSUFFICIENT_SCOPE_BODY = {
  error: {
    code: 403,
    message: 'Request had insufficient authentication scopes.',
    status: 'PERMISSION_DENIED',
    errors: [{ message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' }],
  },
};

/** Google's error for an API that is not enabled in the project. */
export const API_OFF_BODY = {
  error: {
    code: 403,
    message: 'Google Drive API has not been used in project 123456789 before or it is disabled.',
    status: 'PERMISSION_DENIED',
    errors: [
      {
        message: 'Google Drive API has not been used in project 123456789 before or it is disabled.',
        domain: 'usageLimits',
        reason: 'accessNotConfigured',
      },
    ],
  },
};
