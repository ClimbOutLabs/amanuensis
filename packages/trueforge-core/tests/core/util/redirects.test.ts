import { isRedirectStatus, redirectTargetOrigin } from '../../../src/core/util/redirects';

describe('isRedirectStatus', () => {
  it.each([300, 301, 302, 303, 304, 307, 308, 399])('counts HTTP %i as a redirect', status => {
    expect(isRedirectStatus(status)).toBe(true);
  });

  it.each([100, 200, 204, 299, 400, 401, 404, 500, 503])('does not count HTTP %i', status => {
    expect(isRedirectStatus(status)).toBe(false);
  });
});

describe('redirectTargetOrigin', () => {
  const requestUrl = 'https://memory.internal:8443/mcp/aman';

  function redirect(location: string | undefined): Response {
    return new Response(null, { status: 302, ...(location === undefined ? {} : { headers: { location } }) });
  }

  it.each([
    ['an absolute location', 'https://other.example/mcp/aman', 'https://other.example'],
    ['an absolute location on another port', 'http://other.example:9000/x', 'http://other.example:9000'],
    ['a relative location, resolved against the request', '/login', 'https://memory.internal:8443'],
    [
      'a location with a query that may hold a secret',
      'https://other.example/x?token=hunter2',
      'https://other.example',
    ],
    ['a location in another letter case', 'HTTPS://Other.Example/x', 'https://other.example'],
  ])('reports only the origin of %s', (_label, location, origin) => {
    expect(redirectTargetOrigin({ response: redirect(location), requestUrl })).toBe(origin);
  });

  it.each([
    ['no location header', undefined],
    ['a scheme other than http and https', 'javascript:alert(1)'],
    ['a location that is not a URL', 'http://'],
  ])('reports nothing for %s', (_label, location) => {
    expect(redirectTargetOrigin({ response: redirect(location), requestUrl })).toBeUndefined();
  });

  it('still reads an absolute location when the response has no URL to resolve against', () => {
    expect(redirectTargetOrigin({ response: redirect('https://other.example/x'), requestUrl: '' })).toBe(
      'https://other.example',
    );
  });

  it('reports nothing for a relative location that has no URL to resolve against', () => {
    expect(redirectTargetOrigin({ response: redirect('/login'), requestUrl: '' })).toBeUndefined();
  });
});
