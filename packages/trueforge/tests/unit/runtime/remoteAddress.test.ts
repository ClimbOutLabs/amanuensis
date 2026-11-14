import {
  allowedRemoteAddresses,
  configureRemoteAddressCheck,
  isNamedLocalModelEndpoint,
  localModelEndpointOf,
  modelUrlProblem,
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
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '8.8.8.8' })).resolves.toEqual({
      ok: true,
      addresses: ['8.8.8.8'],
    });
  });

  it('allows a name that resolves to a public address', async () => {
    await expect(
      allowedRemoteAddresses({
        chosenBy: 'remote',
        host: 'mcp.example.com',
        deps: { resolveAddresses: PUBLIC, ownAddresses: [] },
      }),
    ).resolves.toEqual({ ok: true, addresses: ['93.184.216.34'] });
  });

  it('allows home-network addresses: RFC 1918 and shared address space', async () => {
    // Pinned empty own addresses: the machine running the suite has its own, and they are not
    // what this case judges.
    for (const host of ['192.168.1.20', '10.0.0.5', '172.16.4.9', '100.64.1.1']) {
      await expect(
        allowedRemoteAddresses({ chosenBy: 'remote', host, deps: { ownAddresses: [] } }),
      ).resolves.toMatchObject({
        ok: true,
      });
    }
  });

  it('allows a home-network name: a .local name resolving to a private address', async () => {
    const deps = {
      resolveAddresses: resolverFor({ 'homeassistant.local': ['192.168.1.20'] }),
      ownAddresses: [],
    };
    await expect(
      allowedRemoteAddresses({ chosenBy: 'remote', host: 'homeassistant.local', deps }),
    ).resolves.toMatchObject({
      ok: true,
    });
  });

  it.each([['127.0.0.1'], ['127.1.2.3'], ['0.0.0.1'], ['::1'], ['::']])('refuses %s as this computer', async host => {
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
  });

  it.each([['169.254.169.254'], ['fe80::1'], ['fd00:ec2::254'], ['::7f00:1']])(
    'refuses %s as protected',
    async host => {
      await expect(allowedRemoteAddresses({ chosenBy: 'remote', host })).resolves.toEqual({
        ok: false,
        reason: 'protected',
      });
    },
  );

  it('refuses the cloud metadata addresses inside otherwise allowed ranges', async () => {
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '100.100.100.200' })).resolves.toEqual({
      ok: false,
      reason: 'protected',
    });
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '168.63.129.16' })).resolves.toEqual({
      ok: false,
      reason: 'protected',
    });
  });

  it('refuses a name that resolves to loopback, like localhost does', async () => {
    const deps = { resolveAddresses: resolverFor({ localhost: ['127.0.0.1', '::1'] }) };
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: 'localhost', deps })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
  });

  it('refuses a name when even one of its addresses is refused', async () => {
    const deps = {
      resolveAddresses: resolverFor({ 'sneaky.example.com': ['93.184.216.34', '10.0.0.5', '127.0.0.1'] }),
    };
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: 'sneaky.example.com', deps })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
  });

  it('refuses this instance’s own address, and only that address on its network', async () => {
    const deps = { ownAddresses: ['172.20.0.5'] };
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '172.20.0.5', deps })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
    // Another address on the same home network is the person's own server to use: only the
    // machine's own address is refused, not the whole subnet it sits on.
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '172.20.9.9', deps })).resolves.toMatchObject({
      ok: true,
    });
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '172.21.0.1', deps })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      allowedRemoteAddresses({ chosenBy: 'remote', host: '172.20.0.5', deps: { ownAddresses: [] } }),
    ).resolves.toMatchObject({
      ok: true,
    });
  });

  it('refuses every address in a container network range, and only those ranges', async () => {
    // A container install names its own networks: a neighbour on one of them (the calendar
    // connector at 172.30.0.4, say) is one of the app's own parts, not a server the person
    // added, so the whole range is refused, not just this instance's own address on it.
    const deps = { ownAddresses: ['172.30.0.5'], ownNetworkRanges: ['172.30.0.0/16', 'fd00:beef::/64'] };
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '172.30.0.4', deps })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '172.30.255.254', deps })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: 'fd00:beef::99', deps })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
    // The person's home network is outside the named ranges and stays usable.
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '192.168.1.20', deps })).resolves.toMatchObject({
      ok: true,
    });
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '172.31.0.4', deps })).resolves.toMatchObject({
      ok: true,
    });
    // And with no ranges in force, as on a host run, the neighbour address is allowed.
    await expect(
      allowedRemoteAddresses({ chosenBy: 'remote', host: '172.30.0.4', deps: { ownAddresses: ['172.30.0.5'] } }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('refuses a name that resolves into a container network range', async () => {
    const deps = {
      resolveAddresses: resolverFor({ 'calendar-caldav': ['172.30.0.4'] }),
      ownAddresses: [],
      ownNetworkRanges: ['172.30.0.0/16'],
    };
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: 'calendar-caldav', deps })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
  });

  it('refuses an IPv4-mapped IPv6 address whose IPv4 address is in a container network range', async () => {
    const deps = { ownAddresses: [], ownNetworkRanges: ['172.30.0.0/16'] };
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '::ffff:172.30.0.4', deps })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
  });

  it('uses the configured container network ranges when a call names none', async () => {
    configureRemoteAddressCheck({ ownNetworkRanges: ['172.30.0.0/16'], demo: false });
    try {
      await expect(
        allowedRemoteAddresses({ chosenBy: 'remote', host: '172.30.0.4', deps: { ownAddresses: [] } }),
      ).resolves.toEqual({
        ok: false,
        reason: 'internal',
      });
      // An explicit set on the call wins over the configured one.
      await expect(
        allowedRemoteAddresses({
          chosenBy: 'remote',
          host: '172.30.0.4',
          deps: { ownAddresses: [], ownNetworkRanges: [] },
        }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      configureRemoteAddressCheck({ ownNetworkRanges: [], demo: false });
    }
  });

  it('refuses a name that resolves to this instance’s own address', async () => {
    const deps = {
      resolveAddresses: resolverFor({ 'this-machine.local': ['172.20.0.5'] }),
      ownAddresses: ['172.20.0.5'],
    };
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: 'this-machine.local', deps })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
  });

  it('refuses this instance’s own IPv6 address, and only that address on its network', async () => {
    const deps = { ownAddresses: ['fd00:1234::5'] };
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: 'fd00:1234::5', deps })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: 'fd00:1234::99', deps })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('judges an IPv4-mapped IPv6 address by the IPv4 address inside it', async () => {
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '::ffff:127.0.0.1' })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '::ffff:7f00:1' })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
    await expect(
      allowedRemoteAddresses({ chosenBy: 'remote', host: '::ffff:8.8.8.8', deps: { ownAddresses: [] } }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('reports a host that does not resolve as unresolved, whether the lookup is empty or fails', async () => {
    await expect(
      allowedRemoteAddresses({
        chosenBy: 'remote',
        host: 'gone.example.com',
        deps: { resolveAddresses: async () => [] },
      }),
    ).resolves.toEqual({ ok: false, reason: 'unresolved' });
    await expect(
      allowedRemoteAddresses({ chosenBy: 'remote', host: 'gone.example.com', deps: { resolveAddresses: PUBLIC } }),
    ).resolves.toEqual({ ok: false, reason: 'unresolved' });
  });
});

describe('addresses the owner chose', () => {
  // A direct run: no container ranges, not a demo, and this machine at 192.168.1.10 and its
  // Tailscale address 100.101.102.103.
  const direct = {
    ownAddresses: ['127.0.0.1', '::1', '192.168.1.10', '100.101.102.103'],
    ownNetworkRanges: [],
    demo: false,
  };

  it.each([['127.0.0.1'], ['::1'], ['192.168.1.10'], ['100.101.102.103'], ['::ffff:127.0.0.1']])(
    'allows %s on this computer when Aman runs directly',
    async host => {
      await expect(allowedRemoteAddresses({ chosenBy: 'owner', host, deps: direct })).resolves.toMatchObject({
        ok: true,
      });
    },
  );

  it('allows localhost, a .local name and a Tailscale name that resolve to this computer', async () => {
    const deps = {
      ...direct,
      resolveAddresses: resolverFor({
        localhost: ['127.0.0.1', '::1'],
        'box.local': ['192.168.1.10'],
        'box.example-tailnet.ts.net': ['100.101.102.103'],
      }),
    };
    for (const host of ['localhost', 'box.local', 'box.example-tailnet.ts.net']) {
      await expect(allowedRemoteAddresses({ chosenBy: 'owner', host, deps })).resolves.toMatchObject({ ok: true });
    }
  });

  it('still refuses this computer when a remote server chose the address', async () => {
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '127.0.0.1', deps: direct })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
    await expect(allowedRemoteAddresses({ chosenBy: 'remote', host: '192.168.1.10', deps: direct })).resolves.toEqual({
      ok: false,
      reason: 'internal',
    });
  });

  it.each([['169.254.169.254'], ['100.100.100.200'], ['168.63.129.16'], ['fe80::1'], ['fd00:ec2::254']])(
    'still refuses the protected address %s',
    async host => {
      await expect(allowedRemoteAddresses({ chosenBy: 'owner', host, deps: direct })).resolves.toEqual({
        ok: false,
        reason: 'protected',
      });
    },
  );

  it('refuses this computer and the container networks when Aman runs in a container', async () => {
    const container = { ownAddresses: ['127.0.0.1', '172.30.0.5'], ownNetworkRanges: ['172.30.0.0/16'], demo: false };
    for (const host of ['127.0.0.1', '172.30.0.4', '172.30.0.5']) {
      await expect(allowedRemoteAddresses({ chosenBy: 'owner', host, deps: container })).resolves.toEqual({
        ok: false,
        reason: 'internal',
      });
    }
    // host.docker.internal on Linux: the Docker bridge, outside the instance's own networks.
    const deps = { ...container, resolveAddresses: resolverFor({ 'host.docker.internal': ['172.17.0.1'] }) };
    await expect(
      allowedRemoteAddresses({ chosenBy: 'owner', host: 'host.docker.internal', deps }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('judges every address the strict way on a demo instance', async () => {
    await expect(
      allowedRemoteAddresses({ chosenBy: 'owner', host: '127.0.0.1', deps: { ...direct, demo: true } }),
    ).resolves.toEqual({ ok: false, reason: 'internal' });
  });

  it('uses the configured demo setting when a call names none', async () => {
    configureRemoteAddressCheck({ ownNetworkRanges: [], demo: true });
    try {
      await expect(
        allowedRemoteAddresses({ chosenBy: 'owner', host: '127.0.0.1', deps: { ownAddresses: [] } }),
      ).resolves.toEqual({ ok: false, reason: 'internal' });
    } finally {
      configureRemoteAddressCheck({ ownNetworkRanges: [], demo: false });
    }
  });

  it('passes a model on this computer without naming it in LOCAL_MODEL_ENDPOINTS', async () => {
    await expect(
      modelUrlProblem({ chosenBy: 'owner', url: 'http://127.0.0.1:11434/v1', endpoints: [], deps: direct }),
    ).resolves.toBeNull();
  });
});

describe('remoteUrlProblem', () => {
  it('passes a public https address', async () => {
    await expect(
      remoteUrlProblem({
        chosenBy: 'remote',
        url: 'https://mcp.example.com/mcp',
        deps: { resolveAddresses: PUBLIC, ownAddresses: [] },
      }),
    ).resolves.toBeNull();
  });

  it('passes a home-network http address, the shape a LAN server is saved with', async () => {
    await expect(
      remoteUrlProblem({
        chosenBy: 'remote',
        url: 'http://192.168.1.20:8123/mcp_server/sse',
        deps: { ownAddresses: [] },
      }),
    ).resolves.toBeNull();
  });

  it('refuses a loopback URL as internal', async () => {
    await expect(remoteUrlProblem({ chosenBy: 'remote', url: 'http://127.0.0.1:8080/mcp' })).resolves.toBe('internal');
    await expect(
      remoteUrlProblem({
        chosenBy: 'remote',
        url: 'http://localhost:11434/v1',
        deps: { resolveAddresses: resolverFor({ localhost: ['127.0.0.1'] }) },
      }),
    ).resolves.toBe('internal');
  });

  it('refuses the metadata address as protected', async () => {
    await expect(
      remoteUrlProblem({ chosenBy: 'remote', url: 'http://169.254.169.254/latest/meta-data' }),
    ).resolves.toBe('protected');
  });

  it('refuses an IPv6 loopback URL as internal', async () => {
    await expect(remoteUrlProblem({ chosenBy: 'remote', url: 'http://[::1]:11434/v1' })).resolves.toBe('internal');
  });

  it('reports a name that does not resolve as unresolved', async () => {
    await expect(
      remoteUrlProblem({ chosenBy: 'remote', url: 'https://gone.example.com/mcp', deps: { resolveAddresses: PUBLIC } }),
    ).resolves.toBe('unresolved');
  });

  it.each([
    ['not a url'],
    ['ftp://mcp.example.com/mcp'],
    ['https://user:secret@mcp.example.com/mcp'],
    ['https://user@mcp.example.com/mcp'],
    ['file:///etc/passwd'],
  ])('refuses %s as invalid', async url => {
    await expect(remoteUrlProblem({ chosenBy: 'remote', url, deps: { resolveAddresses: PUBLIC } })).resolves.toBe(
      'invalid',
    );
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

describe('modelUrlProblem', () => {
  it('passes a public model address', async () => {
    await expect(
      modelUrlProblem({
        chosenBy: 'remote',
        url: 'https://models.example.com/v1',
        endpoints: [],
        deps: { resolveAddresses: resolverFor({ 'models.example.com': ['93.184.216.34'] }), ownAddresses: [] },
      }),
    ).resolves.toBeNull();
  });

  it('passes the exact endpoint the operator named, though its address is refused', async () => {
    await expect(
      modelUrlProblem({ chosenBy: 'remote', url: 'http://127.0.0.1:11434/v1', endpoints: ['127.0.0.1:11434'] }),
    ).resolves.toBeNull();
  });

  it('refuses the same address on a port the operator did not name', async () => {
    await expect(
      modelUrlProblem({ chosenBy: 'remote', url: 'http://127.0.0.1:9999/v1', endpoints: ['127.0.0.1:11434'] }),
    ).resolves.toBe('internal');
  });

  it('reports a model name that does not resolve as unresolved', async () => {
    await expect(
      modelUrlProblem({
        chosenBy: 'remote',
        url: 'https://gone.example.com/v1',
        endpoints: [],
        deps: { resolveAddresses: PUBLIC },
      }),
    ).resolves.toBe('unresolved');
  });
});
