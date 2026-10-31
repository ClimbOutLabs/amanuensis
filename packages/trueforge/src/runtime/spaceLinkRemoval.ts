/**
 * Takes chosen links and pictures out of a space body while leaving everything else as written.
 * A link keeps its visible text; a picture keeps its alt text. Edits are cut from the original
 * source by position, so nothing else in the body is reformatted.
 */
import type { Nodes } from 'mdast';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import {
  attributeLinks,
  attributeName,
  cssLinks,
  link,
  markdownProcessor,
  picture,
  textOf,
  type BodyLink,
} from './spaceBodyLinks';

type HtmlNode = DefaultTreeAdapterMap['node'];

export interface RemovalResult {
  body: string;
  links: number;
  pictures: number;
}

interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

type DropLink = (link: BodyLink) => boolean;

function applyEdits({ source, edits }: { source: string; edits: SourceEdit[] }): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function escapeHtmlText(text: string): string {
  return text.replace(/[&<>"]/g, char =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;',
  );
}

/** Alt text as one plain markdown line: markup characters are escaped so it cannot form a link again. */
function plainMarkdownLine(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>|~#&!]/g, '\\$&');
}

function rewriteHtml({ html, drop }: { html: string; drop: DropLink }): RemovalResult | undefined {
  const document = parse(html, { scriptingEnabled: false, sourceCodeLocationInfo: true });
  const edits: SourceEdit[] = [];
  const counts = { links: 0, pictures: 0 };
  const state = { readable: true };

  const visit = (node: HtmlNode): void => {
    if ('attrs' in node) {
      const tag = node.tagName.toLowerCase();
      const location = node.sourceCodeLocation;
      const dropped = node.attrs.flatMap(attribute => {
        const name = attributeName(attribute);
        const hit = attributeLinks({ tag, name, value: attribute.value }).find(drop);
        return hit === undefined ? [] : [{ attribute, name, hit }];
      });
      const styleDropped = tag === 'style' && cssLinks(textOf(node)).some(drop);
      if (location === undefined || location === null) {
        if (dropped.length > 0 || styleDropped) {
          state.readable = false;
        }
      } else if (styleDropped) {
        edits.push({ start: location.startOffset, end: location.endOffset, text: '' });
        counts.pictures += 1;
        return;
      } else if (tag === 'img' && dropped.some(item => item.name === 'src')) {
        const alt = node.attrs.find(attribute => attribute.name === 'alt')?.value ?? '';
        edits.push({
          start: location.startOffset,
          end: location.endOffset,
          text: escapeHtmlText(alt.replace(/\s+/g, ' ').trim()),
        });
        counts.pictures += 1;
        return;
      } else {
        for (const { attribute, name, hit } of dropped) {
          const where = location.attrs?.[name] ?? location.attrs?.[attribute.name];
          if (where === undefined) {
            state.readable = false;
            continue;
          }
          edits.push({ start: where.startOffset, end: where.endOffset, text: '' });
          if (hit.kind === 'link') {
            counts.links += 1;
          } else {
            counts.pictures += 1;
          }
        }
      }
    }
    const children = 'content' in node ? node.content.childNodes : 'childNodes' in node ? node.childNodes : [];
    for (const child of children) {
      visit(child);
    }
  };
  visit(document);

  if (!state.readable) {
    return undefined;
  }
  return { body: applyEdits({ source: html, edits }), ...counts };
}

function rewriteMarkdown({ markdown, drop }: { markdown: string; drop: DropLink }): RemovalResult | undefined {
  const tree = markdownProcessor.parse(markdown);
  // A reference loses its link only when every definition of its name goes; a kept one still serves it.
  const definitionCounts = new Map<string, { all: number; dropped: number }>();
  const findDefinitions = (node: Nodes): void => {
    if (node.type === 'definition') {
      const count = definitionCounts.get(node.identifier) ?? { all: 0, dropped: 0 };
      count.all += 1;
      count.dropped += drop(link(node.url)) ? 1 : 0;
      definitionCounts.set(node.identifier, count);
    }
    if ('children' in node) {
      for (const child of node.children) {
        findDefinitions(child);
      }
    }
  };
  findDefinitions(tree);
  const lostDefinition = (identifier: string): boolean => {
    const count = definitionCounts.get(identifier);
    return count !== undefined && count.dropped === count.all;
  };

  const edits: SourceEdit[] = [];
  const counts = { links: 0, pictures: 0 };
  const state = { readable: true };

  /** The link's visible text, or nothing when the link was written as a bare address. */
  const visibleText = (
    node: Extract<Nodes, { type: 'link' | 'linkReference' }>,
    start: number,
    end: number,
  ): string => {
    const first = node.children[0]?.position?.start.offset;
    const last = node.children[node.children.length - 1]?.position?.end.offset;
    if (!markdown.slice(start, end).startsWith('[') || first === undefined || last === undefined) {
      return '';
    }
    const text = markdown.slice(first, last);
    // Text that is only an address goes too, or it would stay in the page as a bare address.
    return /^\s*(?:https?:\/\/|www\.)\S*\s*$/i.test(text) ? '' : text;
  };

  const visit = (node: Nodes): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      state.readable = false;
      return;
    }
    switch (node.type) {
      case 'link':
      case 'linkReference':
        if (node.type === 'link' ? drop(link(node.url)) : lostDefinition(node.identifier)) {
          edits.push({ start, end, text: visibleText(node, start, end) });
          counts.links += 1;
          return;
        }
        break;
      case 'image':
      case 'imageReference':
        if (node.type === 'image' ? drop(picture(node.url)) : lostDefinition(node.identifier)) {
          edits.push({ start, end, text: plainMarkdownLine(node.alt ?? '') });
          counts.pictures += 1;
          return;
        }
        break;
      case 'definition':
        // A definition shows nothing itself, so only the links and pictures that used it are counted.
        if (drop(link(node.url))) {
          edits.push({ start, end, text: '' });
          return;
        }
        break;
      case 'html': {
        // Inside a quote or list the node text lacks the container's prefix, so it cannot be spliced back.
        const inner = rewriteHtml({ html: node.value, drop });
        if (inner === undefined || (inner.body !== node.value && markdown.slice(start, end) !== node.value)) {
          state.readable = false;
          return;
        }
        if (inner.body !== node.value) {
          edits.push({ start, end, text: inner.body });
          counts.links += inner.links;
          counts.pictures += inner.pictures;
        }
        return;
      }
      default:
        break;
    }
    if ('children' in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(tree);

  if (!state.readable) {
    return undefined;
  }
  return { body: applyEdits({ source: markdown, edits }), ...counts };
}

/**
 * The body without the links and pictures `drop` selects, or undefined when a selected one cannot
 * be cut out by position. One call removes the outermost matches; the caller repeats until clean.
 */
export function removeLinks({
  body,
  format,
  drop,
}: {
  body: string;
  format: 'html' | 'markdown';
  drop: DropLink;
}): RemovalResult | undefined {
  return format === 'html' ? rewriteHtml({ html: body, drop }) : rewriteMarkdown({ markdown: body, drop });
}
