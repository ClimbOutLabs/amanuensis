import { checkClientWithGoogle } from '../../../src/core/google/checkClient';

const CHECK = {
  client_id: '123456789-abcdefghij.apps.googleusercontent.com',
  redirect_uri: 'http://127.0.0.1:53682/callback',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
};

function answering(status: number, body: string) {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    requests.push({
      url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      init,
    });
    return Promise.resolve(new Response(body, { status }));
  };
  return { fetchImpl, requests };
}

describe('checkClientWithGoogle', () => {
  it('asks Google the same question a real sign-in would, with PKCE and a fresh state, and stores nothing', async () => {
    const { fetchImpl, requests } = answering(200, '');
    expect(await checkClientWithGoogle({ ...CHECK, fetchImpl })).toEqual([]);
    const url = requests[0]?.url;
    expect(url?.searchParams.get('client_id')).toBe(CHECK.client_id);
    expect(url?.searchParams.get('redirect_uri')).toBe(CHECK.redirect_uri);
    expect(url?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(Buffer.from(url?.searchParams.get('state') ?? '', 'base64url')).toHaveLength(32);
    expect(requests[0]?.init?.redirect).toBe('manual');
  });

  it('treats a redirect to the sign-in page as a pass', async () => {
    const { fetchImpl } = answering(302, '');
    expect(await checkClientWithGoogle({ ...CHECK, fetchImpl })).toEqual([]);
  });

  it('names an unregistered callback', async () => {
    const { fetchImpl } = answering(400, 'Error 400: redirect_uri_mismatch');
    const [problem] = await checkClientWithGoogle({ ...CHECK, fetchImpl });
    expect(problem?.code).toBe('redirect_uri_not_registered');
    expect(problem?.message).toContain(CHECK.redirect_uri);
  });

  it.each(['Error 401: invalid_client', 'deleted_client'])('names a client Google does not know (%s)', async body => {
    const { fetchImpl } = answering(401, body);
    expect((await checkClientWithGoogle({ ...CHECK, fetchImpl }))[0]?.code).toBe('client_not_found');
  });

  it('does not guess when Google refuses without a reason', async () => {
    const { fetchImpl } = answering(403, 'nope');
    expect((await checkClientWithGoogle({ ...CHECK, fetchImpl }))[0]?.code).toBe('unverified_response');
  });

  it('says it could not check when Google cannot be reached', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('socket hang up'));
    const [problem] = await checkClientWithGoogle({ ...CHECK, fetchImpl });
    expect(problem?.code).toBe('unverified_response');
    expect(problem?.message).not.toContain('socket');
  });
});
