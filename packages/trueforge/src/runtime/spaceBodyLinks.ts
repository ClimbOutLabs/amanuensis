/**
 * Every URL a space body could make the browser fetch or follow. HTML is read by parse5 with
 * scripting off, the mode the client's DOMParser uses, so a spelling the parser accepts (upper
 * case, entity-encoded, unquoted, slash-separated) is seen as the browser sees it. Markdown is read
 * by the remark stack the renderer uses, and each raw HTML node in it goes through the same reader.
 * Any attribute or CSS value that could load or follow a URL counts, whatever its name, so an
 * unlisted spelling is checked rather than skipped.
 */
import { decodeCssEscapes } from '@truefoundry/trueforge-core/core/spaces/cssEscapes';
import type { Nodes } from 'mdast';
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { z } from 'zod';
import type { SpaceFormatSchema } from '../schemas/space';

/** A URL in a body. `picture` loads on its own (so it must be https); `link` is only followed on click. */
export interface BodyLink {
  kind: 'picture' | 'link';
  value: string;
  /** The element the URL came from, when the check needs it: only `script` changes the refusal. */
  tag?: string;
}

type HtmlNode = DefaultTreeAdapterMap['node'];

/** Attributes whose URL the browser only follows when the person clicks. */
const NAVIGABLE_ATTRIBUTES = new Set(['action', 'cite', 'formaction', 'longdesc', 'ping']);

/** Attributes whose URL the browser loads on its own, so it is checked as a picture. */
const LOADED_ATTRIBUTES = new Set([
  'archive',
  'background',
  'classid',
  'codebase',
  'data',
  'dynsrc',
  'href',
  'icon',
  'lowsrc',
  'manifest',
  'poster',
  'src',
  'usemap',
  'xlink:href',
]);

/** A value that names a host or a web scheme, which a bare attribute value must be checked for. */
const NAMES_A_WEB_HOST = /^(?:https?:|[\\/]{2})/i;

const CSS_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/g;
const CSS_URL_CALL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))/gi;
const CSS_STRING = /"([^"]*)"|'([^']*)'/g;

/**
 * The value as a browser reads it before resolving it: tabs and line breaks removed anywhere, and
 * the C0 controls and spaces at either end dropped. The seen-URL check compares this exact text.
 */
function cleanUrl(raw: string): string {
  const value = raw.replace(/[\t\n\r]/g, '');
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  return value.slice(start, end);
}

function picture(raw: string): BodyLink {
  return { kind: 'picture', value: cleanUrl(raw) };
}

function link(raw: string): BodyLink {
  return { kind: 'link', value: cleanUrl(raw) };
}

/** Every URL a CSS text could fetch: `url(...)` arguments, and quoted strings that name a host. */
function cssLinks(css: string): BodyLink[] {
  const decoded = decodeCssEscapes(css.replace(CSS_COMMENT, ''));
  const links: BodyLink[] = [];
  for (const match of decoded.matchAll(CSS_URL_CALL)) {
    links.push(picture(match[1] ?? match[2] ?? match[3] ?? ''));
  }
  for (const match of decoded.matchAll(CSS_STRING)) {
    const value = match[1] ?? match[2] ?? '';
    if (NAMES_A_WEB_HOST.test(cleanUrl(value))) {
      links.push(picture(value));
    }
  }
  return links;
}

/** The candidate URLs of a `srcset`: each is a URL followed by optional descriptors, comma-separated. */
function srcsetLinks(srcset: string): BodyLink[] {
  const links: BodyLink[] = [];
  let index = 0;
  while (index < srcset.length) {
    while (index < srcset.length && /[\s,]/.test(srcset.charAt(index))) {
      index += 1;
    }
    const start = index;
    while (index < srcset.length && !/\s/.test(srcset.charAt(index))) {
      index += 1;
    }
    const candidate = srcset.slice(start, index);
    if (candidate === '') {
      break;
    }
    if (candidate.endsWith(',')) {
      links.push(picture(candidate.replace(/,+$/, '')));
      continue;
    }
    links.push(picture(candidate));
    let depth = 0;
    while (index < srcset.length) {
      const char = srcset.charAt(index);
      index += 1;
      if (char === '(') {
        depth += 1;
      }
      if (char === ')') {
        depth -= 1;
      }
      if (char === ',' && depth <= 0) {
        break;
      }
    }
  }
  return links;
}

function attributeName(attribute: { name: string; prefix?: string }): string {
  return attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name;
}

/** Every URL one attribute of one element could load or follow. */
function attributeLinks({ tag, name, value }: { tag: string; name: string; value: string }): BodyLink[] {
  if (name === 'srcset') {
    return srcsetLinks(value);
  }
  if (name === 'style') {
    return cssLinks(value);
  }
  const navigable = (tag === 'a' || tag === 'area') && (name === 'href' || name === 'xlink:href');
  if (navigable || NAVIGABLE_ATTRIBUTES.has(name)) {
    return [link(value)];
  }
  if (LOADED_ATTRIBUTES.has(name)) {
    return [picture(value), ...cssLinks(value)];
  }
  // Any other attribute counts only when its value reads as a URL or carries a CSS url().
  const loads = NAMES_A_WEB_HOST.test(cleanUrl(value)) ? [picture(value)] : [];
  return [...loads, ...cssLinks(value)];
}

function textOf(node: HtmlNode): string {
  return 'childNodes' in node ? node.childNodes.map(child => ('value' in child ? child.value : '')).join('') : '';
}

/** Walks a parsed tree, including template contents, and collects every URL it names. */
function collectHtmlLinks(node: HtmlNode, links: BodyLink[]): void {
  if ('attrs' in node) {
    const tag = node.tagName.toLowerCase();
    for (const attribute of node.attrs) {
      links.push(
        ...attributeLinks({ tag, name: attributeName(attribute), value: attribute.value }).map(link =>
          tag === 'script' ? { ...link, tag } : link,
        ),
      );
    }
    if (tag === 'style') {
      links.push(...cssLinks(textOf(node)));
    }
  }
  const children = 'content' in node ? node.content.childNodes : 'childNodes' in node ? node.childNodes : [];
  for (const child of children) {
    collectHtmlLinks(child, links);
  }
}

/** Whether two link lists name the same URLs in the same places. Cleaned values hold no line breaks, so the join is unambiguous. */
function sameLinks({ first, second }: { first: BodyLink[]; second: BodyLink[] }): boolean {
  const keys = (links: BodyLink[]) => links.map(link => `${link.kind}\u0000${link.value}`).join('\n');
  return keys(first) === keys(second);
}

/**
 * The URLs in an HTML fragment, or undefined when the markup does not survive a serialise and
 * reparse with the same URLs. Such markup can show one set of URLs to this check and another to
 * the browser, so it is refused rather than checked.
 */
function htmlLinks(html: string): BodyLink[] | undefined {
  const document = parse(html, { scriptingEnabled: false });
  const links: BodyLink[] = [];
  collectHtmlLinks(document, links);
  const reparsed: BodyLink[] = [];
  collectHtmlLinks(parse(serialize(document), { scriptingEnabled: false }), reparsed);
  return sameLinks({ first: links, second: reparsed }) ? links : undefined;
}

const markdownProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** The reference definitions a markdown body declares, and which of them a picture reference uses. */
interface MarkdownReferences {
  /** The URL each definition names, by its identifier; the first definition of an identifier wins. */
  definitions: Map<string, string>;
  /** The identifiers at least one picture reference uses. */
  pictureUses: Set<string>;
}

function collectMarkdownLinks(node: Nodes, links: BodyLink[], references: MarkdownReferences): boolean {
  switch (node.type) {
    case 'link':
      links.push(link(node.url));
      break;
    case 'definition':
      links.push(link(node.url));
      if (!references.definitions.has(node.identifier)) {
        references.definitions.set(node.identifier, node.url);
      }
      break;
    case 'image':
      links.push(picture(node.url));
      break;
    case 'imageReference':
      references.pictureUses.add(node.identifier);
      break;
    case 'html': {
      const inner = htmlLinks(node.value);
      if (inner === undefined) {
        return false;
      }
      links.push(...inner);
      break;
    }
    default:
      break;
  }
  if ('children' in node) {
    for (const child of node.children) {
      if (!collectMarkdownLinks(child, links, references)) {
        return false;
      }
    }
  }
  return true;
}

function markdownLinks(markdown: string): BodyLink[] | undefined {
  const links: BodyLink[] = [];
  const references: MarkdownReferences = { definitions: new Map(), pictureUses: new Set() };
  if (!collectMarkdownLinks(markdownProcessor.parse(markdown), links, references)) {
    return undefined;
  }
  // A definition a picture reference uses is a picture: the renderer loads it as one every time
  // the space opens, so it is read as a picture here as well as the link it also is, and the
  // write check and the picture route see the same thing.
  for (const [identifier, url] of references.definitions) {
    if (references.pictureUses.has(identifier)) {
      links.push(picture(url));
    }
  }
  return links;
}

/**
 * Every URL a body names, read in the body's own format. Undefined when the markup cannot be read
 * consistently, which the caller refuses.
 */
export function bodyLinks({
  body,
  format,
}: {
  body: string;
  format: z.infer<typeof SpaceFormatSchema>;
}): BodyLink[] | undefined {
  return format === 'html' ? htmlLinks(body) : markdownLinks(body);
}
