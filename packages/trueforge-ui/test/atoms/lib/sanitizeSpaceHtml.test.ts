// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { sanitizeSpaceHtml } from '@/atoms/lib/sanitizeSpaceHtml.js';

describe('sanitizeSpaceHtml', () => {
  it('removes script elements entirely, including their content', () => {
    const out = sanitizeSpaceHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('hi');
  });

  it('removes on* event-handler attributes but keeps the element', () => {
    const out = sanitizeSpaceHtml('<button onclick="alert(1)">Click</button>');
    expect(out).not.toContain('onclick');
    expect(out).toContain('<button');
    expect(out).toContain('Click');
  });

  it('keeps a <style> block and inline style attributes', () => {
    const out = sanitizeSpaceHtml('<style>.card{color:red}</style><div style="color:blue">x</div>');
    expect(out).toContain('.card{color:red}');
    expect(out).toContain('style="color:blue"');
  });

  it('drops an <img> with an https src', () => {
    const out = sanitizeSpaceHtml('<img src="https://example.com/pic.png" alt="pic">');
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('<img');
  });

  it('keeps an <img> with a data: URI src', () => {
    const out = sanitizeSpaceHtml('<img src="data:image/png;base64,AAAA" alt="pic">');
    expect(out).toContain('data:image/png;base64,AAAA');
  });

  it('drops an <img> with a non-https, non-data src', () => {
    const out = sanitizeSpaceHtml('<img src="http://example.com/pic.png" alt="pic">');
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('<img');
  });

  it('strips a javascript: href from a link but keeps the link text', () => {
    const out = sanitizeSpaceHtml('<a href="javascript:alert(1)">click me</a>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('click me');
  });

  it('removes <link>, <iframe>, <object>, and <embed> elements', () => {
    const out = sanitizeSpaceHtml(
      '<link rel="stylesheet" href="https://evil.example/x.css">' +
        '<iframe src="https://evil.example"></iframe>' +
        '<object data="https://evil.example"></object>' +
        '<embed src="https://evil.example">',
    );
    expect(out).not.toContain('<link');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<object');
    expect(out).not.toContain('<embed');
    expect(out).not.toContain('evil.example');
  });

  it('strips an external @import from a <style> block', () => {
    const out = sanitizeSpaceHtml('<style>@import url("https://evil.example/x.css"); .card{color:red}</style>');
    expect(out).not.toContain('@import');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('.card{color:red}');
  });

  it('strips an external @import from an inline style attribute', () => {
    const out = sanitizeSpaceHtml('<div style="@import url(https://evil.example/x.css); color:blue">x</div>');
    expect(out).not.toContain('@import');
    expect(out).toContain('color:blue');
  });

  it('removes a nested script inside otherwise-allowed markup', () => {
    const out = sanitizeSpaceHtml('<div><p>ok</p><script>evil()</script></div>');
    expect(out).not.toContain('evil()');
    expect(out).toContain('<p>ok</p>');
  });

  it('neutralises a background-image url() in an inline style attribute', () => {
    const out = sanitizeSpaceHtml('<div style="background-image:url(https://evil.example/beacon.png)">x</div>');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('url(https://');
    expect(out).toContain('background-image:none');
  });

  it('neutralises a url() inside a <style> block attribute selector', () => {
    const out = sanitizeSpaceHtml('<style>input[value^="a"]{background:url(https://evil.example/probe?a)}</style>');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('input[value^="a"]');
    expect(out).toContain('background:none');
  });

  it('preserves url(data:...) in a <style> block', () => {
    const out = sanitizeSpaceHtml('<style>.icon{background:url("data:image/png;base64,AAAA")}</style>');
    expect(out).toContain('url("data:image/png;base64,AAAA")');
  });

  it('preserves url(data:...) in an inline style attribute', () => {
    const out = sanitizeSpaceHtml('<div style="background:url(data:image/png;base64,AAAA)">x</div>');
    expect(out).toContain('url(data:image/png;base64,AAAA)');
  });

  it('removes a <meta http-equiv="refresh"> element', () => {
    const out = sanitizeSpaceHtml('<meta http-equiv="refresh" content="0;url=https://evil.example"><p>hi</p>');
    expect(out).not.toContain('<meta');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('hi');
  });

  it('removes a <base href> element', () => {
    const out = sanitizeSpaceHtml('<base href="https://evil.example/"><a href="/x">click</a>');
    expect(out).not.toContain('<base');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('click');
  });

  it('strips srcset from an img even when src is a data: URI', () => {
    const out = sanitizeSpaceHtml(
      '<img src="data:image/png;base64,AAAA" srcset="https://evil.example/big.png 2x" alt="pic">',
    );
    expect(out).toContain('data:image/png;base64,AAAA');
    expect(out).not.toContain('srcset');
    expect(out).not.toContain('evil.example');
  });

  it('strips srcset from a <source> inside <picture>', () => {
    const out = sanitizeSpaceHtml(
      '<picture><source srcset="https://evil.example/big.png 2x"><img src="data:image/png;base64,AAAA"></picture>',
    );
    expect(out).not.toContain('srcset');
    expect(out).not.toContain('evil.example');
  });

  it('strips href from <image> inside <svg>', () => {
    const out = sanitizeSpaceHtml(
      '<svg><image href="https://evil.example/pic.png" width="10" height="10"/></svg>',
    );
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('href="https://');
  });

  it('strips the poster attribute from <video>', () => {
    const out = sanitizeSpaceHtml('<video poster="https://evil.example/poster.png" controls></video>');
    expect(out).not.toContain('poster');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('<video');
  });

  it('strips src from <input type=image>', () => {
    const out = sanitizeSpaceHtml('<input type="image" src="https://evil.example/btn.png" alt="go">');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('src="https://');
    expect(out).toContain('<input');
  });

  it('drops CSS image-set(...) outright', () => {
    const out = sanitizeSpaceHtml(
      '<div style="background-image:image-set(url(https://evil.example/a.png) 1x, url(data:image/png;base64,AAAA) 2x)">x</div>',
    );
    expect(out).not.toContain('image-set');
    expect(out).not.toContain('evil.example');
  });

  it('strips the background attribute from table cells', () => {
    const out = sanitizeSpaceHtml(
      '<table><tr><td background="https://evil.example/bg.png">hi</td></tr></table>',
    );
    expect(out).not.toContain('background=');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('hi');
  });
});

describe('sanitizeSpaceHtml numeric cell classification', () => {
  it('adds the num class to a td whose whole content is a bare number', () => {
    const out = sanitizeSpaceHtml('<table><tr><td>250000</td></tr></table>');
    expect(out).toContain('<td class="num">250000</td>');
  });

  it('recognises currency, thousands separators, percentages, and accounting negatives', () => {
    const out = sanitizeSpaceHtml(
      '<table><tr>' + '<td>$1,234.50</td>' + '<td>12%</td>' + '<td>(1,234.50)</td>' + '<td>-42</td>' + '</tr></table>',
    );
    expect(out).toContain('<td class="num">$1,234.50</td>');
    expect(out).toContain('<td class="num">12%</td>');
    expect(out).toContain('<td class="num">(1,234.50)</td>');
    expect(out).toContain('<td class="num">-42</td>');
  });

  it('does not classify a td with mixed text as numeric', () => {
    const out = sanitizeSpaceHtml('<table><tr><td>3 bed</td></tr></table>');
    expect(out).toContain('<td>3 bed</td>');
    expect(out).not.toContain('class="num"');
  });

  it('does not classify a td that contains child markup', () => {
    const out = sanitizeSpaceHtml('<table><tr><td><span class="badge">42</span></td></tr></table>');
    expect(out).not.toContain('class="num"');
  });

  it('preserves an existing class alongside the added num class', () => {
    const out = sanitizeSpaceHtml('<table><tr><td class="highlight">42</td></tr></table>');
    expect(out).toContain('<td class="highlight num">42</td>');
  });

  it('leaves th cells alone even when their content is numeric', () => {
    const out = sanitizeSpaceHtml('<table><tr><th>2024</th></tr></table>');
    expect(out).toContain('<th>2024</th>');
  });

  it('requires parens to be balanced: a stray closing paren does not qualify', () => {
    const out = sanitizeSpaceHtml('<table><tr><td>123)</td></tr></table>');
    expect(out).toContain('<td>123)</td>');
    expect(out).not.toContain('class="num"');
  });

  it('requires parens to be balanced: a stray opening paren does not qualify', () => {
    const out = sanitizeSpaceHtml('<table><tr><td>(123</td></tr></table>');
    expect(out).toContain('<td>(123</td>');
    expect(out).not.toContain('class="num"');
  });

  it('still classifies a properly balanced accounting negative', () => {
    const out = sanitizeSpaceHtml('<table><tr><td>(123.45)</td></tr></table>');
    expect(out).toContain('<td class="num">(123.45)</td>');
  });
});
