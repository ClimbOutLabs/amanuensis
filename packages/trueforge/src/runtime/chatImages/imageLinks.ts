import { CHAT_IMAGE_MAX_PER_EMAIL } from './limits';

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTRIBUTE = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function webLink(raw: string): string | undefined {
  const src = decodeAttribute(raw).trim();
  return /^https?:\/\//i.test(src) ? src : undefined;
}

/**
 * The web links of the `<img src>` tags in an email body, de-duplicated, in order, at most the per-email
 * cap. Inline (`cid:`) and `data:` images are attachments, not links, so they are left out; so are
 * CSS backgrounds and `srcset`.
 */
export function emailImageUrls(html: string): string[] {
  const urls: string[] = [];
  for (const tag of html.match(IMG_TAG) ?? []) {
    const match = SRC_ATTRIBUTE.exec(tag);
    const raw = match?.[1] ?? match?.[2] ?? match?.[3];
    if (raw === undefined) {
      continue;
    }
    const src = webLink(raw);
    if (src === undefined || urls.includes(src)) {
      continue;
    }
    urls.push(src);
    if (urls.length >= CHAT_IMAGE_MAX_PER_EMAIL) {
      break;
    }
  }
  return urls;
}

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** Comparable form of a link: the parsed URL, so encoding differences between the reply and the page do not matter. */
export function normalizeImageLink(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** The web links a reply shows as images, from markdown image syntax and raw `<img src>` tags. */
export function replyImageUrls(text: string): Set<string> {
  const urls = new Set<string>();
  const add = (raw: string | undefined): void => {
    const link = raw === undefined ? undefined : webLink(raw);
    const normalized = link === undefined ? undefined : normalizeImageLink(link);
    if (normalized !== undefined) {
      urls.add(normalized);
    }
  };
  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    add(match[1]);
  }
  for (const tag of text.match(IMG_TAG) ?? []) {
    const match = SRC_ATTRIBUTE.exec(tag);
    add(match?.[1] ?? match?.[2] ?? match?.[3]);
  }
  return urls;
}
