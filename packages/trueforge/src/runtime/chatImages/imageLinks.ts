import { decodeEntities, htmlImageLinks } from '@truefoundry/trueforge-core/core/email/gmail/htmlText';

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** Raw `<img>` tags in one reply that are read; a reply has far fewer. */
const MAX_REPLY_HTML_IMAGES = 100;

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
  const add = (raw: string): void => {
    const normalized = normalizeImageLink(decodeEntities(raw).trim());
    if (normalized !== undefined) {
      urls.add(normalized);
    }
  };
  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    if (match[1] !== undefined) {
      add(match[1]);
    }
  }
  for (const link of htmlImageLinks({ source: text, max: MAX_REPLY_HTML_IMAGES })) {
    add(link);
  }
  return urls;
}
