import { clientProblems, parseClientJson } from '../../../src/core/google/clientJson';
import type { GoogleSetupInfo } from '../../../src/core/google/setupMode';

const ID = '123456789-abcdefghij.apps.googleusercontent.com';
const SECRET = 'GOCSPX-abcdefghijklmnop';

const DESKTOP_SETUP: GoogleSetupInfo = {
  mode: 'paste',
  client_type: 'desktop',
  redirect_uri: 'http://127.0.0.1:53682/callback',
};
const WEB_SETUP: GoogleSetupInfo = {
  mode: 'web',
  client_type: 'web',
  redirect_uri: 'https://aman.example.org/api/v1/user/settings/google/oauth/callback',
};

describe('parseClientJson', () => {
  it('reads a Desktop client file', () => {
    expect(parseClientJson(JSON.stringify({ installed: { client_id: ID, client_secret: SECRET } }))).toEqual({
      client_id: ID,
      client_secret: SECRET,
      client_type: 'desktop',
      redirect_uris: [],
    });
  });

  it('reads a Web client file with its redirect URIs', () => {
    expect(
      parseClientJson(
        JSON.stringify({ web: { client_id: ID, client_secret: SECRET, redirect_uris: ['https://a.b/c'] } }),
      ),
    ).toMatchObject({ client_type: 'web', redirect_uris: ['https://a.b/c'] });
  });

  it('returns null for anything else', () => {
    expect(parseClientJson('{')).toBeNull();
    expect(parseClientJson('{"service_account":{}}')).toBeNull();
  });
});

describe('clientProblems', () => {
  const ok = { client_id: ID, client_secret: SECRET, registered_redirect_uris: [] as string[] };

  it('finds nothing wrong with a client of the right type', () => {
    expect(clientProblems({ ...ok, client_type: 'desktop', setup: DESKTOP_SETUP })).toEqual([]);
    expect(clientProblems({ ...ok, client_type: null, setup: DESKTOP_SETUP })).toEqual([]);
  });

  it('flags a malformed id and secret', () => {
    const problems = clientProblems({
      ...ok,
      client_id: 'nope',
      client_secret: 'short',
      client_type: null,
      setup: DESKTOP_SETUP,
    });
    expect(problems.map(problem => problem.code)).toEqual(['invalid_client_id', 'invalid_client_secret']);
  });

  it('flags a Desktop client where the install needs a Web client, and the reverse', () => {
    expect(clientProblems({ ...ok, client_type: 'desktop', setup: WEB_SETUP })[0]?.code).toBe('wrong_client_type');
    expect(clientProblems({ ...ok, client_type: 'web', setup: DESKTOP_SETUP })[0]?.code).toBe('wrong_client_type');
  });

  it('flags a Web client that does not list the exact callback', () => {
    const problems = clientProblems({
      ...ok,
      client_type: 'web',
      registered_redirect_uris: ['https://aman.example.org/other'],
      setup: WEB_SETUP,
    });
    expect(problems[0]?.code).toBe('redirect_uri_not_registered');
    expect(problems[0]?.message).toContain(WEB_SETUP.redirect_uri);
  });
});
