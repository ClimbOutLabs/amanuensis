import { htmlImageLinks, MAX_HTML_CHARS } from '../../../../src/core/email/gmail/htmlText';

describe('htmlImageLinks', () => {
  it('lists web image links once each, in order, decoding entities', () => {
    const html = `<p>Hi</p><img src="https://example.com/a.png?x=1&amp;y=2" alt="A">
      <IMG SRC='http://example.org/b.gif'><img alt="dup" src="https://example.com/a.png?x=1&amp;y=2">
      <img
        src=https://example.com/c.webp width=120>`;
    expect(htmlImageLinks({ source: html, max: 20 })).toEqual([
      'https://example.com/a.png?x=1&y=2',
      'http://example.org/b.gif',
      'https://example.com/c.webp',
    ]);
  });

  it('leaves out inline attachments, data images, data-src and non-web links', () => {
    const html =
      '<img src="cid:logo@example.com"><img src="data:image/png;base64,AAAA"><img data-src="https://example.com/x.png"><img src="javascript:alert(1)"><imgx src="https://example.com/y.png">';
    expect(htmlImageLinks({ source: html, max: 20 })).toEqual([]);
  });

  it('leaves out tracking pixels: tiny or hidden images and known tracker hosts', () => {
    const html = [
      '<img src="https://example.com/p1.gif" width="1" height="1">',
      '<img src="https://example.com/p2.gif" height=0>',
      '<img src="https://example.com/p3.gif" style="display: none">',
      '<img src="https://example.com/p4.gif" style="width:1px;height:1px">',
      '<img src="https://news.list-manage.com/track/open.php?u=abc">',
      '<img src="https://u1.ct.sendgrid.net/wf/open?upn=xyz">',
      '<img src="https://example.net/pixel.gif">',
      '<img src="https://example.com/art.png" width="600">',
    ].join('');
    expect(htmlImageLinks({ source: html, max: 20 })).toEqual(['https://example.com/art.png']);
  });

  it('stops at the cap', () => {
    const html = Array.from({ length: 30 }, (_, i) => `<img src="https://example.com/${String(i)}.png">`).join('');
    expect(htmlImageLinks({ source: html, max: 20 })).toHaveLength(20);
  });

  it('stays fast on hostile input and reads no further than the HTML limit', () => {
    const hostile = `${'<img src='.repeat(60_000)}${'src '.repeat(60_000)}`;
    const started = Date.now();
    htmlImageLinks({ source: hostile, max: 20 });
    expect(Date.now() - started).toBeLessThan(2000);
    const late = `${' '.repeat(MAX_HTML_CHARS)}<img src="https://example.com/late.png">`;
    expect(htmlImageLinks({ source: late, max: 20 })).toEqual([]);
  });
});
