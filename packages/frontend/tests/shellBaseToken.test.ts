import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rewriteShellAssetUrls, SHELL_BASE_TOKEN } from '../src/shellBaseToken';

/** What the server substitutes for the token: always `/` or a path with a trailing slash. */
function substitute(html: string, uiBasePath: string): string {
  return html.replaceAll(SHELL_BASE_TOKEN, uiBasePath);
}

describe('rewriteShellAssetUrls', () => {
  it('rewrites every public-root URL Vite emits, not just hashed assets', () => {
    const html = rewriteShellAssetUrls(
      '<link rel="icon" href="./favicon.svg" />' +
        '<link rel="manifest" href="./site.webmanifest" />' +
        '<script type="module" src="./assets/index-abc123.js"></script>' +
        '<link rel="stylesheet" href="./assets/index-def456.css" />',
    );

    assert.equal(html.includes('"./'), false);
    assert.equal(html.includes(`href="${SHELL_BASE_TOKEN}favicon.svg"`), true);
    assert.equal(html.includes(`src="${SHELL_BASE_TOKEN}assets/index-abc123.js"`), true);
  });

  it('resolves against the base rather than the page, so deep links keep working', () => {
    const html = rewriteShellAssetUrls('<link rel="icon" href="./favicon.svg" /><script src="./assets/a.js"></script>');

    assert.equal(substitute(html, '/'), '<link rel="icon" href="/favicon.svg" /><script src="/assets/a.js"></script>');
    assert.equal(
      substitute(html, '/custom/proxy/path/'),
      '<link rel="icon" href="/custom/proxy/path/favicon.svg" /><script src="/custom/proxy/path/assets/a.js"></script>',
    );
  });

  it('leaves absolute and origin-relative URLs alone', () => {
    const html = '<img src="https://example.test/x.png" /><a href="/api/v1/openapi.json">spec</a>';

    assert.equal(rewriteShellAssetUrls(html), html);
  });

  it('handles single-quoted attributes the way some bundlers emit them, preserving the quote style', () => {
    const html = rewriteShellAssetUrls("<script src='./assets/a.js'></script><link rel='stylesheet' href='./x.css' />");

    assert.equal(html.includes("src='./"), false);
    assert.equal(html.includes(`src='${SHELL_BASE_TOKEN}assets/a.js'`), true);
    assert.equal(html.includes(`href='${SHELL_BASE_TOKEN}x.css'`), true);
    assert.equal(
      substitute(html, '/base/'),
      "<script src='/base/assets/a.js'></script><link rel='stylesheet' href='/base/x.css' />",
    );
  });
});
