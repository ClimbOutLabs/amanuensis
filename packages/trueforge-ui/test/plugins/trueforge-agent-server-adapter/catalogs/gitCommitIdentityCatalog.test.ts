import { describe, expect, it, vi } from 'vitest';

import { createGitCommitIdentityCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/gitCommitIdentityCatalog.js';

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const UNSET = { name: null, email: null, default_name: 'Sam Rivera', default_email: 'aman@localhost' };

describe('createGitCommitIdentityCatalog', () => {
  it('reads the choice through the supplied base URL, token, and fetch', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://host.example/api/v1/settings/git-commit-identity');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
      return okJson({ data: UNSET });
    });
    const catalog = createGitCommitIdentityCatalog({
      baseUrl: 'https://host.example/',
      token: 'secret',
      fetch: fetchImpl,
    });
    await expect(catalog.getGitCommitIdentity()).resolves.toEqual(UNSET);
  });

  it('writes a chosen name and a cleared email', async () => {
    const bodies: string[] = [];
    const catalog = createGitCommitIdentityCatalog({
      fetch: async (_input, init) => {
        bodies.push(String(init?.body));
        return okJson({ data: { ...UNSET, name: 'Aman' } });
      },
    });
    await expect(catalog.setGitCommitIdentity({ name: 'Aman', email: null })).resolves.toEqual({
      ...UNSET,
      name: 'Aman',
    });
    expect(bodies).toEqual([JSON.stringify({ name: 'Aman', email: null })]);
  });

  it('says what to change when the server refuses the name or email', async () => {
    const catalog = createGitCommitIdentityCatalog({
      fetch: async () => new Response(JSON.stringify({ success: false }), { status: 400 }),
    });
    await expect(catalog.setGitCommitIdentity({ name: 'Sam <x>', email: null })).rejects.toThrow(
      'That name or email cannot be used. Use a name without < or >, and an email like you@example.com.',
    );
  });

  it('turns a server error into its message', async () => {
    const catalog = createGitCommitIdentityCatalog({
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'Ask an admin to change this.' } }), { status: 403 }),
    });
    await expect(catalog.setGitCommitIdentity({ name: 'Aman', email: null })).rejects.toThrow(
      'Ask an admin to change this.',
    );
  });

  it('refuses a reply that is not the expected shape', async () => {
    const catalog = createGitCommitIdentityCatalog({ fetch: async () => okJson({ data: { name: 3 } }) });
    await expect(catalog.getGitCommitIdentity()).rejects.toThrow('Reload the page and try again.');
  });
});
