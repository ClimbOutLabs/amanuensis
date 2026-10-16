import configuration, { parseFirstPartyMcpOrigins } from '../../../src/config';

describe('parseFirstPartyMcpOrigins', () => {
  it('lists no origin when unset or blank, so nothing is first-party', () => {
    expect(parseFirstPartyMcpOrigins(undefined)).toEqual([]);
    expect(parseFirstPartyMcpOrigins('')).toEqual([]);
    expect(parseFirstPartyMcpOrigins('   ')).toEqual([]);
    expect(parseFirstPartyMcpOrigins(' , ,')).toEqual([]);
  });

  it('is empty by default in the loaded configuration', () => {
    expect(configuration.FIRST_PARTY_MCP_ORIGINS).toEqual([]);
  });

  it('splits on commas and trims whitespace', () => {
    expect(parseFirstPartyMcpOrigins(' https://memory.internal:8443 , http://localhost:8888,')).toEqual([
      'https://memory.internal:8443',
      'http://localhost:8888',
    ]);
  });

  it('normalizes each entry the way a connector URL is, and drops duplicates', () => {
    expect(
      parseFirstPartyMcpOrigins('HTTPS://Memory.Internal:443/, https://memory.internal, http://[::1]:8080'),
    ).toEqual(['https://memory.internal', 'http://[::1]:8080']);
  });

  it('keeps the scheme and the port, so each is its own origin', () => {
    expect(
      parseFirstPartyMcpOrigins('https://memory.internal,http://memory.internal,https://memory.internal:8443'),
    ).toEqual(['https://memory.internal', 'http://memory.internal', 'https://memory.internal:8443']);
  });

  it.each([
    ['a path', 'https://memory.internal/mcp'],
    ['a query', 'https://memory.internal?x=1'],
    ['a fragment', 'https://memory.internal#frag'],
    ['an empty query', 'https://memory.internal/?'],
    ['credentials', 'https://user:secret@memory.internal'],
    ['a wildcard host', 'https://*.memory.internal'],
    ['no scheme', 'memory.internal:8443'],
    ['a bare host', 'memory.internal'],
    ['a scheme other than http and https', 'ftp://memory.internal'],
    ['text that is not a URL', 'not a url'],
  ])('fails the boot for %s, naming the setting and the entry', (_label, entry) => {
    const parse = () => parseFirstPartyMcpOrigins(`https://good.internal,${entry}`);

    expect(parse).toThrow('FIRST_PARTY_MCP_ORIGINS');
    expect(parse).toThrow(entry);
  });
});
