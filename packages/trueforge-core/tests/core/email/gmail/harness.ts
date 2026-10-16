import { DraftReviewLedger } from '../../../../src/core/email/gmail/draftReview';
import { GmailApi } from '../../../../src/core/email/gmail/gmailApi';
import { GmailToolSet, type AttachmentStager } from '../../../../src/core/email/gmail/GmailToolSet';
import { GoogleAccessTokens } from '../../../../src/core/google/GoogleAccessTokens';
import { GOOGLE_TOKEN_URL } from '../../../../src/core/google/oauth';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  forUnattendedRun,
} from '../../../../src/core/permissions/context';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { connectedRecord, FakeConnections, OWNER } from '../../google/fakes';

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export type Route = (url: URL, init: RequestInit | undefined) => Response | undefined;

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
  reviews?: DraftReviewLedger;
}) {
  const connections = new FakeConnections();
  await connections.save(connectedRecord());
  const google = scriptedGoogle(input.routes);
  const api = new GmailApi({
    tokens: new GoogleAccessTokens({ connections, owner: OWNER, fetchImpl: google.fetchImpl }),
    fetchImpl: google.fetchImpl,
  });
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  const sentinel = createSentinelHostContext({
    ...OWNER,
    conversation_id: 'c1',
    services: input.unattended === true ? forUnattendedRun(services) : services,
  });
  const reviews = input.reviews ?? new DraftReviewLedger();
  const tools = new GmailToolSet({
    tracing: NOOP_AGENT_TRACING,
    api,
    account: 'ada@example.com',
    features: input.features ?? ['gmail_read'],
    attachmentStager: input.stager,
    sentinel,
    reviews,
  });
  return { tools, google, sentinel, connections, reviews };
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
