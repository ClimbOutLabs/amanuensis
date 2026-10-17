import { emailImageUrls, normalizeImageLink, replyImageUrls } from '../../../../src/runtime/chatImages/imageLinks';
import { CHAT_IMAGE_MAX_PER_EMAIL } from '../../../../src/runtime/chatImages/limits';

describe('emailImageUrls', () => {
  it('lists web image links once each, in order, decoding entities', () => {
    const html = `<p>Hi</p><img src="https://example.com/a.png?x=1&amp;y=2" alt="A">
      <IMG SRC='http://example.org/b.gif'><img alt="dup" src="https://example.com/a.png?x=1&amp;y=2">
      <img src=https://example.com/c.webp width=1>`;
    expect(emailImageUrls(html)).toEqual([
      'https://example.com/a.png?x=1&y=2',
      'http://example.org/b.gif',
      'https://example.com/c.webp',
    ]);
  });

  it('leaves out inline attachments, data images, data-src and non-web links', () => {
    const html =
      '<img src="cid:logo@example.com"><img src="data:image/png;base64,AAAA"><img data-src="https://example.com/x.png"><img src="javascript:alert(1)">';
    expect(emailImageUrls(html)).toEqual([]);
  });

  it('stops at the per-email cap', () => {
    const html = Array.from({ length: 30 }, (_, i) => `<img src="https://example.com/${String(i)}.png">`).join('');
    expect(emailImageUrls(html)).toHaveLength(CHAT_IMAGE_MAX_PER_EMAIL);
  });
});

describe('replyImageUrls', () => {
  it('finds markdown and HTML images, normalized', () => {
    const text =
      'See ![harbor](https://example.com/h%20arbor.png "Harbor") and <img src="https://example.org/b.png">. [not an image](https://example.com/page)';
    expect([...replyImageUrls(text)]).toEqual(['https://example.com/h%20arbor.png', 'https://example.org/b.png']);
  });

  it('ignores non-web image links', () => {
    expect(replyImageUrls('![x](data:image/png;base64,AAAA) ![y](/api/thing)').size).toBe(0);
  });
});

describe('normalizeImageLink', () => {
  it('accepts only http and https', () => {
    expect(normalizeImageLink('https://EXAMPLE.com/a.png')).toBe('https://example.com/a.png');
    expect(normalizeImageLink('javascript:alert(1)')).toBeUndefined();
    expect(normalizeImageLink('not a url')).toBeUndefined();
  });
});
