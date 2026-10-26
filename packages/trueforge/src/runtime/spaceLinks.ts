/**
 * The one check on links a space body adds. A new picture or link must pass the same check a web lookup
 * of that URL passes before it runs without asking: the outbound secret guard, and no private details in
 * the link. The link test weighs who loads the link. A link is opened only when the person follows it, so
 * it follows the lookup rule: read content may name it, but may not change it. A picture is loaded by the
 * person's own browser every time the space opens, so only a link the person, a search, or a page the chat
 * opened chose may be one. A picture must also be https and never name a placeholder domain. Links already
 * in the body before a write are left alone, so an unrelated edit never trips over an older picture.
 */
import { checkLookup, collectOutboundStrings, type WebSearchTurnState } from '@truefoundry/trueforge-core/core';
import type { z } from 'zod';
import type { SpaceFormatSchema } from '../schemas/space';
import { bodyLinks, type BodyLink } from './spaceBodyLinks';

/** Largest `data:` picture a space may embed, counted in characters of its URI. */
export const SPACE_PICTURE_DATA_MAX_CHARS = 32 * 1024;

const PLACEHOLDER_DOMAINS = ['example.com', 'example.org', 'example.net'];

/** A link the write refused; the message is the one the model reads and acts on. */
export class SpaceLinkRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpaceLinkRefusedError';
  }
}

const GUARD_RULE_MESSAGE =
  'This link cannot be used, because its text trips a safety check. Search for the page, then use a link from the results.';

const STEERED_LINK_MESSAGE =
  'This link was changed from what the page or message showed. Use the link exactly as it appeared, or search for it first.';

const UNCHOSEN_PICTURE_MESSAGE =
  "This picture did not come from the person, a search result, or a page this chat opened. Open the picture's page first, then use the image link from that page.";

const USERINFO_PICTURE_MESSAGE =
  "This picture's link carries a user name or password, so it cannot be used. Search for the picture, then use a link from the results.";

const PRIVATE_DETAIL_MESSAGE =
  "This link would carry one of the person's own private details. Take the detail out of the link, or search for the page first.";

const UNSTABLE_MARKUP_MESSAGE =
  'This page has markup that cannot be checked for links safely. Simplify the markup, then try again.';

/** Stands in for the page's own origin: a value that resolves to this host is local and never fetched from elsewhere. */
const PAGE_BASE = 'https://space-page.invalid/';

function nounOf(kind: BodyLink['kind']): string {
  return kind === 'picture' ? 'picture' : 'link';
}

export function isPlaceholder(host: string): boolean {
  return PLACEHOLDER_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

/**
 * The refusal for one new picture or link, or undefined when it may stay. The value is resolved
 * with the URL parser the browser uses, so a spelling a browser reads as a remote address is
 * checked as one, whatever its scheme separators look like.
 */
function refusalFor(
  { kind, value, tag }: BodyLink,
  input: { web_search: WebSearchTurnState; secrets: readonly string[] },
): string | undefined {
  // Scripts never run on a space page, whatever their source, so a script source is refused
  // outright rather than checked against the chat's results and then stripped at render.
  if (tag === 'script') {
    return 'Scripts never run on a space page. Use plain HTML and CSS instead.';
  }
  const noun = nounOf(kind);
  let url: URL;
  try {
    url = new URL(value, PAGE_BASE);
  } catch {
    return /^https?:/i.test(value)
      ? `This ${noun} has a link that cannot be read. Search for the ${noun} first, then use a link from the results.`
      : undefined;
  }
  if (url.protocol === 'data:') {
    if (kind === 'picture' && value.length > SPACE_PICTURE_DATA_MAX_CHARS) {
      return `This embedded picture is too large. Keep embedded pictures under ${String(SPACE_PICTURE_DATA_MAX_CHARS / 1024)} KB, or use a picture link from a search result.`;
    }
    return undefined;
  }
  if (url.hostname === new URL(PAGE_BASE).hostname) {
    return undefined;
  }
  if (kind === 'picture' && url.protocol !== 'https:') {
    return 'Pictures must use a secure https link. Search for the picture and use the https link from the results.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return undefined;
  }
  if (isPlaceholder(url.hostname)) {
    return `This ${noun} uses a placeholder domain (example.com or similar). Search for a real page and use its link.`;
  }
  // A picture is fetched as written, and the picture fetch refuses a link that carries a user
  // name or password, so such a picture could never load even where the clean link was chosen.
  if (kind === 'picture' && (url.username !== '' || url.password !== '')) {
    return USERINFO_PICTURE_MESSAGE;
  }
  // The lookup check compares the text the model wrote; a value the parser only resolved is checked as resolved.
  // A picture is an embed the person's browser loads, a link is a lookup the person chooses to open.
  const candidate = /^https?:\/\//i.test(value) ? value : url.href;
  const check = checkLookup({
    strings: collectOutboundStrings({ url: candidate }),
    secrets: input.secrets,
    earlier: input.web_search.sentText,
    provenance: input.web_search.provenance,
    use: kind === 'picture' ? 'embed' : 'lookup',
  });
  if (!check.verdict.ok) {
    return GUARD_RULE_MESSAGE;
  }
  if (check.steered.length > 0) {
    return kind === 'picture' ? UNCHOSEN_PICTURE_MESSAGE : STEERED_LINK_MESSAGE;
  }
  if (check.privateDetails.length > 0) {
    return PRIVATE_DETAIL_MESSAGE;
  }
  return undefined;
}

/**
 * Throws when a write adds a picture or link the chat's results do not support. Only links absent
 * from the body before the write are checked, so an edit that leaves older links alone never fails.
 */
export function refuseNewSpaceLinks(input: {
  body: string;
  previousBody: string;
  format: z.infer<typeof SpaceFormatSchema>;
  web_search: WebSearchTurnState;
  /** Exact secret values the host holds for this person, read by the outbound secret guard. */
  secrets: readonly string[];
}): void {
  const links = bodyLinks({ body: input.body, format: input.format });
  if (links === undefined) {
    throw new SpaceLinkRefusedError(UNSTABLE_MARKUP_MESSAGE);
  }
  const previous = new Set(
    (bodyLinks({ body: input.previousBody, format: input.format }) ?? []).map(
      link => `${link.kind}\u0000${link.value}`,
    ),
  );
  for (const link of links) {
    if (previous.has(`${link.kind}\u0000${link.value}`)) {
      continue;
    }
    const refusal = refusalFor(link, { web_search: input.web_search, secrets: input.secrets });
    if (refusal !== undefined) {
      throw new SpaceLinkRefusedError(refusal);
    }
  }
}
