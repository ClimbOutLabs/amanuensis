import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GmailApi } from '../../../../src/core/email/gmail/gmailApi';
import { GmailToolSet, type AttachmentStager } from '../../../../src/core/email/gmail/GmailToolSet';
import type { GmailThread } from '../../../../src/core/email/gmail/gmailWire';
import { GoogleAccessTokens } from '../../../../src/core/google/GoogleAccessTokens';
import { GOOGLE_TOKEN_URL } from '../../../../src/core/google/oauth';
import type { ToolInvocationContext } from '../../../../src/core/mcp/IMCPServer';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  forUnattendedRun,
} from '../../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../../src/core/permissions/dispatch';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { connectedRecord, FakeConnections, OWNER } from '../../google/fakes';

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** `HANG` is a request Google never answers. */
export const HANG = 'hang';
export type Route = (url: URL, init: RequestInit | undefined) => Response | typeof HANG | undefined;

/** A scripted stand-in for Google: answers by route, records every request. */
export function scriptedGoogle(routes: Route[]) {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    urls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (typeof init?.body === 'string' && url.hostname === 'gmail.googleapis.com') {
      bodies.push(JSON.parse(init.body));
    }
    if (url.href.startsWith(GOOGLE_TOKEN_URL)) {
      return Promise.resolve(json({ access_token: 'at', expires_in: 3600 }));
    }
    for (const route of routes) {
      const response = route(url, init);
      if (response === HANG) {
        return new Promise<Response>(() => undefined);
      }
      if (response !== undefined) {
        return Promise.resolve(response);
      }
    }
    return Promise.resolve(new Response('', { status: 404 }));
  };
  return { fetchImpl, urls, bodies };
}

export async function build(input: {
  routes: Route[];
  features?: ('gmail_read' | 'gmail_compose')[];
  stager?: AttachmentStager | undefined;
  unattended?: boolean;
  listDeadlineMs?: number;
}) {
  const connections = new FakeConnections();
  await connections.save(connectedRecord());
  const google = scriptedGoogle(input.routes);
  const sleeps: number[] = [];
  const api = new GmailApi({
    tokens: new GoogleAccessTokens({ now: undefined, connections, owner: OWNER, fetchImpl: google.fetchImpl }),
    fetchImpl: google.fetchImpl,
    sleep: ms => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  const sentinel = createSentinelHostContext({
    ...OWNER,
    conversation_id: 'c1',
    services: input.unattended === true ? forUnattendedRun(services) : services,
  });
  const tools = new GmailToolSet({
    tracing: NOOP_AGENT_TRACING,
    api,
    account: 'ada@example.com',
    features: input.features ?? ['gmail_read'],
    attachmentStager: input.stager,
    sentinel,
    listDeadlineMs: input.listDeadlineMs ?? 60_000,
  });
  return { tools, google, sentinel, connections, sleeps };
}

export function text(response: Awaited<ReturnType<GmailToolSet['callTool']>>): string {
  if (!('result' in response)) {
    throw new Error('expected a tool result');
  }
  const [block] = response.result.content;
  return block?.type === 'text' ? block.text : '';
}

export const route =
  (path: string, body: unknown, status = 200): Route =>
  url =>
    url.pathname === `/gmail/v1/users/me${path}` ? json(body, status) : undefined;

const escapeSnippet = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The thread as Gmail answers a request for `format`: `metadata` carries only the requested headers, a part id
 * and a body size (never the text), and the snippet is HTML-escaped plain text, as Gmail serves it.
 */
export function gmailThreadResponse(input: { thread: GmailThread; url: URL }): unknown {
  const format = input.url.searchParams.get('format');
  const wanted = input.url.searchParams.getAll('metadataHeaders').map(name => name.toLowerCase());
  return {
    id: input.thread.id,
    historyId: '1001',
    messages: (input.thread.messages ?? []).map(mail => {
      const snippet = escapeSnippet(mail.snippet ?? '');
      if (format !== 'metadata' || mail.payload === undefined) {
        return { ...mail, snippet };
      }
      return {
        id: mail.id,
        threadId: mail.threadId,
        labelIds: mail.labelIds,
        snippet,
        internalDate: mail.internalDate,
        historyId: '1001',
        sizeEstimate: 2048,
        payload: {
          partId: '',
          mimeType: mail.payload.mimeType,
          filename: '',
          headers: (mail.payload.headers ?? []).filter(header => wanted.includes(header.name.toLowerCase())),
          body: { size: 0 },
        },
      };
    }),
  };
}

/** Gmail's 403 for a missing grant, as the API words it. */
export const INSUFFICIENT_SCOPE_BODY = {
  error: {
    code: 403,
    message: 'Request had insufficient authentication scopes.',
    status: 'PERMISSION_DENIED',
    errors: [{ message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' }],
  },
};

export const googleError = (input: { status: number; reason: string; message?: string }) => ({
  error: {
    code: input.status,
    message: input.message ?? 'Request failed.',
    errors: [{ message: input.message ?? 'Request failed.', domain: 'usageLimits', reason: input.reason }],
  },
});

const DraftRequestSchema = z.object({ message: z.object({ raw: z.string(), threadId: z.string().optional() }) });

/** The draft Aman asked Gmail to store: its decoded MIME text and thread. */
export function sentDraft(body: unknown): { mime: string; threadId: string | undefined } {
  const request = DraftRequestSchema.parse(body);
  return { mime: Buffer.from(request.message.raw, 'base64url').toString(), threadId: request.message.threadId };
}

/**
 * What the host does before it runs an approved call: re-checks the approval minted for the card against the
 * call as the tool set sees it now. Returns why the approval no longer holds, or undefined when it still does.
 */
export async function approvalProblem(input: {
  tools: GmailToolSet;
  sentinel: ReturnType<typeof createSentinelHostContext>;
  info: Awaited<ReturnType<GmailToolSet['toolCallInfo']>>;
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
export function approvedContext(info: Awaited<ReturnType<GmailToolSet['toolCallInfo']>>): ToolInvocationContext {
  return {
    admission_provenance: { source: 'user_approval', decision: 'allow' },
    approved_params: info.mint_canonical_params,
  };
}
