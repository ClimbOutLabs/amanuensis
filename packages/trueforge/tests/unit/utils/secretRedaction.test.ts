import {
  isRedactedSecretValue,
  MissingStoredSecretError,
  resolveStoredSecretValue,
  SECRET_REDACTION,
} from '../../../src/utils/secretRedaction';

describe('secretRedaction', () => {
  it('uses a fixed mask that contains no secret material', () => {
    expect(SECRET_REDACTION).toBe('***REDACTED***');
    expect(isRedactedSecretValue(SECRET_REDACTION)).toBe(true);
  });

  it('treats masks with a legacy prefix and suffix as keep requests', () => {
    expect(isRedactedSecretValue('sk--***REDACTED***-xyz')).toBe(true);
    expect(resolveStoredSecretValue({ incoming: 'sk--***REDACTED***-xyz', existing: 'sk-real-secret' })).toBe(
      'sk-real-secret',
    );
  });

  it('stores a real incoming value as-is', () => {
    expect(resolveStoredSecretValue({ incoming: 'sk-new', existing: 'sk-old' })).toBe('sk-new');
  });

  it('rejects a keep request when nothing is stored', () => {
    expect(() => resolveStoredSecretValue({ incoming: SECRET_REDACTION, existing: undefined })).toThrow(
      MissingStoredSecretError,
    );
  });
});
