/**
 * A page read counts the picture links found on that page as seen, so a space may use a picture
 * file no search result named. Only the page's own pictures count: a link the page merely points
 * at, or a picture on a page the chat never opened, stays untrusted.
 */
import { isTrustedLink, recordPageImageUrls, recordSearchResults } from '../../../src/core/permissions/provenance';
import { createWebSearchTurnState, pageImageUrls } from '../../../src/core/permissions/webSearch';

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
    expect(isTrustedLink({ provenance: state.provenance, url: FOX_IMAGE })).toBe(false);
    recordPageImageUrls({
      provenance: state.provenance,
      urls: pageImageUrls(`# File:Red Fox.jpg\n![Red fox](${FOX_IMAGE})\n<img src="${FOX_IMAGE}" alt="Red fox">`),
    });
    expect(isTrustedLink({ provenance: state.provenance, url: FOX_IMAGE })).toBe(true);
  });

  it('does not count a picture that only appears in a search excerpt', () => {
    const state = createWebSearchTurnState();
    recordSearchResults({
      provenance: state.provenance,
      texts: [JSON.stringify({ results: [{ title: 'Foxes', url: OTHER_PAGE, excerpt: FOX_IMAGE }] })],
    });
    expect(isTrustedLink({ provenance: state.provenance, url: FOX_IMAGE })).toBe(false);
  });
});
