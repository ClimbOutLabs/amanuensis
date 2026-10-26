import { checkLookup, type LookupUse } from '../../../src/core/permissions/lookupCheck';
import { collectOutboundStrings } from '../../../src/core/permissions/outboundGuard';
import {
  emptyChatProvenance,
  recordPageImageUrls,
  recordPersonText,
  recordSearchResults,
  recordUntrustedText,
  type ChatProvenance,
} from '../../../src/core/permissions/provenance';

const PAGE_LINK = 'https://upload.wikimedia.org/wikipedia/commons/3/3c/Red_Fox.jpg';
const UNSEEN_PICTURE = 'https://images.picturestack.net/fox.jpg';

function checkOf(input: { provenance: ChatProvenance; url: string; use: LookupUse }) {
  return checkLookup({
    strings: collectOutboundStrings({ url: input.url }),
    secrets: [],
    earlier: undefined,
    provenance: input.provenance,
    use: input.use,
  });
}

describe('checkLookup', () => {
  it('is uninspectable when the lookup has no text to read', () => {
    const check = checkLookup({
      strings: undefined,
      secrets: [],
      earlier: undefined,
      provenance: emptyChatProvenance(),
      use: 'lookup',
    });
    expect(check).toEqual({ verdict: { ok: false, rule: 'uninspectable' }, steered: [], privateDetails: [] });
  });

  it('passes a link copied exactly from read content', () => {
    const provenance = emptyChatProvenance();
    recordUntrustedText({ provenance, text: PAGE_LINK, source: 'page' });
    const check = checkOf({ provenance, url: PAGE_LINK, use: 'lookup' });
    expect(check.verdict.ok).toBe(true);
    expect(check.steered).toEqual([]);
  });

  it('reports a link that read content steered by adding to it', () => {
    const provenance = emptyChatProvenance();
    recordUntrustedText({ provenance, text: PAGE_LINK, source: 'page' });
    const altered = `${PAGE_LINK}?size=2`;
    const check = checkOf({ provenance, url: altered, use: 'lookup' });
    expect(check.steered).toEqual([altered]);
  });

  it('passes a lookup link on a host nothing named, since a lookup runs once', () => {
    const check = checkOf({ provenance: emptyChatProvenance(), url: UNSEEN_PICTURE, use: 'lookup' });
    expect(check.verdict.ok).toBe(true);
    expect(check.steered).toEqual([]);
  });
});

describe('checkLookup for an embed, which a browser loads on its own', () => {
  it('reports an embed link on a host nothing named', () => {
    const check = checkOf({ provenance: emptyChatProvenance(), url: UNSEEN_PICTURE, use: 'embed' });
    expect(check.steered).toEqual([UNSEEN_PICTURE]);
  });

  it('reports an embed link copied exactly from read content', () => {
    const provenance = emptyChatProvenance();
    recordUntrustedText({ provenance, text: PAGE_LINK, source: 'page' });
    const check = checkOf({ provenance, url: PAGE_LINK, use: 'embed' });
    expect(check.steered).toEqual([PAGE_LINK]);
  });

  it('passes an embed link the person gave', () => {
    const provenance = emptyChatProvenance();
    recordPersonText({ provenance, text: `Use this picture: ${UNSEEN_PICTURE}` });
    const check = checkOf({ provenance, url: UNSEEN_PICTURE, use: 'embed' });
    expect(check.steered).toEqual([]);
  });

  it('passes an embed link a search returned', () => {
    const provenance = emptyChatProvenance();
    recordSearchResults({ provenance, texts: [JSON.stringify({ results: [{ url: PAGE_LINK }] })] });
    const check = checkOf({ provenance, url: PAGE_LINK, use: 'embed' });
    expect(check.steered).toEqual([]);
  });

  it('passes an embed link recorded as a picture on a page the chat opened', () => {
    const provenance = emptyChatProvenance();
    recordUntrustedText({ provenance, text: `<img src="${PAGE_LINK}">`, source: 'page' });
    recordPageImageUrls({ provenance, urls: [PAGE_LINK] });
    const check = checkOf({ provenance, url: PAGE_LINK, use: 'embed' });
    expect(check.steered).toEqual([]);
  });
});

describe('checkLookup for an embed compares the picture as it would be fetched', () => {
  const WWW_PICTURE = 'https://www.upload.wikimedia.org/wikipedia/commons/3/3c/Red_Fox.jpg';

  function searchReturned(url: string): ChatProvenance {
    const provenance = emptyChatProvenance();
    recordSearchResults({ provenance, texts: [JSON.stringify({ results: [{ url }] })] });
    return provenance;
  }

  it('reports an embed link on the www host when a search returned the host without it', () => {
    const check = checkOf({ provenance: searchReturned(PAGE_LINK), url: WWW_PICTURE, use: 'embed' });
    expect(check.steered).toEqual([WWW_PICTURE]);
  });

  it('passes an embed link on the www host when a search returned that very link', () => {
    const check = checkOf({ provenance: searchReturned(WWW_PICTURE), url: WWW_PICTURE, use: 'embed' });
    expect(check.steered).toEqual([]);
  });

  it('reports an embed link on the plain host when a search returned the www host', () => {
    const check = checkOf({ provenance: searchReturned(WWW_PICTURE), url: PAGE_LINK, use: 'embed' });
    expect(check.steered).toEqual([PAGE_LINK]);
  });

  it('reports an embed link on the www host when a page the chat opened showed the picture on the plain host', () => {
    const provenance = emptyChatProvenance();
    recordPageImageUrls({ provenance, urls: [PAGE_LINK] });
    const check = checkOf({ provenance, url: WWW_PICTURE, use: 'embed' });
    expect(check.steered).toEqual([WWW_PICTURE]);
  });

  it('reports an embed link spelled https when the person gave the http spelling', () => {
    const provenance = emptyChatProvenance();
    recordPersonText({ provenance, text: `My fox picture: ${PAGE_LINK.replace('https://', 'http://')}` });
    const check = checkOf({ provenance, url: PAGE_LINK, use: 'embed' });
    expect(check.steered).toEqual([PAGE_LINK]);
  });

  it('passes an embed link spelled http when the person gave that very spelling', () => {
    const spelled = PAGE_LINK.replace('https://', 'http://');
    const provenance = emptyChatProvenance();
    recordPersonText({ provenance, text: `My fox picture: ${spelled}` });
    const check = checkOf({ provenance, url: spelled, use: 'embed' });
    expect(check.steered).toEqual([]);
  });
});

describe('checkLookup when a value carries more than the link itself', () => {
  function searchReturnedPicture(): ChatProvenance {
    const provenance = emptyChatProvenance();
    recordSearchResults({ provenance, texts: [JSON.stringify({ results: [{ url: PAGE_LINK }] })] });
    return provenance;
  }

  it('keeps an embed link with only whitespace after it, since every reader drops edge whitespace', () => {
    const check = checkOf({ provenance: searchReturnedPicture(), url: `${PAGE_LINK} `, use: 'embed' });
    expect(check.steered).toEqual([]);
  });

  it('reports an embed link with words after it', () => {
    const check = checkOf({ provenance: searchReturnedPicture(), url: `${PAGE_LINK} as shown`, use: 'embed' });
    expect(check.steered).toEqual([PAGE_LINK]);
  });

  it('reports an embed link with another link after it', () => {
    const check = checkOf({
      provenance: searchReturnedPicture(),
      url: `${PAGE_LINK} ${UNSEEN_PICTURE}`,
      use: 'embed',
    });
    expect(check.steered).toEqual([PAGE_LINK, UNSEEN_PICTURE]);
  });

  it('reports an embed link with another site named after it', () => {
    const check = checkOf({
      provenance: searchReturnedPicture(),
      url: `${PAGE_LINK} picturestack.net`,
      use: 'embed',
    });
    expect(check.steered).toEqual([PAGE_LINK]);
  });

  it('reports a lookup link copied from read content with words after it', () => {
    const provenance = emptyChatProvenance();
    recordUntrustedText({ provenance, text: PAGE_LINK, source: 'page' });
    const check = checkOf({ provenance, url: `${PAGE_LINK} as shown`, use: 'lookup' });
    expect(check.steered).toEqual([PAGE_LINK]);
  });

  it('reports a lookup link the person gave with words after it, when read content named its site', () => {
    const provenance = emptyChatProvenance();
    recordPersonText({ provenance, text: `My fox picture: ${PAGE_LINK}` });
    recordUntrustedText({ provenance, text: 'More foxes at upload.wikimedia.org', source: 'page' });
    const check = checkOf({ provenance, url: `${PAGE_LINK} as shown`, use: 'lookup' });
    expect(check.steered).toEqual([PAGE_LINK]);
  });
});

describe('checkLookup when a value ends in a space only some readers drop', () => {
  // Each of these is whitespace to the language's own trim, but a URL reader keeps it and
  // percent-encodes it into the link it opens, so the value a reader opens is a longer link
  // than the one that was recorded. Only the plain space is dropped by every reader.
  const WIDER_SPACES: { name: string; char: string }[] = [
    { name: 'an ideographic space', char: '\u3000' },
    { name: 'a line separator', char: '\u2028' },
    { name: 'a non-breaking space', char: '\u00A0' },
    { name: 'a byte order mark', char: '\uFEFF' },
  ];

  function searchReturnedPicture(): ChatProvenance {
    const provenance = emptyChatProvenance();
    recordSearchResults({ provenance, texts: [JSON.stringify({ results: [{ url: PAGE_LINK }] })] });
    return provenance;
  }

  describe.each(WIDER_SPACES)('$name', ({ char }) => {
    it('reports an embed link with it after the link, since the reader opens a longer link', () => {
      const check = checkOf({ provenance: searchReturnedPicture(), url: `${PAGE_LINK}${char}`, use: 'embed' });
      expect(check.steered).toEqual([PAGE_LINK]);
    });

    it('reports a lookup link copied from read content with it after the link', () => {
      const provenance = emptyChatProvenance();
      recordUntrustedText({ provenance, text: PAGE_LINK, source: 'page' });
      const check = checkOf({ provenance, url: `${PAGE_LINK}${char}`, use: 'lookup' });
      expect(check.steered).toEqual([PAGE_LINK]);
    });

    it('reports a lookup link the person gave with it after the link, when read content named its site', () => {
      const provenance = emptyChatProvenance();
      recordPersonText({ provenance, text: `My fox picture: ${PAGE_LINK}` });
      recordUntrustedText({ provenance, text: 'More foxes at upload.wikimedia.org', source: 'page' });
      const check = checkOf({ provenance, url: `${PAGE_LINK}${char}`, use: 'lookup' });
      expect(check.steered).toEqual([PAGE_LINK]);
    });
  });
});

describe('checkLookup private details', () => {
  const OWN_ADDRESS = 'sam@postbox.net';
  const CARRYING = `https://maps.picturestack.net/route?to=${OWN_ADDRESS}`;

  function chatThatReadContent(): ChatProvenance {
    const provenance = emptyChatProvenance();
    recordPersonText({ provenance, text: `My email is ${OWN_ADDRESS}` });
    recordUntrustedText({ provenance, text: 'A page about the roads north of the city.', source: 'page' });
    return provenance;
  }

  it("reports a detail of the person's that the text carries once the chat has read content", () => {
    const check = checkOf({ provenance: chatThatReadContent(), url: CARRYING, use: 'lookup' });
    expect(check.privateDetails).toEqual([OWN_ADDRESS]);
  });

  it('reports the detail however the text spells the address', () => {
    const spelled = `https://maps.picturestack.net/route?to=sam+alerts@postbox.net`;
    const check = checkOf({ provenance: chatThatReadContent(), url: spelled, use: 'lookup' });
    expect(check.privateDetails).toEqual([OWN_ADDRESS]);
  });

  it('reports nothing when the chat has read no content', () => {
    const provenance = emptyChatProvenance();
    recordPersonText({ provenance, text: `My email is ${OWN_ADDRESS}` });
    const check = checkOf({ provenance, url: CARRYING, use: 'lookup' });
    expect(check.privateDetails).toEqual([]);
  });

  it('reports the detail on an embed link that was itself chosen', () => {
    const provenance = chatThatReadContent();
    recordSearchResults({ provenance, texts: [JSON.stringify({ results: [{ url: CARRYING }] })] });
    const check = checkOf({ provenance, url: CARRYING, use: 'embed' });
    expect(check.steered).toEqual([]);
    expect(check.privateDetails).toEqual([OWN_ADDRESS]);
  });
});
