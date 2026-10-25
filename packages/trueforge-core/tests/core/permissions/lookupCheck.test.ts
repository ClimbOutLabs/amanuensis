import { checkLookup } from '../../../src/core/permissions/lookupCheck';
import { collectOutboundStrings } from '../../../src/core/permissions/outboundGuard';
import { emptyChatProvenance, recordUntrustedText } from '../../../src/core/permissions/provenance';

const PAGE_LINK = 'https://upload.wikimedia.org/wikipedia/commons/3/3c/Red_Fox.jpg';

describe('checkLookup', () => {
  it('is uninspectable when the lookup has no text to read', () => {
    const check = checkLookup({
      strings: undefined,
      secrets: [],
      earlier: undefined,
      provenance: emptyChatProvenance(),
    });
    expect(check).toEqual({ verdict: { ok: false, rule: 'uninspectable' }, steered: [] });
  });

  it('passes a link copied exactly from read content', () => {
    const provenance = emptyChatProvenance();
    recordUntrustedText({ provenance, text: PAGE_LINK, source: 'page' });
    const check = checkLookup({
      strings: collectOutboundStrings({ url: PAGE_LINK }),
      secrets: [],
      earlier: undefined,
      provenance,
    });
    expect(check.verdict.ok).toBe(true);
    expect(check.steered).toEqual([]);
  });

  it('reports a link that read content steered by adding to it', () => {
    const provenance = emptyChatProvenance();
    recordUntrustedText({ provenance, text: PAGE_LINK, source: 'page' });
    const altered = `${PAGE_LINK}?size=2`;
    const check = checkLookup({
      strings: collectOutboundStrings({ url: altered }),
      secrets: [],
      earlier: undefined,
      provenance,
    });
    expect(check.steered).toEqual([altered]);
  });
});
