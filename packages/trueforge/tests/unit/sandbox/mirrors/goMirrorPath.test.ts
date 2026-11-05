import {
  checkGoMirrorPath,
  DEFAULT_GO_MODULE_HOSTS,
  isGoModuleHostName,
} from '../../../../src/sandbox/mirrors/goMirrorPath';

const hosts = new Set([...DEFAULT_GO_MODULE_HOSTS, 'modules.example.net']);

describe('checkGoMirrorPath', () => {
  it('gives the decoded path for an encoded one', () => {
    expect(checkGoMirrorPath({ rawRest: '/github.com/a/b/%40v/list', hosts })).toEqual({
      allowed: true,
      path: '/github.com/a/b/@v/list',
    });
    expect(checkGoMirrorPath({ rawRest: '/sumdb/sum.golang.org/%6Cookup/github.com/a/b@v1.0.0', hosts })).toEqual({
      allowed: true,
      path: '/sumdb/sum.golang.org/lookup/github.com/a/b@v1.0.0',
    });
  });

  it('wraps nothing but known shapes in the via route', () => {
    expect(checkGoMirrorPath({ rawRest: '/via/sum.golang.org/lookup/github.com/a/b@v1.0.0', hosts })).toEqual({
      allowed: true,
      path: '/via/sum.golang.org/lookup/github.com/a/b@v1.0.0',
    });
    expect(checkGoMirrorPath({ rawRest: '/via/proxy.golang.org/github.com/a/b/@latest', hosts })).toEqual({
      allowed: true,
      path: '/via/proxy.golang.org/github.com/a/b/@latest',
    });
    expect(checkGoMirrorPath({ rawRest: '/via/proxy.golang.org/modules.evil.net/b/@latest', hosts })).toEqual({
      allowed: false,
      reason: 'host',
      host: 'modules.evil.net',
    });
    expect(checkGoMirrorPath({ rawRest: '/via/proxy.golang.org/anything', hosts })).toEqual({
      allowed: false,
      reason: 'shape',
    });
  });

  it('names an unlisted host apart from an unknown shape', () => {
    expect(checkGoMirrorPath({ rawRest: '/modules.evil.net/b/@v/list', hosts })).toEqual({
      allowed: false,
      reason: 'host',
      host: 'modules.evil.net',
    });
    expect(checkGoMirrorPath({ rawRest: '/modules.example.net/b/@v/list', hosts }).allowed).toBe(true);
    expect(checkGoMirrorPath({ rawRest: '/github.com/a/b', hosts })).toEqual({ allowed: false, reason: 'shape' });
  });

  it.each(['/github.com/a/%zz/@v/list', '/github.com/a/b/@v/list%00', '/github.com/a/B/@v/list'])(
    'refuses %s',
    rawRest => {
      expect(checkGoMirrorPath({ rawRest, hosts }).allowed).toBe(false);
    },
  );
});

describe('IP addresses', () => {
  it.each(['1.2.3.4', '0x7f.0.0.1', '0x7f.0x0.0x0.0x1', '127.1', '[::1]', '::1', '2130706433.0'])(
    'is not a host name or module host: %s',
    name => {
      expect(isGoModuleHostName(name)).toBe(false);
      expect(checkGoMirrorPath({ rawRest: `/${name}/b/@v/list`, hosts: new Set([name]) }).allowed).toBe(false);
    },
  );
});

describe('default hosts', () => {
  it.each(['go.yaml.in', 'cel.dev'])('lists %s', name => {
    expect(checkGoMirrorPath({ rawRest: `/${name}/x/@v/list`, hosts }).allowed).toBe(true);
  });
});

describe('isGoModuleHostName', () => {
  it.each(['github.com', 'go.uber.org', 'modules.example.net', 'xn--bcher-kva.example'])('accepts %s', name => {
    expect(isGoModuleHostName(name)).toBe(true);
  });
  it.each([
    '',
    'localhost',
    'GitHub.com',
    'github.com:443',
    'github.com/x',
    '*.github.com',
    'a..b',
    '-a.com',
    'a b.com',
  ])('refuses "%s"', name => {
    expect(isGoModuleHostName(name)).toBe(false);
  });
});
