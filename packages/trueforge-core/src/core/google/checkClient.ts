/**
 * The dry authorization request to Google, which confirms what local checks cannot: that the client exists
 * and that the callback is accepted for it. Nothing is stored and no consent is completed.
 */
import { generateOAuthState } from '../util/oauthState';
import type { ClientProblem } from './clientJson';
import { buildAuthorizationUrl, fetchGoogle, generatePkceVerifier } from './oauth';

export async function checkClientWithGoogle(input: {
  client_id: string;
  redirect_uri: string;
  scopes: readonly string[];
  fetchImpl: typeof fetch | undefined;
}): Promise<ClientProblem[]> {
  const url = buildAuthorizationUrl({
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    scopes: input.scopes,
    state: generateOAuthState(),
    pkce_verifier: generatePkceVerifier(),
  });
  let response: Response;
  try {
    response = await fetchGoogle({
      fetchImpl: input.fetchImpl ?? fetch,
      url,
      init: { method: 'GET', redirect: 'manual' },
    });
  } catch {
    return [
      {
        code: 'unverified_response',
        message: 'Could not reach Google to check the client. Check your connection and try again.',
      },
    ];
  }
  if (response.status < 400) {
    return [];
  }
  const text = (await response.text().catch(() => '')).toLowerCase();
  if (text.includes('redirect_uri_mismatch')) {
    return [
      {
        code: 'redirect_uri_not_registered',
        message: `Google does not accept ${input.redirect_uri} for this client. Add it as an authorized redirect URI, or create the kind of client this page asks for.`,
      },
    ];
  }
  if (text.includes('invalid_client') || text.includes('deleted_client')) {
    return [
      {
        code: 'client_not_found',
        message:
          'Google does not recognize this client ID. Check that it was copied from the right project and has not been deleted.',
      },
    ];
  }
  return [
    {
      code: 'unverified_response',
      message: 'Google rejected the check without saying why. Copy the client ID again and try once more.',
    },
  ];
}
