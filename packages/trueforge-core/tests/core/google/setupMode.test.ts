import {
  GOOGLE_CALLBACK_PATH,
  parsePastedAddress,
  PASTE_REDIRECT_URI,
  publicHttpsBase,
  resolveGoogleSetup,
} from '../../../src/core/google/setupMode';

describe('publicHttpsBase', () => {
  it.each([
    ['https://aman.example.org', 'https://aman.example.org'],
    ['https://box.tailnet-name.ts.net/', 'https://box.tailnet-name.ts.net'],
    ['https://aman.example.org/app/', 'https://aman.example.org/app'],
  ])('accepts %s', (input, expected) => {
    expect(publicHttpsBase(input)).toBe(expected);
  });

  it.each([
    '',
    'not a url',
    'http://aman.example.org',
    'https://localhost:3000',
    'https://192.168.1.20',
    'https://[::1]',
    'https://mybox',
    'https://aman.local',
    'https://nas.lan',
    'https://aman.internal',
    'https://aman.home.arpa',
  ])('refuses %s', input => {
    expect(publicHttpsBase(input)).toBeNull();
  });
});

describe('resolveGoogleSetup', () => {
  it('uses a Web client and the exact public callback when the install has a public https address', () => {
    expect(
      resolveGoogleSetup({ public_base_url: 'https://aman.example.org/', request_url: 'http://192.168.1.5:8791/x' }),
    ).toEqual({
      mode: 'web',
      client_type: 'web',
      redirect_uri: `https://aman.example.org${GOOGLE_CALLBACK_PATH}`,
    });
  });

  it('returns straight to this server when the browser is on this machine', () => {
    expect(resolveGoogleSetup({ public_base_url: '', request_url: 'http://localhost:8791/api/v1/x' })).toEqual({
      mode: 'loopback',
      client_type: 'desktop',
      redirect_uri: `http://localhost:8791${GOOGLE_CALLBACK_PATH}`,
    });
  });

  it.each(['http://192.168.1.5:8791/x', 'http://aman-box:8791/x', 'http://100.64.0.7:8791/x'])(
    'asks for a pasted address when the browser reaches %s',
    requestUrl => {
      expect(resolveGoogleSetup({ public_base_url: 'http://localhost:8791', request_url: requestUrl })).toEqual({
        mode: 'paste',
        client_type: 'desktop',
        redirect_uri: PASTE_REDIRECT_URI,
      });
    },
  );
});

describe('parsePastedAddress', () => {
  it('reads the code and state from the whole address', () => {
    expect(parsePastedAddress(' http://127.0.0.1:53682/callback?state=abc&code=4%2F0AxYz&scope=x ')).toEqual({
      ok: true,
      code: '4/0AxYz',
      state: 'abc',
    });
  });

  it('refuses a bare code, because the state could not be checked', () => {
    expect(parsePastedAddress('4/0AxYz')).toMatchObject({ ok: false });
  });

  it('refuses an address without both parts', () => {
    expect(parsePastedAddress('http://127.0.0.1:53682/callback?code=abc')).toMatchObject({ ok: false });
    expect(parsePastedAddress('http://127.0.0.1:53682/callback?state=abc')).toMatchObject({ ok: false });
  });

  it('says plainly when Google reported a refusal', () => {
    const result = parsePastedAddress('http://127.0.0.1:53682/callback?error=access_denied&state=abc');
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.message).toMatch(/did not grant access/);
  });
});
