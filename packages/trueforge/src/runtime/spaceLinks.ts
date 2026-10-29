/**
 * The one check on links a space body adds: a picture or a link must come from the person or a search
 * result in this chat, be https when it is a picture, and never name a placeholder domain. A space
 * page loads its pictures from the host itself, so a made up or mail-borne link would send the
 * person's browser to that host. Links already in the body before a write are left alone, so an
 * unrelated edit never trips over an older picture.
 */
import { isTrustedLink, isTrustedPicture, type WebSearchTurnState } from '@truefoundry/trueforge-core/core';
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
function refusalFor({ kind, value, tag }: BodyLink, web_search: WebSearchTurnState): string | undefined {
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
  // The seen-URL rule compares the text the model wrote; a value the parser only resolved is compared as resolved.
  const candidate = /^https?:\/\//i.test(value) ? value : url.href;
  const trusted = kind === 'picture' ? isTrustedPicture : isTrustedLink;
  if (!trusted({ provenance: web_search.provenance, url: candidate })) {
    if (kind === 'picture') {
      return 'This picture does not come from a page you opened or a search result in this chat. Open the page that shows it and use its picture link, or leave the picture out.';
    }
    return 'This link does not come from a search result in this chat, so the page cannot use it. Use a link from a search result, or leave the link out. For a picture, use a picture file from a page you opened or a search result, or leave pictures out.';
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
    const refusal = refusalFor(link, input.web_search);
    if (refusal !== undefined) {
      throw new SpaceLinkRefusedError(refusal);
    }
  }
}
