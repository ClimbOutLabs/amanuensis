import { createWebSearchTurnState, type WebSearchTurnState } from '@truefoundry/trueforge-core/core';
import { recordSearchResults } from '@truefoundry/trueforge-core/core/permissions/provenance';
import { refuseNewSpaceLinks, SpaceLinkRefusedError } from '../../../src/runtime/spaceLinks';

const SEEN = 'https://upload.wikimedia.org/wikipedia/commons/3/3c/Red_Fox.jpg';
const UNSEEN = 'https://upload.wikimedia.org/wikipedia/commons/4/4d/Invented_Fox.jpg';

function webSearchWith(urls: string[]): WebSearchTurnState {
  const state = createWebSearchTurnState();
  recordSearchResults({
    provenance: state.provenance,
    texts: [JSON.stringify({ results: urls.map(url => ({ title: 'Result', url })) })],
  });
  return state;
}

/** The refusal for a write, or undefined when the write may stay. */
function refusalOf({
  body,
  format,
  previousBody = '',
}: {
  body: string;
  format: 'html' | 'markdown';
  previousBody?: string;
}) {
  try {
    refuseNewSpaceLinks({ body, previousBody, format, web_search: webSearchWith([SEEN]) });
    return undefined;
  } catch (error) {
    if (error instanceof SpaceLinkRefusedError) {
      return error.message;
    }
    throw error;
  }
}

/** Every character as a numeric character reference, so the parser must decode it back. */
function entityEncoded(value: string): string {
  return [...value].map(char => `&#x${(char.codePointAt(0) ?? 0).toString(16)};`).join('');
}

/** The same URL without its scheme, which a browser resolves against the page's https origin. */
function schemeRelative(url: string): string {
  return url.replace(/^https:/, '');
}

type Spelling = { name: string; format: 'html' | 'markdown'; body: (url: string) => string };

const HTML_SPELLINGS: Spelling[] = [
  {
    name: 'uppercase picture and source tags',
    format: 'html',
    body: url => `<PICTURE><SOURCE SRCSET="${url} 1x"><IMG SRC="${url}" ALT="Fox"></PICTURE>`,
  },
  {
    name: 'a second srcset candidate',
    format: 'html',
    body: url => `<img alt="Fox" src="${SEEN}" srcset="${SEEN} 1x, ${url} 2x">`,
  },
  { name: 'unquoted src', format: 'html', body: url => `<img src=${url} alt=Fox>` },
  { name: 'slash in place of a space before an attribute', format: 'html', body: url => `<img/src="${url}"/>` },
  { name: 'entity-encoded picture src', format: 'html', body: url => `<img src="${entityEncoded(url)}" alt="Fox">` },
  { name: 'entity-encoded link href', format: 'html', body: url => `<a href="${entityEncoded(url)}">Fox</a>` },
  { name: 'uppercase link with single quotes', format: 'html', body: url => `<A HREF='${url}'>Fox</A>` },
  { name: 'link href with surrounding spaces', format: 'html', body: url => `<a href="  ${url}  ">Fox</a>` },
  { name: 'scheme-relative link href', format: 'html', body: url => `<a href="${schemeRelative(url)}">Fox</a>` },
  {
    name: 'tab and line break inside a link href',
    format: 'html',
    body: url => `<a href="${url.replace('https://', 'https:\t\n//')}">Fox</a>`,
  },
  { name: 'base href', format: 'html', body: url => `<base href="${url}"><p>Fox</p>` },
  { name: 'link element href', format: 'html', body: url => `<link rel=preload as=image href="${url}">` },
  {
    name: 'backslashes in place of slashes',
    format: 'html',
    body: url => `<img src="${url.replace('https://', 'https:\\\\')}">`,
  },
  {
    name: 'control character before the URL',
    format: 'html',
    body: url => `<img src="\u0001${url}">`,
  },
  {
    name: 'url() in a style attribute',
    format: 'html',
    body: url => `<div style="background-image: url(${url})">Fox</div>`,
  },
  {
    name: 'CSS-escaped url() in a style attribute',
    format: 'html',
    body: url => `<div style="background-image: \\75 rl('${url}')">Fox</div>`,
  },
  {
    name: 'url() in a style element',
    format: 'html',
    body: url => `<style>.fox { background: url("${url}") }</style><p class="fox">Fox</p>`,
  },
  {
    name: 'image-set() in a style element',
    format: 'html',
    body: url => `<style>.fox { background: -webkit-image-set("${url}" 1x) }</style>`,
  },
  { name: '@import in a style element', format: 'html', body: url => `<style>@import "${url}";</style>` },
  {
    name: 'SVG image href',
    format: 'html',
    body: url => `<svg width="10" height="10"><image href="${url}" width="10" height="10"/></svg>`,
  },
  {
    name: 'uppercase SVG image with xlink:href',
    format: 'html',
    body: url => `<SVG><IMAGE XLINK:HREF="${url}"></IMAGE></SVG>`,
  },
  {
    name: 'SVG anchor href',
    format: 'html',
    body: url => `<svg><a href="${url}"><text x="1" y="5">Fox</text></a></svg>`,
  },
  { name: 'SVG use href', format: 'html', body: url => `<svg><use href="${url}"></use></svg>` },
  { name: 'picture inside a template', format: 'html', body: url => `<template><img src="${url}"></template>` },
  { name: 'picture inside noscript', format: 'html', body: url => `<noscript><img src="${url}"></noscript>` },
  { name: 'iframe src', format: 'html', body: url => `<iframe src="${url}"></iframe>` },
];

const MARKDOWN_SPELLINGS: Spelling[] = [
  { name: 'markdown image', format: 'markdown', body: url => `![Fox](${url})` },
  {
    name: 'markdown image through a reference definition',
    format: 'markdown',
    body: url => `![Fox][fox]\n\n[fox]: ${url}`,
  },
  { name: 'markdown link', format: 'markdown', body: url => `[Fox](${url})` },
  { name: 'markdown autolink', format: 'markdown', body: url => `<${url}>` },
  { name: 'bare URL in markdown text', format: 'markdown', body: url => `See ${url} for the fox.` },
  { name: 'raw HTML image in markdown', format: 'markdown', body: url => `<img src="${url}" alt="Fox">` },
  {
    name: 'entity-encoded raw HTML image in markdown',
    format: 'markdown',
    body: url => `<img src="${entityEncoded(url)}" alt="Fox">`,
  },
];

describe('space links are checked from a real parse of the body', () => {
  describe.each([...HTML_SPELLINGS, ...MARKDOWN_SPELLINGS])('$name', ({ format, body }) => {
    it('refuses a link the chat never returned', () => {
      expect(refusalOf({ body: body(UNSEEN), format })).toBeDefined();
    });

    it('keeps a link that a search result returned', () => {
      expect(refusalOf({ body: body(SEEN), format })).toBeUndefined();
    });
  });

  it('refuses an http picture in a srcset candidate even when a result returned it', () => {
    const plain = SEEN.replace('https://', 'http://');
    const refusal = refusalOf({ body: `<img src="${SEEN}" srcset="${plain} 2x">`, format: 'html' });
    expect(refusal).toContain('must use a secure https link');
  });

  it('refuses markup whose links change when it is serialised and read again', () => {
    // parse5 reads this math-table markup differently after a round trip, so the link this check
    // sees may not be the one a browser loads. Even a result link is refused rather than trusted.
    const body = `<math><mtext><table><mglyph><style><img src=${SEEN}>`;
    expect(refusalOf({ body, format: 'html' })).toContain('cannot be checked for links safely');
  });

  it('keeps an http spelling of a link a search returned over https, since it names the same page', () => {
    const body = `<a href="${SEEN.replace('https://', 'http:')}">Fox</a>`;
    expect(refusalOf({ body, format: 'html' })).toBeUndefined();
  });

  it('checks only links a write adds, so an unrelated edit keeps a link from an earlier turn', () => {
    const previousBody = `<img src="${UNSEEN}" alt="Fox"><p>Old text</p>`;
    expect(refusalOf({ body: `${previousBody}<p>New text</p>`, format: 'html', previousBody })).toBeUndefined();
  });
});
