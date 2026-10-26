import { createWebSearchTurnState, type WebSearchTurnState } from '@truefoundry/trueforge-core/core';
import {
  recordEmailText,
  recordPersonText,
  recordSearchResults,
} from '@truefoundry/trueforge-core/core/permissions/provenance';
import { recordToolResultProvenance } from '@truefoundry/trueforge-core/core/permissions/webSearch';
import { refuseNewSpaceLinks, SpaceLinkRefusedError } from '../../../src/runtime/spaceLinks';

const SEEN = 'https://upload.wikimedia.org/wikipedia/commons/3/3c/Red_Fox.jpg';
const UNSEEN = 'https://upload.wikimedia.org/wikipedia/commons/4/4d/Invented_Fox.jpg';

const FOX_PAGE = 'https://commons.wikimedia.org/wiki/File:Red_Fox.jpg';

/** A turn whose only read content is a page the assistant opened with the page reader, which shows the picture as `<img>`. */
function webSearchAfterOpeningPage(): WebSearchTurnState {
  const state = createWebSearchTurnState();
  recordToolResultProvenance({
    state,
    tool_name: 'web_fetch',
    argument_values: [FOX_PAGE],
    texts: [`# File:Red Fox.jpg\n<img src="${SEEN}" alt="Red fox">`],
  });
  return state;
}

/** The refusal for a write, or undefined when the write may stay. */
function refusalOf({
  body,
  format,
  previousBody = '',
  web_search = webSearchAfterOpeningPage(),
}: {
  body: string;
  format: 'html' | 'markdown';
  previousBody?: string;
  web_search?: WebSearchTurnState;
}) {
  try {
    refuseNewSpaceLinks({ body, previousBody, format, web_search, secrets: [] });
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
    it('refuses a link the chat never read', () => {
      expect(refusalOf({ body: body(UNSEEN), format })).toBeDefined();
    });

    it('keeps a link exactly as an opened page showed it', () => {
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

describe('a space picture or link follows the rule a lookup of it follows', () => {
  it('allows a picture link copied exactly from a page the assistant opened', () => {
    const web_search = webSearchAfterOpeningPage();
    expect(refusalOf({ body: `<img src="${SEEN}" alt="Fox">`, format: 'html', web_search })).toBeUndefined();
  });

  it('refuses a picture link copied exactly from an email, since a browser loads a picture on its own', () => {
    const web_search = createWebSearchTurnState();
    recordEmailText({ provenance: web_search.provenance, text: `Photo: ${SEEN}` });
    expect(refusalOf({ body: `<img src="${SEEN}" alt="Fox">`, format: 'html', web_search })).toContain(
      "Open the picture's page first",
    );
  });

  it('keeps a link copied exactly from an email, since a link opens only when the person follows it', () => {
    const web_search = createWebSearchTurnState();
    recordEmailText({ provenance: web_search.provenance, text: `Photo: ${SEEN}` });
    expect(refusalOf({ body: `<a href="${SEEN}">Fox</a>`, format: 'html', web_search })).toBeUndefined();
  });

  it('refuses a picture link from read content with an added query', () => {
    const web_search = webSearchAfterOpeningPage();
    expect(refusalOf({ body: `<img src="${SEEN}?size=2" alt="Fox">`, format: 'html', web_search })).toContain(
      "Open the picture's page first",
    );
  });

  it('refuses a link from read content with an added query', () => {
    const web_search = webSearchAfterOpeningPage();
    expect(refusalOf({ body: `<a href="${SEEN}?size=2">Fox</a>`, format: 'html', web_search })).toContain(
      'Use the link exactly as it appeared',
    );
  });

  it('refuses a picture link from read content with a changed path', () => {
    const web_search = webSearchAfterOpeningPage();
    const changed = SEEN.replace('Red_Fox.jpg', 'Red_Fox_large.jpg');
    expect(refusalOf({ body: `<img src="${changed}" alt="Fox">`, format: 'html', web_search })).toContain(
      "Open the picture's page first",
    );
  });

  it('refuses a link from read content with a changed path', () => {
    const web_search = webSearchAfterOpeningPage();
    const changed = SEEN.replace('Red_Fox.jpg', 'Red_Fox_large.jpg');
    expect(refusalOf({ body: `<a href="${changed}">Fox</a>`, format: 'html', web_search })).toContain(
      'Use the link exactly as it appeared',
    );
  });

  it('refuses a copied link that carries text the outbound guard rejects', () => {
    const encodedRun = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldY';
    const link = `${SEEN}?blob=${encodedRun}`;
    const web_search = createWebSearchTurnState();
    recordToolResultProvenance({
      state: web_search,
      tool_name: 'browse_page',
      argument_values: [FOX_PAGE],
      texts: [`<img src="${link}" alt="Fox">`],
    });
    expect(refusalOf({ body: `<img src="${link}" alt="Fox">`, format: 'html', web_search })).toContain(
      'trips a safety check',
    );
  });

  it('refuses a placeholder domain even when it was copied from read content', () => {
    const link = 'https://example.com/fox.jpg';
    const web_search = createWebSearchTurnState();
    recordEmailText({ provenance: web_search.provenance, text: link });
    expect(refusalOf({ body: `<img src="${link}" alt="Fox">`, format: 'html', web_search })).toContain(
      'placeholder domain',
    );
  });
});

describe('a space picture must be one the person, a search, or an opened page chose', () => {
  const UNSEEN_PICTURE = 'https://images.picturestack.net/fox.jpg';

  it('refuses a picture on a host nothing in the chat named', () => {
    const web_search = createWebSearchTurnState();
    expect(refusalOf({ body: `<img src="${UNSEEN_PICTURE}" alt="Fox">`, format: 'html', web_search })).toContain(
      "Open the picture's page first",
    );
  });

  it('refuses a picture copied exactly from a page the chat opened when the page only named it in text', () => {
    const web_search = createWebSearchTurnState();
    recordToolResultProvenance({
      state: web_search,
      tool_name: 'web_fetch',
      argument_values: [FOX_PAGE],
      texts: [`Read more at ${UNSEEN_PICTURE}`],
    });
    expect(refusalOf({ body: `<img src="${UNSEEN_PICTURE}" alt="Fox">`, format: 'html', web_search })).toContain(
      "Open the picture's page first",
    );
    expect(refusalOf({ body: `<a href="${UNSEEN_PICTURE}">Fox</a>`, format: 'html', web_search })).toBeUndefined();
  });

  it('keeps a picture a search result returned', () => {
    const web_search = createWebSearchTurnState();
    recordSearchResults({
      provenance: web_search.provenance,
      texts: [JSON.stringify({ results: [{ url: UNSEEN_PICTURE }] })],
    });
    expect(refusalOf({ body: `<img src="${UNSEEN_PICTURE}" alt="Fox">`, format: 'html', web_search })).toBeUndefined();
  });
});

describe('a space link carrying a private detail of the person', () => {
  const OWN_ADDRESS = 'sam@postbox.net';
  const CARRYING = `https://maps.picturestack.net/route?to=${OWN_ADDRESS}`;

  function chatThatReadContent(): WebSearchTurnState {
    const web_search = createWebSearchTurnState();
    recordPersonText({ provenance: web_search.provenance, text: `My email is ${OWN_ADDRESS}` });
    recordToolResultProvenance({
      state: web_search,
      tool_name: 'browse_page',
      argument_values: [FOX_PAGE],
      texts: ['A page about foxes.'],
    });
    return web_search;
  }

  it('refuses a link that carries the detail once the chat has read content', () => {
    const web_search = chatThatReadContent();
    expect(refusalOf({ body: `<a href="${CARRYING}">Route</a>`, format: 'html', web_search })).toContain(
      "would carry one of the person's own private details",
    );
  });

  it('refuses a chosen picture that carries the detail', () => {
    const web_search = chatThatReadContent();
    recordSearchResults({
      provenance: web_search.provenance,
      texts: [JSON.stringify({ results: [{ url: CARRYING }] })],
    });
    expect(refusalOf({ body: `<img src="${CARRYING}" alt="Route">`, format: 'html', web_search })).toContain(
      "would carry one of the person's own private details",
    );
  });

  it('keeps the same link when the chat has read no content', () => {
    const web_search = createWebSearchTurnState();
    recordPersonText({ provenance: web_search.provenance, text: `My email is ${OWN_ADDRESS}` });
    expect(refusalOf({ body: `<a href="${CARRYING}">Route</a>`, format: 'html', web_search })).toBeUndefined();
  });
});
