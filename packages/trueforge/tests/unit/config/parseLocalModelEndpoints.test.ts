import configuration, { parseLocalModelEndpoints } from '../../../src/config';

describe('parseLocalModelEndpoints', () => {
  it('lists no endpoint when unset or blank, so no local model endpoint is allowed', () => {
    expect(parseLocalModelEndpoints(undefined)).toEqual([]);
    expect(parseLocalModelEndpoints('')).toEqual([]);
    expect(parseLocalModelEndpoints('   ')).toEqual([]);
    expect(parseLocalModelEndpoints(' , ,')).toEqual([]);
  });

  it('is empty by default in the loaded configuration', () => {
    expect(configuration.LOCAL_MODEL_ENDPOINTS).toEqual([]);
  });

  it('splits on commas and trims whitespace', () => {
    expect(parseLocalModelEndpoints(' localhost:11434 , 192.168.1.5:8080,')).toEqual([
      'localhost:11434',
      '192.168.1.5:8080',
    ]);
  });

  it('normalizes each entry and drops duplicates', () => {
    expect(
      parseLocalModelEndpoints('LOCALHOST:11434, localhost:011434, Host.Docker.Internal:11434, [::1]:8080'),
    ).toEqual(['localhost:11434', 'host.docker.internal:11434', '[::1]:8080']);
  });

  it.each([
    ['a bare host with no port', 'localhost'],
    ['a port of zero', 'localhost:0'],
    ['a port past the range', 'localhost:65536'],
    ['a port that is not a number', 'localhost:abc'],
    ['a full URL instead of a host and port', 'http://localhost:11434'],
    ['an IPv6 host without brackets', '::1:11434'],
    ['a wildcard host', '*:11434'],
    ['a host with a space in it', 'local host:11434'],
    ['a host with a path in it', 'localhost/mcp:11434'],
  ])('fails the boot for %s, naming the setting and the entry', (_label, entry) => {
    const parse = () => parseLocalModelEndpoints(`localhost:11434,${entry}`);

    expect(parse).toThrow('LOCAL_MODEL_ENDPOINTS');
    expect(parse).toThrow(entry);
  });
});
