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
    const out = sanitizeSpaceHtml('<div onclick="alert(1)">Click</div>');
    expect(out).not.toContain('onclick');
    expect(out).toContain('<div');
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

  it('removes a <source> inside <picture>', () => {
    const out = sanitizeSpaceHtml(
      '<picture><source srcset="https://evil.example/big.png 2x"><img src="data:image/png;base64,AAAA"></picture>',
    );
    expect(out).not.toContain('<source');
    expect(out).not.toContain('srcset');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('data:image/png;base64,AAAA');
  });

  it('removes an <image> inside <svg> whose href is remote', () => {
    const out = sanitizeSpaceHtml('<svg><image href="https://evil.example/pic.png" width="10" height="10"/></svg>');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('<image');
  });

  it('keeps an <image> inside <svg> whose href is a raster data: URI', () => {
    const out = sanitizeSpaceHtml('<svg><image href="data:image/png;base64,AAAA" width="10" height="10"/></svg>');
    expect(out).toContain('<image');
    expect(out).toContain('data:image/png;base64,AAAA');
  });

  it('removes <video> elements entirely', () => {
    const out = sanitizeSpaceHtml('<video poster="https://evil.example/poster.png" controls></video><p>after</p>');
    expect(out).not.toContain('<video');
    expect(out).not.toContain('poster');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('after');
  });

  it('removes form controls, including <input type=image>', () => {
    const out = sanitizeSpaceHtml('<input type="image" src="https://evil.example/btn.png" alt="go">');
    expect(out).not.toContain('<input');
    expect(out).not.toContain('evil.example');
  });

  it('drops CSS image-set(...) outright', () => {
    const out = sanitizeSpaceHtml(
      '<div style="background-image:image-set(url(https://evil.example/a.png) 1x, url(data:image/png;base64,AAAA) 2x)">x</div>',
    );
    expect(out).not.toContain('image-set');
    expect(out).not.toContain('evil.example');
  });

  it('strips the background attribute from table cells', () => {
    const out = sanitizeSpaceHtml('<table><tr><td background="https://evil.example/bg.png">hi</td></tr></table>');
    expect(out).not.toContain('background=');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('hi');
  });

  it('removes media elements: <video>, <audio>, and <source>', () => {
    const out = sanitizeSpaceHtml(
      '<video src="data:video/mp4;base64,AAAA" controls></video>' +
        '<audio src="https://evil.example/a.mp3" controls></audio>' +
        '<video><source src="https://evil.example/v.mp4" type="video/mp4"></video>' +
        '<p>after</p>',
    );
    expect(out).not.toContain('<video');
    expect(out).not.toContain('<audio');
    expect(out).not.toContain('<source');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('after');
  });

  it('strips a remote href from <svg><use>', () => {
    const out = sanitizeSpaceHtml('<svg><use href="https://evil.example/icons.svg#icon"></use></svg>');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('href=');
    expect(out).toContain('<use');
  });

  it('strips a remote xlink:href from <svg><use>', () => {
    const out = sanitizeSpaceHtml('<svg><use xlink:href="https://evil.example/icons.svg#icon"></use></svg>');
    expect(out).not.toContain('evil.example');
  });

  it('keeps a fragment href on <svg><use>', () => {
    const out = sanitizeSpaceHtml('<svg><use href="#icon"></use></svg>');
    expect(out).toContain('<use');
    expect(out).toContain('href="#icon"');
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

describe('sanitizeSpaceHtml XSS corpus', () => {
  it('removes frames: <iframe>, <frame>, and <frameset>', () => {
    const iframeOut = sanitizeSpaceHtml('<iframe src="https://evil.example"></iframe><p>after</p>');
    expect(iframeOut).not.toContain('<iframe');
    expect(iframeOut).not.toContain('evil.example');
    expect(iframeOut).toContain('after');

    const framesetOut = sanitizeSpaceHtml('<frameset rows="50%,50%"><frame src="https://evil.example"></frameset>');
    expect(framesetOut).not.toContain('<frame');
    expect(framesetOut).not.toContain('evil.example');
  });

  it('removes embedding elements: <applet>, <portal>, and <fencedframe>', () => {
    const out = sanitizeSpaceHtml(
      '<applet code="Evil.class"></applet>' +
        '<portal src="https://evil.example"></portal>' +
        '<fencedframe src="https://evil.example"></fencedframe>' +
        '<p>after</p>',
    );
    expect(out).not.toContain('<applet');
    expect(out).not.toContain('<portal');
    expect(out).not.toContain('<fencedframe');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('after');
  });

  it('removes a whole form with its controls', () => {
    const out = sanitizeSpaceHtml(
      '<form action="https://evil.example/submit">' +
        '<label>Name <input type="text" name="q"></label>' +
        '<button formaction="javascript:alert(1)">Go</button>' +
        '<select name="s"><option>One</option></select>' +
        '<textarea name="t">draft text</textarea>' +
        '</form><p>after</p>',
    );
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('<select');
    expect(out).not.toContain('<textarea');
    expect(out).not.toContain('<label');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('after');
  });

  it('removes SMIL animation elements and their handlers', () => {
    const out = sanitizeSpaceHtml(
      '<svg><circle r="5"><animate attributeName="r" values="5;10" onbegin="alert(1)"/></circle>' +
        '<set attributeName="href" to="javascript:alert(1)"/>' +
        '<animateTransform attributeName="transform" type="rotate" values="0;360"/></svg>',
    );
    expect(out).not.toContain('<animate');
    expect(out).not.toContain('<set');
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('<circle');
  });

  it('removes a <template> together with its content', () => {
    const out = sanitizeSpaceHtml(
      '<template><img src="x" onerror="alert(1)"><script>alert(2)</script></template><p>ok</p>',
    );
    expect(out).not.toContain('<template');
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('alert(2)');
    expect(out).toContain('<p>ok</p>');
  });

  it('walks nested SVG: removes a script and a javascript: link inside it', () => {
    const out = sanitizeSpaceHtml(
      '<svg><svg><script>alert(1)</script><a href="javascript:alert(2)"><text>click</text></a></svg></svg>',
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('click');
  });

  it('removes <foreignObject> and the HTML inside it', () => {
    const out = sanitizeSpaceHtml(
      '<svg><foreignObject width="100" height="100"><div><p onclick="alert(1)">boom</p></div></foreignObject><circle r="5"/></svg>',
    );
    expect(out).not.toContain('foreignObject');
    expect(out).not.toContain('boom');
    expect(out).not.toContain('onclick');
    expect(out).toContain('<circle');
  });

  it('removes MathML with an HTML annotation payload', () => {
    const out = sanitizeSpaceHtml(
      '<math><annotation-xml encoding="text/html"><p onclick="alert(1)">boom</p></annotation-xml></math><p>ok</p>',
    );
    expect(out).not.toContain('<math');
    expect(out).not.toContain('boom');
    expect(out).toContain('<p>ok</p>');
  });

  it('drops a data:text/html link target', () => {
    const out = sanitizeSpaceHtml('<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>');
    expect(out).not.toContain('data:text/html');
    expect(out).toContain('click');
  });

  it('drops a vbscript: link target', () => {
    const out = sanitizeSpaceHtml('<a href="vbscript:msgbox(1)">click</a>');
    expect(out).not.toContain('vbscript:');
    expect(out).toContain('click');
  });

  it('drops entity-encoded javascript: schemes, decimal and hex', () => {
    const decimal = sanitizeSpaceHtml('<a href="&#106;avascript:alert(1)">click</a>');
    expect(decimal).not.toContain('javascript:');
    expect(decimal).not.toContain('href=');

    const hex = sanitizeSpaceHtml('<a href="&#x6A;avascript:alert(1)">click</a>');
    expect(hex).not.toContain('javascript:');
    expect(hex).not.toContain('href=');
  });

  it('drops mixed-case schemes and mixed-case script tags', () => {
    const out = sanitizeSpaceHtml('<a href="JaVaScRiPt:alert(1)">click</a><ScRiPt>alert(2)</ScRiPt>');
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('alert(2)');
    expect(out?.toLowerCase()).not.toContain('javascript:');
    expect(out?.toLowerCase()).not.toContain('<script');
    expect(out).toContain('click');
  });

  it('drops schemes padded or split with whitespace and control characters', () => {
    const tabbed = sanitizeSpaceHtml('<a href="java\tscript:alert(1)">click</a>');
    expect(tabbed).not.toContain('href=');

    const entityControl = sanitizeSpaceHtml('<a href="&#14;javascript:alert(1)">click</a>');
    expect(entityControl).not.toContain('href=');

    const leadingSpace = sanitizeSpaceHtml('<a href="  javascript:alert(1)">click</a>');
    expect(leadingSpace).not.toContain('href=');
  });

  it('drops an <img> whose data: URI is SVG or HTML, not a raster image', () => {
    const svg = sanitizeSpaceHtml('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="x">');
    expect(svg).not.toContain('<img');
    expect(svg).not.toContain('data:image/svg');

    const html = sanitizeSpaceHtml('<img src="data:text/html;base64,PHNjcmlwdD4=" alt="x">');
    expect(html).not.toContain('<img');
  });

  it('drops ping, download, and xml:base while keeping the link itself', () => {
    const out = sanitizeSpaceHtml(
      '<a href="https://example.com/file" ping="https://evil.example/track" download>file</a>' +
        '<svg xml:base="https://evil.example/"><use href="#icon"></use></svg>',
    );
    expect(out).toContain('href="https://example.com/file"');
    expect(out).not.toContain('ping');
    expect(out).not.toContain('download');
    expect(out).not.toContain('xml:base');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('href="#icon"');
  });

  it('drops a non-fragment clip-path reference', () => {
    const out = sanitizeSpaceHtml(
      '<svg><rect width="10" height="10" clip-path="url(https://evil.example/clip.svg#x)"/></svg>',
    );
    expect(out).not.toContain('clip-path');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('<rect');
  });

  it('removes elements that are not on the allow-list, with their contents', () => {
    const out = sanitizeSpaceHtml('<marquee behavior="alternate">scrolling text</marquee><p>ok</p>');
    expect(out).not.toContain('<marquee');
    expect(out).not.toContain('scrolling text');
    expect(out).toContain('<p>ok</p>');
  });
});

describe('sanitizeSpaceHtml safe content', () => {
  it('passes simple safe markup through unchanged', () => {
    const input =
      '<p class="note">Hello <strong>world</strong>, see <a href="https://example.com/x">the listing</a>.</p>';
    expect(sanitizeSpaceHtml(input)).toBe(input);
  });

  it('keeps a designed page: style, headings, table, data image, links, and an inline SVG chart', () => {
    const out = sanitizeSpaceHtml(
      '<style>.card{border:1px solid #ccc;padding:1rem}.bar{fill:#4a7}</style>' +
        '<section class="card"><h2>Shortlist</h2>' +
        '<p>Updated <time datetime="2026-10-15">October 15</time>. ' +
        '<a href="mailto:agent@example.com">Email the agent</a> or <a href="/spaces/1">open the notes</a>.</p>' +
        '<table><thead><tr><th>Area</th><th>Notes</th></tr></thead>' +
        '<tbody><tr><td>Salamanca</td><td>Quiet street</td></tr></tbody></table>' +
        '<img src="data:image/png;base64,AAAA" alt="Floor plan" width="120">' +
        '<svg viewBox="0 0 100 40" width="100" height="40" role="img" aria-label="Price chart">' +
        '<rect class="bar" x="5" y="10" width="20" height="30"></rect>' +
        '<rect class="bar" x="35" y="4" width="20" height="36"></rect>' +
        '<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#4a7" stop-opacity="0.9"></stop>' +
        '<stop offset="1" stop-color="#4a7" stop-opacity="0.2"></stop>' +
        '</linearGradient></defs></svg></section>',
    );
    expect(out).toContain('.card{border:1px solid #ccc;padding:1rem}');
    expect(out).toContain('<h2>Shortlist</h2>');
    expect(out).toContain('<time datetime="2026-10-15">October 15</time>');
    expect(out).toContain('href="mailto:agent@example.com"');
    expect(out).toContain('href="/spaces/1"');
    expect(out).toContain('<td>Salamanca</td>');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('alt="Floor plan"');
    expect(out).toContain('viewBox="0 0 100 40"');
    expect(out).toContain('<rect class="bar" x="5" y="10" width="20" height="30"></rect>');
    expect(out).toContain('<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">');
    expect(out).toContain('<stop offset="0" stop-color="#4a7" stop-opacity="0.9"></stop>');
    expect(out).toContain('aria-label="Price chart"');
  });

  it('is idempotent on safe content', () => {
    const input =
      '<section><h2>Title</h2><p>Text with <em>emphasis</em> and a <a href="https://example.com">link</a>.</p>' +
      '<ul><li>One</li><li>Two</li></ul></section>';
    const once = sanitizeSpaceHtml(input);
    expect(sanitizeSpaceHtml(once ?? '')).toBe(once);
  });
});
