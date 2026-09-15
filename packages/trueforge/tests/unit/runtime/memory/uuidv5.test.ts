import { uuidv5 } from '../../../../src/runtime/memory/uuidv5';

// Verified against Python's stdlib `uuid.uuid5` (an independent RFC 4122 reference
// implementation): uuid.uuid5(uuid.NAMESPACE_DNS, 'www.example.org').
const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidv5', () => {
  it('matches a known RFC 4122 test vector', () => {
    expect(uuidv5({ name: 'www.example.org', namespace: NAMESPACE_DNS })).toBe('74738ff5-5367-5958-9aee-98fffdcd1876');
  });

  it('is deterministic for the same name and namespace', () => {
    const namespace = 'b6d6d9ad-6f92-5a2c-9d61-1c8e254f0d6b';
    expect(uuidv5({ name: 's1/t1', namespace })).toBe(uuidv5({ name: 's1/t1', namespace }));
  });

  it('differs when the name differs', () => {
    const namespace = 'b6d6d9ad-6f92-5a2c-9d61-1c8e254f0d6b';
    expect(uuidv5({ name: 's1/t1', namespace })).not.toBe(uuidv5({ name: 's1/t2', namespace }));
  });

  it('differs when the namespace differs', () => {
    expect(uuidv5({ name: 'same-name', namespace: 'b6d6d9ad-6f92-5a2c-9d61-1c8e254f0d6b' })).not.toBe(
      uuidv5({ name: 'same-name', namespace: NAMESPACE_DNS }),
    );
  });

  it('stamps version 5 and the RFC 4122 variant', () => {
    const id = uuidv5({ name: 'anything', namespace: 'b6d6d9ad-6f92-5a2c-9d61-1c8e254f0d6b' });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('rejects a malformed namespace', () => {
    expect(() => uuidv5({ name: 'name', namespace: 'not-a-uuid' })).toThrow('Invalid UUID namespace');
  });
});
