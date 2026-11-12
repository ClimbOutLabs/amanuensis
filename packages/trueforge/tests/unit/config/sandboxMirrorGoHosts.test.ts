import { parseGoModuleHosts } from '../../../src/config';

describe('SANDBOX_MIRROR_GO_EXTRA_HOSTS parsing', () => {
  it('is empty when unset or blank', () => {
    expect(parseGoModuleHosts(undefined)).toEqual([]);
    expect(parseGoModuleHosts('  ')).toEqual([]);
  });

  it('reads a comma list of host names once each', () => {
    expect(parseGoModuleHosts('modules.example.net, git.example.org,modules.example.net,')).toEqual([
      'modules.example.net',
      'git.example.org',
    ]);
  });

  it.each([
    'Example.com',
    'example.com:443',
    'example.com/path',
    '*.example.com',
    'https://example.com',
    'localhost',
    '1.2.3.4',
    '0x7f.0.0.1',
    '[::1]',
  ])('refuses %s', entry => {
    expect(() => parseGoModuleHosts(`github.com,${entry}`)).toThrow(/SANDBOX_MIRROR_GO_EXTRA_HOSTS.*"/);
  });

  it('names the bad entry, a valid example and what to do', () => {
    expect(() => parseGoModuleHosts('github.com,localhost')).toThrow(
      /"localhost".*lower-case host name with a dot, like example\.com.*Fix or remove that entry/,
    );
  });
});
