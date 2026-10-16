import { describeNetworkError, redactUrl } from '../../../../src/cli/doctor/redact';
import { networkError } from './fakeDeps';

describe('redactUrl', () => {
  it('drops credentials, query and fragment', () => {
    expect(redactUrl('https://user:SENTINEL@login.example.com/dex?token=SENTINEL#frag')).toBe(
      'https://login.example.com/dex',
    );
  });

  it('keeps host, port and path and trims a bare slash', () => {
    expect(redactUrl('http://127.0.0.1:5556/dex')).toBe('http://127.0.0.1:5556/dex');
    expect(redactUrl('http://localhost:5556/')).toBe('http://localhost:5556');
  });

  it('does not echo an unparseable value', () => {
    expect(redactUrl('SENTINEL not a url')).toBe('[invalid address]');
  });
});

describe('describeNetworkError', () => {
  it('uses the system error code', () => {
    expect(describeNetworkError(networkError('ECONNREFUSED'))).toBe('ECONNREFUSED');
  });

  it('names timeouts', () => {
    expect(describeNetworkError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timed out');
  });

  it('never echoes the message, which can carry an address', () => {
    expect(describeNetworkError(new Error('failed https://user:SENTINEL@host/'))).toBe('no answer');
  });
});
