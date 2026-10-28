/**
 * A page read counts the picture links found on that page as seen, so a space may use a picture
 * file no search result named. Only the page's own pictures count: a link the page merely points
 * at, or a picture on a page the chat never opened, stays untrusted.
 */
import {
  emptyChatProvenance,
  isTrustedLink,
  isTrustedPicture,
  recordPageImageUrls,
  recordSearchResults,
  steeredDestinations,
} from '../../../src/core/permissions/provenance';
import {
  createWebSearchTurnState,
  pageImageUrls,
  recordToolResultProvenance,
} from '../../../src/core/permissions/webSearch';

const COMMONS_PAGE = 'https://commons.wikimedia.org/wiki/File:Red_Fox.jpg';
const FOX_IMAGE = 'https://upload.wikimedia.org/wikipedia/commons/3/3c/Red_Fox.jpg';
const OTHER_PAGE = 'https://example.org/foxes';

describe('pageImageUrls', () => {
  it('reads markdown pictures and raw img tags', () => {
    const urls = pageImageUrls(
      `# Fox\n![A red fox](${FOX_IMAGE})\n<img src="https://upload.wikimedia.org/other.jpg" alt="Other">`,
    );
    expect(urls).toEqual([FOX_IMAGE, 'https://upload.wikimedia.org/other.jpg']);
  });

  it('ignores links that are not pictures on the page', () => {
    expect(pageImageUrls(`[Read more](${OTHER_PAGE})\n<a href="${OTHER_PAGE}">Foxes</a>`)).toEqual([]);
  });

  it('ignores data: pictures, which are not links out', () => {
    expect(pageImageUrls('<img src="data:image/png;base64,aaaa" alt="Inline">')).toEqual([]);
  });
});

describe('recordPageImageUrls', () => {
  it('makes a Commons page read count its image as seen for a space', () => {
    const state = createWebSearchTurnState();
    recordSearchResults({
      provenance: state.provenance,
      texts: [JSON.stringify({ results: [{ title: 'Red Fox', url: COMMONS_PAGE }] })],
    });
    expect(isTrustedPicture({ provenance: state.provenance, url: FOX_IMAGE })).toBe(false);
    recordPageImageUrls({
      provenance: state.provenance,
      urls: pageImageUrls(`# File:Red Fox.jpg\n![Red fox](${FOX_IMAGE})\n<img src="${FOX_IMAGE}" alt="Red fox">`),
    });
    expect(isTrustedPicture({ provenance: state.provenance, url: FOX_IMAGE })).toBe(true);
  });

  it('does not count a picture that only appears in a search excerpt', () => {
    const state = createWebSearchTurnState();
    recordSearchResults({
      provenance: state.provenance,
      texts: [JSON.stringify({ results: [{ title: 'Foxes', url: OTHER_PAGE, excerpt: FOX_IMAGE }] })],
    });
    expect(isTrustedPicture({ provenance: state.provenance, url: FOX_IMAGE })).toBe(false);
  });
});

describe('a page picture is a picture, not a trusted link', () => {
  const PLANTED = 'https://collector.example/hook?token=abc';

  function openedPage() {
    const state = createWebSearchTurnState();
    recordToolResultProvenance({
      state,
      tool_name: 'web_fetch',
      argument_values: [COMMONS_PAGE],
      texts: [`# A page\n![x](${PLANTED})\n<img src="${FOX_IMAGE}" alt="Fox">`],
    });
    return state.provenance;
  }

  it('accepts the exact URL as a picture and refuses it as a link', () => {
    const provenance = openedPage();
    expect(isTrustedPicture({ provenance, url: PLANTED })).toBe(true);
    expect(isTrustedPicture({ provenance, url: FOX_IMAGE })).toBe(true);
    expect(isTrustedLink({ provenance, url: PLANTED })).toBe(false);
    expect(isTrustedLink({ provenance, url: FOX_IMAGE })).toBe(false);
  });

  it('does not accept another path on the same host as a picture', () => {
    expect(isTrustedPicture({ provenance: openedPage(), url: 'https://collector.example/other.png' })).toBe(false);
  });

  it('still flags the URL and its host for a consequential call', () => {
    const provenance = openedPage();
    const flagged = (value: string) =>
      steeredDestinations({ provenance, addresses: [], values: [value], reply_sender: null }).map(found => found.value);
    expect(flagged(PLANTED)).toEqual([PLANTED]);
    expect(flagged('https://collector.example/other')).toEqual(['https://collector.example/other']);
  });

  it('keeps a search result usable as both a link and a picture', () => {
    const provenance = emptyChatProvenance();
    recordSearchResults({
      provenance,
      texts: [JSON.stringify({ results: [{ title: 'Fox', url: FOX_IMAGE }] })],
    });
    expect(isTrustedLink({ provenance, url: FOX_IMAGE })).toBe(true);
    expect(isTrustedPicture({ provenance, url: FOX_IMAGE })).toBe(true);
  });
});
