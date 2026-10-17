import { normalizeImageLink, replyImageUrls } from '../../../../src/runtime/chatImages/imageLinks';

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
