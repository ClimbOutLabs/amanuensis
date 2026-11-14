import configuration, { parseContainerNetworkRanges } from '../../../src/config';

describe('parseContainerNetworkRanges', () => {
  it('lists no range when unset or blank, so only this instance’s own addresses are refused', () => {
    expect(parseContainerNetworkRanges(undefined)).toEqual([]);
    expect(parseContainerNetworkRanges('')).toEqual([]);
    expect(parseContainerNetworkRanges('   ')).toEqual([]);
    expect(parseContainerNetworkRanges(' , ,')).toEqual([]);
  });

  it('is empty by default in the loaded configuration', () => {
    expect(configuration.CONTAINER_NETWORK_RANGES).toEqual([]);
  });

  it('splits on commas and trims whitespace', () => {
    expect(parseContainerNetworkRanges(' 172.30.0.0/16 , 172.31.0.0/16,')).toEqual(['172.30.0.0/16', '172.31.0.0/16']);
  });

  it('normalizes each entry and drops duplicates', () => {
    expect(parseContainerNetworkRanges('172.30.0.0/016, 172.30.0.0/16, FD00:BEEF::/64')).toEqual([
      '172.30.0.0/16',
      'fd00:beef::/64',
    ]);
  });

  it.each([
    ['a bare address with no prefix', '172.30.0.0'],
    ['a prefix past the IPv4 range', '172.30.0.0/33'],
    ['a prefix past the IPv6 range', 'fd00:beef::/129'],
    ['a prefix that is not a number', '172.30.0.0/abc'],
    ['a host name instead of an address', 'docker.local/16'],
    ['a full URL instead of a range', 'http://172.30.0.0/16'],
  ])('fails the boot for %s, naming the setting and the entry', (_label, entry) => {
    const parse = () => parseContainerNetworkRanges(`172.30.0.0/16,${entry}`);

    expect(parse).toThrow('CONTAINER_NETWORK_RANGES');
    expect(parse).toThrow(entry);
  });
});
