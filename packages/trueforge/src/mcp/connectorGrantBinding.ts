import { createHash } from 'node:crypto';

import type { McpServerManifest } from '../schemas/mcpServer';

/**
 * What an "Always allow" grant on a connector binds to: a digest of the connector as it is set up now. It covers the
 * record's id, its address (path and query included; a user name, password or fragment never counts) and how it
 * signs in (the kind of sign-in, the OAuth client and scopes, the names of the headers it sends). A connector that
 * points anywhere else, even on the same host, or signs in another way, gets a different binding, so a grant chosen
 * for its old setup no longer matches and the next call asks again. That holds for an approval card answered after
 * the connector changed, too: the grant records the binding the card was asked under.
 *
 * Secret values (header values, the client secret, tokens) are never part of it, so the grant table holds nothing a
 * key could be guessed from, and a refreshed token or rotated key on the same connector keeps its grants.
 */
export function connectorGrantBinding(record: { id: string; manifest: Pick<McpServerManifest, 'url' | 'auth'> }): string {
  const { auth } = record.manifest;
  const signIn =
    auth === undefined
      ? { type: 'none' }
      : auth.type === 'header'
        ? { type: 'header', header_names: Object.keys(auth.headers).map(name => name.toLowerCase()).sort() }
        : auth.type === 'oauth_client'
          ? { type: 'oauth_client', client_id: auth.client_id, scopes: [...(auth.scopes ?? [])].sort() }
          : { type: auth.type };
  const canonical = JSON.stringify({ id: record.id, address: grantAddress(record.manifest.url), sign_in: signIn });
  return createHash('sha256').update(canonical).digest('hex');
}

/** The address a grant binds to: the URL without a user name, password or fragment. Unparseable text counts as written. */
function grantAddress(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}
