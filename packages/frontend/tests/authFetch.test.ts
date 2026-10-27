import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUTH_LOGIN_HREF, AUTH_LOGOUT_HREF, buildLoginHref, createAuthAwareFetch } from '../src/authFetch';
import { parseAuthErrorReason } from '../src/authStatusSearch';

describe('buildLoginHref', () => {
  it('defaults return_to to the UI base path', () => {
    const href = buildLoginHref();
    assert.equal(href.startsWith(`${AUTH_LOGIN_HREF}?`), true);
    assert.equal(new URL(href, 'http://example.test').searchParams.get('return_to'), '/');
  });

  it('encodes an explicit return_to path', () => {
    const href = buildLoginHref('/trueforge/sessions/abc');
    assert.equal(new URL(href, 'http://example.test').searchParams.get('return_to'), '/trueforge/sessions/abc');
  });
});

describe('createAuthAwareFetch', () => {
  it('passes through non-401 responses', async () => {
    const wrapped = createAuthAwareFetch(async () => new Response('ok', { status: 200 }));
    const response = await wrapped('/api/v1/models');
    assert.equal(response.status, 200);
  });

  it('does not redirect on 401 when window is undefined', async () => {
    const wrapped = createAuthAwareFetch(async () => new Response('nope', { status: 401 }));
    const response = await wrapped('/api/v1/models');
    assert.equal(response.status, 401);
  });

  it('redirects once on 401 and does not return the failing response', async () => {
    const originalWindow = globalThis.window;
    const assigns: string[] = [];
    // Minimal browser stub for the redirect path.
    (globalThis as { window: Window }).window = {
      location: {
        pathname: '/chat/abc',
        search: '?tab=1',
        hash: '#top',
        assign: (href: string) => {
          assigns.push(href);
        },
      },
    } as Window;

    try {
      const wrapped = createAuthAwareFetch(async () => new Response('nope', { status: 401 }));
      let settled = false;
      void wrapped('/api/v1/models').then(() => {
        settled = true;
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      const expected = `${AUTH_LOGIN_HREF}?return_to=${encodeURIComponent('/chat/abc?tab=1#top')}`;
      assert.deepEqual(assigns, [expected]);
      assert.equal(settled, false);
      // Second 401 must not double-redirect.
      void wrapped('/api/v1/models');
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(assigns, [expected]);
    } finally {
      if (originalWindow === undefined) {
        // node --test has no window by default
        Reflect.deleteProperty(globalThis, 'window');
      } else {
        (globalThis as { window: Window }).window = originalWindow;
      }
    }
  });

  it('returns the 401 response when the sign-in redirect does not take the page away', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const originalWindow = globalThis.window;
    const assigns: string[] = [];
    (globalThis as { window: Window }).window = {
      location: {
        pathname: '/chat/abc',
        search: '',
        hash: '',
        assign: (href: string) => {
          assigns.push(href);
        },
      },
    } as Window;

    try {
      const wrapped = createAuthAwareFetch(async () => new Response('nope', { status: 401 }));
      let settled: Response | undefined;
      void wrapped('/api/v1/models').then(response => {
        settled = response;
      });
      // Let the fetch and the wrapper's own promise hops run to completion.
      const flush = async () => {
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      };
      await flush();
      // Still held back at first, so a working redirect never flashes an error.
      assert.equal(settled, undefined);
      assert.equal(assigns.length, 1);

      // The page is still here long after the redirect should have taken it
      // away: the caller gets the real response instead of hanging forever.
      t.mock.timers.tick(60_000);
      await flush();
      assert.equal(settled?.status, 401);
    } finally {
      t.mock.timers.reset();
      if (originalWindow === undefined) {
        Reflect.deleteProperty(globalThis, 'window');
      } else {
        (globalThis as { window: Window }).window = originalWindow;
      }
    }
  });

  it('exports browser auth entry paths', () => {
    assert.equal(AUTH_LOGIN_HREF, '/api/v1/auth/login');
    assert.equal(AUTH_LOGOUT_HREF, '/api/v1/auth/logout');
  });
});

describe('auth status landings', () => {
  it('reads error reason for sign-in failures', () => {
    assert.equal(parseAuthErrorReason('?error=access_denied'), 'access_denied');
    assert.equal(parseAuthErrorReason('?other=1'), null);
  });
});
