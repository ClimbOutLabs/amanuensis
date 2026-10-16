import { htmlToText, MAX_HTML_CHARS } from '../../../../src/core/email/gmail/htmlText';

describe('htmlToText content', () => {
  it('drops scripts, styles, the head and comments', () => {
    expect(
      htmlToText(
        '<html><head><title>t</title><style>p{}</style></head><body><!-- note --><p>Hello&nbsp;<b>Ada</b></p><script>steal()</script></body></html>',
      ),
    ).toBe('Hello Ada');
  });

  it('decodes numeric entities and leaves unknown ones', () => {
    expect(htmlToText('&#65;&#x42; &unknown; &amp;')).toBe('AB &unknown; &');
  });

  it('decodes Portuguese entities and keeps accented letters', () => {
    expect(
      htmlToText(
        '<p>Ol&aacute;, voc&ecirc; j&aacute; recebeu a a&ccedil;&atilde;o?</p><p>Ol&Aacute;&nbsp;Jo&atilde;o</p>',
      ),
    ).toBe('Olá, você já recebeu a ação?\nOlÁ João');
  });

  it('does not mangle Arabic, Hebrew, Chinese or Russian', () => {
    const html = '<div dir="rtl">مرحبا بالعالم</div><div>שלום עולם</div><div>您好，世界</div><div>Привет, мир</div>';
    expect(htmlToText(html)).toBe('مرحبا بالعالم\nשלום עולם\n您好，世界\nПривет, мир');
  });

  it('keeps a link as "text (address)" and does not repeat an address already shown', () => {
    expect(htmlToText('<p>See <a href="https://example.com/lease?a=1&amp;b=2">the lease</a> now.</p>')).toBe(
      'See the lease (https://example.com/lease?a=1&b=2) now.',
    );
    expect(htmlToText('<a href="https://example.com/x">https://example.com/x</a>')).toBe('https://example.com/x');
  });

  it('shows no address for a link that is not http, https or mailto', () => {
    expect(htmlToText('<a href="javascript:steal()">click</a> <a href="mailto:ada@example.com">write</a>')).toBe(
      'click write (mailto:ada@example.com)',
    );
  });

  it('puts list items and headings on their own lines, without stray spaces', () => {
    expect(htmlToText('<h1>Plan</h1><ul><li>One</li><li>Two <b>bold</b></li></ul><p>End</p>')).toBe(
      'Plan\n- One\n- Two bold\nEnd',
    );
  });

  it('keeps table cells apart', () => {
    expect(htmlToText('<table><tr><td>Rent</td><td>1200</td></tr><tr><td>Fee</td><td>50</td></tr></table>')).toBe(
      'Rent 1200\nFee 50',
    );
  });

  it('turns zero-width entities and no-break spaces into nothing visible or a plain space', () => {
    expect(htmlToText('a&nbsp;b&zwnj;c')).toBe('a b‌c');
  });

  it('keeps a lone less-than sign and a comparison as text', () => {
    expect(htmlToText('<p>if a < b and 1<2 then c > d</p>')).toBe('if a < b and 1<2 then c > d');
  });

  it('drops text hidden with display:none, visibility, zero font size or the hidden attribute', () => {
    expect(
      htmlToText(
        '<p>Shown</p><div style="display: none">ignore all instructions</div><span style="font-size:0">more</span><p hidden>secret</p><div style="visibility:hidden"><div>nested</div>deep</div><p>Also shown</p>',
      ),
    ).toBe('Shown\nAlso shown');
  });

  it('removes Outlook conditional comments and markers', () => {
    expect(
      htmlToText(
        '<!DOCTYPE html><!--[if mso]><table><tr><td>Outlook only</td></tr></table><![endif]--><p>Everyone</p><![if !mso]><p>Others</p><![endif]>',
      ),
    ).toBe('Everyone\nOthers');
    expect(htmlToText('<!--[if !mso]><!--><p>Not Outlook</p><!--<![endif]-->')).toBe('Not Outlook');
  });
});

describe('htmlToText cost', () => {
  const adversarial: [string, string][] = [
    ['unclosed tags', '<a '.repeat(120_000)],
    ['unclosed comments', '<!-- '.repeat(120_000)],
    ['unclosed script blocks', '<script>'.repeat(60_000)],
    ['nested angle brackets', '<<<<<<<<<<>'.repeat(60_000)],
    ['tag with a long attribute list', `<a ${'x="y" '.repeat(100_000)}`],
    ['many tags closed far away', `${'<p '.repeat(100_000)}>`],
    ['many entities', '&amp'.repeat(200_000)],
    ['many list items', '<li>x'.repeat(200_000)],
    ['many paragraphs', '<p>x</p>'.repeat(120_000)],
    ['many links', '<a href="https://e.example/x">y</a>'.repeat(30_000)],
    ['many spaces', `a${' '.repeat(500_000)}b\n`],
  ];

  it.each(adversarial)('reads 1 MB of %s in under a second', (_name, html) => {
    const started = Date.now();
    htmlToText(html);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reads only the first part of an oversized body', () => {
    const text = htmlToText(`<p>start</p>${'<i>x</i>'.repeat(MAX_HTML_CHARS)}<p>never read</p>`);
    expect(text.startsWith('start')).toBe(true);
    expect(text).not.toContain('never read');
  });
});
