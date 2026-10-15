/**
 * The dry authorization request to Google, which confirms what local checks cannot: that the client exists
 * and that the callback is accepted for it. Nothing is stored and no consent is completed.
 */
import type { ClientProblem } from './clientJson';
import { GOOGLE_AUTH_URL } from './oauth';

export async function checkClientWithGoogle(input: {
  client_id: string;
  redirect_uri: string;
  scopes: readonly string[];
  fetchImpl?: typeof fetch | undefined;
}): Promise<ClientProblem[]> {
  const params = new URLSearchParams({
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    response_type: 'code',
    scope: input.scopes.join(' '),
    state: 'dry-run',
  });
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${GOOGLE_AUTH_URL}?${params.toString()}`, {
      method: 'GET',
      redirect: 'manual',
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
        message: `Google does not accept ${input.redirect_uri} for this client. Add it as an authorized redirect URI, or use the client type this page asks for.`,
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
      message: 'Google rejected the check without saying why. Re-copy the client ID and try again.',
    },
  ];
}
