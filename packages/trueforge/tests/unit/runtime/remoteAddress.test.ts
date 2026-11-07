import {
  allowedRemoteAddresses,
  isNamedLocalModelEndpoint,
  localModelEndpointOf,
  remoteUrlProblem,
  type ResolveAddresses,
} from '../../../src/runtime/remoteAddress';

/** A resolver that answers from a fixed table; a host outside the table does not resolve. */
function resolverFor(table: Record<string, string[]>): ResolveAddresses {
  return async (hostname: string): Promise<string[]> => {
    const addresses = table[hostname];
    if (addresses === undefined) {
      throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    }
    return addresses;
  };
}

const PUBLIC = resolverFor({ 'mcp.example.com': ['93.184.216.34'] });

describe('allowedRemoteAddresses', () => {
  it('allows a public address literal without resolving', async () => {
    await expect(allowedRemoteAddresses({ host: '8.8.8.8' })).resolves.toEqual({
      ok: true,
      addresses: ['8.8.8.8'],
    });
  });

  it('allows a name that resolves to a public address', async () => {
    await expect(
      allowedRemoteAddresses({
        host: 'mcp.example.com',
        deps: { resolveAddresses: PUBLIC, ownNetworkRanges: [] },
      }),
    ).resolves.toEqual({ ok: true, addresses: ['93.184.216.34'] });
  });

  it('allows home-network addresses: RFC 1918 and shared address space', async () => {
    // Pinned empty own networks: the machine running the suite has its own, and they are not
    // what this case judges.
    for (const host of ['192.168.1.20', '10.0.0.5', '172.16.4.9', '100.64.1.1']) {
      await expect(allowedRemoteAddresses({ host, deps: { ownNetworkRanges: [] } })).resolves.toMatchObject({
        ok: true,
      });
    }
  });

  it('allows a home-network name: a .local name resolving to a private address', async () => {
    const deps = {
      resolveAddresses: resolverFor({ 'homeassistant.local': ['192.168.1.20'] }),
      ownNetworkRanges: [],
    };
    await expect(allowedRemoteAddresses({ host: 'homeassistant.local', deps })).resolves.toMatchObject({
      ok: true,
    });
  });

  it.each([['127.0.0.1'], ['127.1.2.3'], ['0.0.0.1'], ['::1'], ['169.254.169.254'], ['fe80::1'], ['fd00:ec2::254']])(
    'refuses %s',
    async host => {
      await expect(allowedRemoteAddresses({ host })).resolves.toEqual({ ok: false, reason: 'blocked' });
    },
  );

  it('refuses the cloud metadata addresses inside otherwise allowed ranges', async () => {
    await expect(allowedRemoteAddresses({ host: '100.100.100.200' })).resolves.toEqual({
      ok: false,
      reason: 'blocked',
    });
    await expect(allowedRemoteAddresses({ host: '168.63.129.16' })).resolves.toEqual({
      ok: false,
      reason: 'blocked',
    });
  });

  it('refuses a name that resolves to loopback, like localhost does', async () => {
    const deps = { resolveAddresses: resolverFor({ localhost: ['127.0.0.1', '::1'] }) };
    await expect(allowedRemoteAddresses({ host: 'localhost', deps })).resolves.toEqual({
      ok: false,
      reason: 'blocked',
    });
  });

  it('refuses a name when even one of its addresses is refused', async () => {
    const deps = {
      resolveAddresses: resolverFor({ 'sneaky.example.com': ['93.184.216.34', '10.0.0.5', '127.0.0.1'] }),
    };
    await expect(allowedRemoteAddresses({ host: 'sneaky.example.com', deps })).resolves.toEqual({
      ok: false,
      reason: 'blocked',
    });
  });

  it('refuses an address on one of this instance’s own networks, and only those', async () => {
    const deps = { ownNetworkRanges: ['172.20.0.5/16'] };
    await expect(allowedRemoteAddresses({ host: '172.20.9.9', deps })).resolves.toEqual({
      ok: false,
      reason: 'blocked',
    });
    await expect(allowedRemoteAddresses({ host: '172.21.0.1', deps })).resolves.toMatchObject({ ok: true });
    await expect(allowedRemoteAddresses({ host: '172.20.9.9', deps: { ownNetworkRanges: [] } })).resolves.toMatchObject(
      { ok: true },
    );
  });

  it('refuses an IPv6 address on one of this instance’s own IPv6 networks', async () => {
    const deps = { ownNetworkRanges: ['fd00:1234::5/64'] };
    await expect(allowedRemoteAddresses({ host: 'fd00:1234::99', deps })).resolves.toEqual({
      ok: false,
      reason: 'blocked',
    });
  });

  it('judges an IPv4-mapped IPv6 address by the IPv4 address inside it', async () => {
    await expect(allowedRemoteAddresses({ host: '::ffff:127.0.0.1' })).resolves.toEqual({
      ok: false,
      reason: 'blocked',
    });
    await expect(allowedRemoteAddresses({ host: '::ffff:7f00:1' })).resolves.toEqual({
      ok: false,
      reason: 'blocked',
    });
    await expect(
      allowedRemoteAddresses({ host: '::ffff:8.8.8.8', deps: { ownNetworkRanges: [] } }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('reports a host that does not resolve as unresolved, whether the lookup is empty or fails', async () => {
    await expect(
      allowedRemoteAddresses({ host: 'gone.example.com', deps: { resolveAddresses: async () => [] } }),
    ).resolves.toEqual({ ok: false, reason: 'unresolved' });
    await expect(
      allowedRemoteAddresses({ host: 'gone.example.com', deps: { resolveAddresses: PUBLIC } }),
    ).resolves.toEqual({ ok: false, reason: 'unresolved' });
  });
});

describe('remoteUrlProblem', () => {
  it('passes a public https address', async () => {
    await expect(
      remoteUrlProblem({
        url: 'https://mcp.example.com/mcp',
        deps: { resolveAddresses: PUBLIC, ownNetworkRanges: [] },
      }),
    ).resolves.toBeNull();
  });

  it('passes a home-network http address, the shape a LAN server is saved with', async () => {
    await expect(
      remoteUrlProblem({ url: 'http://192.168.1.20:8123/mcp_server/sse', deps: { ownNetworkRanges: [] } }),
    ).resolves.toBeNull();
  });

  it('refuses a loopback URL as blocked', async () => {
    await expect(remoteUrlProblem({ url: 'http://127.0.0.1:8080/mcp' })).resolves.toBe('blocked');
    await expect(
      remoteUrlProblem({
        url: 'http://localhost:11434/v1',
        deps: { resolveAddresses: resolverFor({ localhost: ['127.0.0.1'] }) },
      }),
    ).resolves.toBe('blocked');
  });

  it('refuses the metadata address as blocked', async () => {
    await expect(remoteUrlProblem({ url: 'http://169.254.169.254/latest/meta-data' })).resolves.toBe('blocked');
  });

  it('refuses an IPv6 loopback URL as blocked', async () => {
    await expect(remoteUrlProblem({ url: 'http://[::1]:11434/v1' })).resolves.toBe('blocked');
  });

  it('reports a name that does not resolve as unresolved', async () => {
    await expect(
      remoteUrlProblem({ url: 'https://gone.example.com/mcp', deps: { resolveAddresses: PUBLIC } }),
    ).resolves.toBe('unresolved');
  });

  it.each([
    ['not a url'],
    ['ftp://mcp.example.com/mcp'],
    ['https://user:secret@mcp.example.com/mcp'],
    ['https://user@mcp.example.com/mcp'],
    ['file:///etc/passwd'],
  ])('refuses %s as invalid', async url => {
    await expect(remoteUrlProblem({ url, deps: { resolveAddresses: PUBLIC } })).resolves.toBe('invalid');
  });
});

describe('local model endpoint naming', () => {
  it('reads the exact host and port a URL names', () => {
    expect(localModelEndpointOf('http://localhost:11434/v1')).toBe('localhost:11434');
    expect(localModelEndpointOf('http://192.168.1.5:8080')).toBe('192.168.1.5:8080');
    expect(localModelEndpointOf('http://[::1]:11434/v1')).toBe('[::1]:11434');
    expect(localModelEndpointOf('HTTP://LOCALHOST:11434/v1')).toBe('localhost:11434');
  });

  it('counts the scheme default port when the URL leaves the port out', () => {
    expect(localModelEndpointOf('http://models.internal/v1')).toBe('models.internal:80');
    expect(localModelEndpointOf('https://models.internal/v1')).toBe('models.internal:443');
  });

  it('returns null for an address that names no http(s) host', () => {
    expect(localModelEndpointOf('not a url')).toBeNull();
    expect(localModelEndpointOf('ftp://localhost:11434')).toBeNull();
  });

  it('matches only the exact named endpoint: same host, same port', () => {
    const endpoints = ['localhost:11434'];
    expect(isNamedLocalModelEndpoint({ url: 'http://localhost:11434/v1', endpoints })).toBe(true);
    expect(isNamedLocalModelEndpoint({ url: 'http://localhost:9999/v1', endpoints })).toBe(false);
    expect(isNamedLocalModelEndpoint({ url: 'http://api.localhost:11434/v1', endpoints })).toBe(false);
    expect(isNamedLocalModelEndpoint({ url: 'http://localhost.evil.example:11434/v1', endpoints })).toBe(false);
    expect(isNamedLocalModelEndpoint({ url: 'http://localhost:11434/v1', endpoints: [] })).toBe(false);
  });
});
