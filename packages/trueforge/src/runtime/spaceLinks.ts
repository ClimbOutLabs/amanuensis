/**
 * The one check on links a space body adds: a picture or a link must come from the person or a search
 * result in this chat, be https when it is a picture, and never name a placeholder domain. A space
 * page loads its pictures from the host itself, so a made up or mail-borne link would send the
 * person's browser to that host. Links already in the body before a write are left alone, so an
 * unrelated edit never trips over an older picture. A new picture or link the chat never saw is
 * taken out of the write, not a reason to refuse it.
 */
import { isTrustedLink, isTrustedPicture, type WebSearchTurnState } from '@truefoundry/trueforge-core/core';
import type { z } from 'zod';
import type { SpaceFormatSchema } from '../schemas/space';
import { bodyLinks, type BodyLink } from './spaceBodyLinks';
import { removeLinks } from './spaceLinkRemoval';

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

/** What the check decides for one new picture or link: leave it, take it out, or refuse the write. */
type Verdict = { type: 'unseen'; message: string } | { type: 'refused'; message: string };

/**
 * The verdict for one new picture or link, or undefined when it may stay. The value is resolved
 * with the URL parser the browser uses, so a spelling a browser reads as a remote address is
 * checked as one, whatever its scheme separators look like.
 */
function verdictFor({ kind, value, tag }: BodyLink, web_search: WebSearchTurnState): Verdict | undefined {
  const refuse = (message: string): Verdict => ({ type: 'refused', message });
  // Scripts never run on a space page, whatever their source, so a script source is refused
  // outright rather than checked against the chat's results and then stripped at render.
  if (tag === 'script') {
    return refuse('Scripts never run on a space page. Use plain HTML and CSS instead.');
  }
  const noun = nounOf(kind);
  let url: URL;
  try {
    url = new URL(value, PAGE_BASE);
  } catch {
    return /^https?:/i.test(value)
      ? refuse(
          `This ${noun} has a link that cannot be read. Search for the ${noun} first, then use a link from the results.`,
        )
      : undefined;
  }
  if (url.protocol === 'data:') {
    if (kind === 'picture' && value.length > SPACE_PICTURE_DATA_MAX_CHARS) {
      return refuse(
        `This embedded picture is too large. Keep embedded pictures under ${String(SPACE_PICTURE_DATA_MAX_CHARS / 1024)} KB, or use a picture link from a search result.`,
      );
    }
    return undefined;
  }
  if (url.hostname === new URL(PAGE_BASE).hostname) {
    return undefined;
  }
  if (kind === 'picture' && url.protocol !== 'https:') {
    return refuse(
      'Pictures must use a secure https link. Search for the picture and use the https link from the results.',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return undefined;
  }
  if (isPlaceholder(url.hostname)) {
    return refuse(
      `This ${noun} uses a placeholder domain (example.com or similar). Search for a real page and use its link.`,
    );
  }
  // The seen-URL rule compares the text the model wrote; a value the parser only resolved is compared as resolved.
  const candidate = /^https?:\/\//i.test(value) ? value : url.href;
  const trusted = kind === 'picture' ? isTrustedPicture : isTrustedLink;
  if (!trusted({ provenance: web_search.provenance, url: candidate })) {
    return {
      type: 'unseen',
      message:
        kind === 'picture'
          ? 'This picture does not come from a page you opened or a search result in this chat. Open the page that shows it and use its picture link, or leave the picture out.'
          : 'This link does not come from a search result in this chat, so the page cannot use it. Use a link from a search result, or leave the link out.',
    };
  }
  return undefined;
}

/** Most rounds of removal before the write is refused: nested markup can reveal a link only after an outer one goes. */
const MAX_REMOVAL_ROUNDS = 6;

/** What a write dropped: the body to save and how many links and pictures were taken out. */
export interface DroppedLinks {
  body: string;
  links: number;
  pictures: number;
}

const linkKey = (link: BodyLink): string => `${link.kind}\u0000${link.value}`;

/**
 * Takes out every new picture or link the chat's results do not support and returns the body to
 * save. A link keeps its text; a picture keeps its alt text. Other problems (scripts, placeholder
 * domains, plain http pictures, oversize embedded pictures, unreadable markup) still throw. The
 * result is checked again, so it never holds an unseen address. Only links absent from the body
 * before the write are checked, so an edit that leaves older links alone never loses them.
 */
export function dropUnseenSpaceLinks(input: {
  body: string;
  previousBody: string;
  format: z.infer<typeof SpaceFormatSchema>;
  web_search: WebSearchTurnState;
}): DroppedLinks {
  const previous = new Set((bodyLinks({ body: input.previousBody, format: input.format }) ?? []).map(linkKey));
  let body = input.body;
  let removedLinks = 0;
  let removedPictures = 0;
  let lastMessage = '';
  for (let round = 0; round < MAX_REMOVAL_ROUNDS; round += 1) {
    const links = bodyLinks({ body, format: input.format });
    if (links === undefined) {
      throw new SpaceLinkRefusedError(UNSTABLE_MARKUP_MESSAGE);
    }
    const unseen = new Set<string>();
    for (const link of links) {
      if (previous.has(linkKey(link))) {
        continue;
      }
      const verdict = verdictFor(link, input.web_search);
      if (verdict?.type === 'refused') {
        throw new SpaceLinkRefusedError(verdict.message);
      }
      if (verdict !== undefined) {
        unseen.add(linkKey(link));
        lastMessage = verdict.message;
      }
    }
    if (unseen.size === 0) {
      return { body, links: removedLinks, pictures: removedPictures };
    }
    const removal = removeLinks({ body, format: input.format, drop: link => unseen.has(linkKey(link)) });
    if (removal === undefined || removal.body === body) {
      throw new SpaceLinkRefusedError(lastMessage);
    }
    body = removal.body;
    removedLinks += removal.links;
    removedPictures += removal.pictures;
  }
  throw new SpaceLinkRefusedError(lastMessage);
}
