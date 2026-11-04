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

  it.each(['Example.com', 'example.com:443', 'example.com/path', '*.example.com', 'https://example.com', 'localhost'])(
    'refuses %s',
    entry => {
      expect(() => parseGoModuleHosts(`github.com,${entry}`)).toThrow(/SANDBOX_MIRROR_GO_EXTRA_HOSTS/);
    },
  );
});
