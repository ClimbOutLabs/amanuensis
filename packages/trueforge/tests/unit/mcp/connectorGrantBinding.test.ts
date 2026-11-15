/**
 * What an "Always allow" grant on a connector binds to. It changes with the connector's address and how it signs
 * in, and never with a secret value, so a refreshed token keeps the grant and the grant table holds nothing a key
 * could be guessed from.
 */
import { connectorGrantBinding } from '../../../src/mcp/connectorGrantBinding';

const base = { id: 'srv-1', manifest: { url: 'https://mcp.example.com/notes', auth: undefined } };

describe('connectorGrantBinding', () => {
  it('is the same for the same setup', () => {
    expect(connectorGrantBinding(base)).toBe(connectorGrantBinding({ ...base, manifest: { ...base.manifest } }));
  });

  it('changes with the path or query on the same host', () => {
    const binding = connectorGrantBinding(base);
    expect(
      connectorGrantBinding({ ...base, manifest: { ...base.manifest, url: 'https://mcp.example.com/tasks' } }),
    ).not.toBe(binding);
    expect(
      connectorGrantBinding({ ...base, manifest: { ...base.manifest, url: 'https://mcp.example.com/notes?team=b' } }),
    ).not.toBe(binding);
  });

  it('ignores a user name, password or fragment in the address', () => {
    expect(
      connectorGrantBinding({ ...base, manifest: { ...base.manifest, url: 'https://u:p@mcp.example.com/notes#top' } }),
    ).toBe(connectorGrantBinding(base));
  });

  it('changes with the record, so a connector made again under the same name starts without grants', () => {
    expect(connectorGrantBinding({ ...base, id: 'srv-2' })).not.toBe(connectorGrantBinding(base));
  });

  it('changes with the way it signs in, the OAuth client, its scopes and the header names', () => {
    const header = (headers: Record<string, string>) =>
      connectorGrantBinding({ ...base, manifest: { ...base.manifest, auth: { type: 'header', headers } } });
    const oauth = (client_id: string, scopes?: string[]) =>
      connectorGrantBinding({
        ...base,
        manifest: { ...base.manifest, auth: { type: 'oauth_client', client_id, client_secret: 'secret-a', scopes } },
      });
    const all = [
      connectorGrantBinding(base),
      header({ Authorization: 'Bearer a' }),
      header({ 'X-Api-Key': 'a' }),
      oauth('client-a'),
      oauth('client-b'),
      oauth('client-a', ['read']),
      connectorGrantBinding({ ...base, manifest: { ...base.manifest, auth: { type: 'dcr' } } }),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('never changes with a secret value, and never holds one', () => {
    const header = (value: string) =>
      connectorGrantBinding({
        ...base,
        manifest: { ...base.manifest, auth: { type: 'header', headers: { Authorization: value } } },
      });
    expect(header('Bearer first-key-value')).toBe(header('Bearer rotated-key-value'));
    const oauth = (client_secret: string) =>
      connectorGrantBinding({
        ...base,
        manifest: { ...base.manifest, auth: { type: 'oauth_client', client_id: 'client-a', client_secret } },
      });
    expect(oauth('secret-a')).toBe(oauth('secret-b'));
    expect(header('Bearer first-key-value')).toMatch(/^[0-9a-f]{64}$/);
  });
});
