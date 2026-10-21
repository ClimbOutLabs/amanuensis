/**
 * The one check on links a space body adds: a picture or a link must come from a search or page
 * result in this turn, be https when it is a picture, and never name a placeholder domain. A space
 * page loads its pictures from the host itself, so a made up or mail-borne link would send the
 * person's browser to that host. Links already in the body before a write are left alone, so an
 * unrelated edit never trips over an older picture.
 */
import { unreturnedUrls, type WebSearchTurnState } from '@truefoundry/trueforge-core/core';

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

interface BodyLink {
  kind: 'picture' | 'link';
  value: string;
}

const HTML_IMG_SRC = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const HTML_ANCHOR_HREF = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)/g;
const MARKDOWN_LINK = /(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)/g;
const DATA_URI = /^data:/i;
const ABSOLUTE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** Attribute values arrive entity-encoded; only the entities a URL carries are decoded here. */
function decodeEntities(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&#38;', '&').replaceAll('&#x26;', '&');
}

function matchesAll(pattern: RegExp, body: string, kind: BodyLink['kind']): BodyLink[] {
  return [...body.matchAll(pattern)].map(match => ({
    kind,
    value: decodeEntities(match[1] ?? match[2] ?? match[3] ?? ''),
  }));
}

/** Every picture and link a body names: `<img src>`, markdown images, `<a href>`, and markdown links. */
function bodyLinks(body: string): BodyLink[] {
  return [
    ...matchesAll(HTML_IMG_SRC, body, 'picture'),
    ...matchesAll(MARKDOWN_IMAGE, body, 'picture'),
    ...matchesAll(HTML_ANCHOR_HREF, body, 'link'),
    ...matchesAll(MARKDOWN_LINK, body, 'link'),
  ];
}

function nounOf(kind: BodyLink['kind']): string {
  return kind === 'picture' ? 'picture' : 'link';
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isPlaceholder(host: string): boolean {
  return PLACEHOLDER_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

/** The refusal for one new picture or link, or undefined when it may stay. */
function refusalFor({ kind, value }: BodyLink, web_search: WebSearchTurnState): string | undefined {
  if (DATA_URI.test(value)) {
    if (kind === 'picture' && value.length > SPACE_PICTURE_DATA_MAX_CHARS) {
      return `This embedded picture is too large. Keep embedded pictures under ${String(SPACE_PICTURE_DATA_MAX_CHARS / 1024)} KB, or use a picture link from a search result.`;
    }
    return undefined;
  }
  if (!ABSOLUTE_URL.test(value)) {
    return undefined;
  }
  if (kind === 'picture' && !/^https:\/\//i.test(value)) {
    return 'Pictures must use a secure https link. Search for the picture and use the https link from the results.';
  }
  if (!/^https?:\/\//i.test(value)) {
    return undefined;
  }
  const noun = nounOf(kind);
  const host = hostOf(value);
  if (host === undefined) {
    return `This ${noun} has a link that cannot be read. Search for the ${noun} first, then use a link from the results.`;
  }
  if (isPlaceholder(host)) {
    return `This ${noun} uses a placeholder domain (example.com or similar). Search for a real page and use its link.`;
  }
  if (unreturnedUrls({ values: [value], state: web_search }).length > 0) {
    return `This ${noun}'s link did not come from a search or page in this chat. Search for the ${noun} first, then use a link from the results.`;
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
  web_search: WebSearchTurnState;
}): void {
  const previous = new Set(bodyLinks(input.previousBody).map(link => `${link.kind}\u0000${link.value}`));
  for (const link of bodyLinks(input.body)) {
    if (previous.has(`${link.kind}\u0000${link.value}`)) {
      continue;
    }
    const refusal = refusalFor(link, input.web_search);
    if (refusal !== undefined) {
      throw new SpaceLinkRefusedError(refusal);
    }
  }
}
