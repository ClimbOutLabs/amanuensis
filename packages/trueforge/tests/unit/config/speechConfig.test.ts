import { parseSpeechSecret, parseSpeechUrl } from '../../../src/config';

describe('parseSpeechUrl', () => {
  const parse = (raw: string | undefined): string =>
    parseSpeechUrl({ envKey: 'STT_URL', raw, defaultValue: 'http://aman-stt:8001' });

  it('falls back to the default when unset or blank', () => {
    expect(parse(undefined)).toBe('http://aman-stt:8001');
    expect(parse('  ')).toBe('http://aman-stt:8001');
  });

  it('allows loopback addresses', () => {
    expect(parse('http://localhost:8001')).toBe('http://localhost:8001');
    expect(parse(' http://127.0.0.1:8001 ')).toBe('http://127.0.0.1:8001');
    expect(parse('http://[::1]:8001')).toBe('http://[::1]:8001');
  });

  it('allows an internal service name, like the compose default', () => {
    expect(parse('http://aman-stt:8001')).toBe('http://aman-stt:8001');
  });

  it('allows a private network address', () => {
    expect(parse('http://192.168.1.20:8001')).toBe('http://192.168.1.20:8001');
    expect(parse('http://10.0.0.5:8002')).toBe('http://10.0.0.5:8002');
  });

  it('refuses a remote address over plain http', () => {
    expect(() => parse('http://speech.example.com:8001')).toThrow(/STT_URL points at speech\.example\.com/);
    expect(() => parse('http://203.0.113.10:8001')).toThrow(/STT_URL points at 203\.0\.113\.10/);
  });

  it('refuses a remote address over https too', () => {
    expect(() => parse('https://speech.example.com:8001')).toThrow(/STT_URL points at speech\.example\.com/);
  });

  it('refuses a value that is not an http(s) URL', () => {
    expect(() => parse('aman-stt:8001')).toThrow(/STT_URL must be/);
    expect(() => parse('file:///run/stt.sock')).toThrow(/STT_URL must be/);
  });
});

describe('parseSpeechSecret', () => {
  it('treats unset and blank as no secret', () => {
    expect(parseSpeechSecret(undefined)).toBeUndefined();
    expect(parseSpeechSecret('')).toBeUndefined();
    expect(parseSpeechSecret('   ')).toBeUndefined();
  });

  it('trims and returns a long enough secret', () => {
    const secret = 'a'.repeat(32);
    expect(parseSpeechSecret(` ${secret}\n`)).toBe(secret);
  });

  it('refuses a secret that is too short', () => {
    expect(() => parseSpeechSecret('a'.repeat(31))).toThrow(/SPEECH_SECRET must be at least 32 characters/);
  });
});
