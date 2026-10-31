/**
 * A page read counts the picture links found on that page as seen, so a space may use a picture
 * file no search result named. On main the recording lives in the provenance built from a turn's
 * tool results, not in the ToolSet: a page reader's pictures join the page pictures (never the trusted links), while any
 * other tool's pictures stay untrusted. This file keeps its name from the ToolSet-level hook it
 * used to test; the hook itself is gone with the old recording layer.
 */
import { createWebSearchTurnState, recordToolResultProvenance } from '../../../src/core/permissions/webSearch';
import { isTrustedLink, isTrustedPicture } from '../../../src/core/permissions/provenance';

const FOX = 'https://upload.wikimedia.org/wikipedia/commons/3/3c/Red_Fox.jpg';
const FILE_PAGE = 'https://commons.wikimedia.org/wiki/File:Red_Fox.jpg';

describe('a page read counts its pictures as seen', () => {
  it('counts the pictures of a page opened with web_fetch as seen, though no result named the file', () => {
    const state = createWebSearchTurnState();
    recordToolResultProvenance({
      state,
      tool_name: 'web_fetch',
      argument_values: [FILE_PAGE],
      texts: [`# File:Red Fox.jpg\n<img src="${FOX}" alt="Red fox">`],
    });
    expect(isTrustedPicture({ provenance: state.provenance, url: FOX })).toBe(true);
    expect(isTrustedLink({ provenance: state.provenance, url: FOX })).toBe(false);
  });

  it('does not count pictures from a result that is not a page read', () => {
    const state = createWebSearchTurnState();
    recordToolResultProvenance({
      state,
      tool_name: 'some_tool',
      argument_values: [],
      texts: [`<img src="${FOX}" alt="Red fox">`],
    });
    expect(isTrustedPicture({ provenance: state.provenance, url: FOX })).toBe(false);
  });
});
