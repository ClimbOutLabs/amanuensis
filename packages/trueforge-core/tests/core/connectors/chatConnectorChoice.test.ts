import {
  connectorOffKey,
  readTurnedOffConnectorKeys,
  withTurnedOffConnectorKeys,
} from '../../../src/core/connectors/chatConnectorChoice';

const KEY_CAP = 32;
const VALUE_CAP = 128;
const LONG_NAME = 'a-very-long-search-provider-name-'.repeat(20);

describe('connectorOffKey', () => {
  it('is stable, short for any name, and different for different names', () => {
    expect(connectorOffKey('Email')).toBe(connectorOffKey('Email'));
    expect(connectorOffKey('Email')).not.toBe(connectorOffKey('Calendar'));
    expect(connectorOffKey(LONG_NAME).length).toBeLessThanOrEqual(KEY_CAP);
  });
});

describe('readTurnedOffConnectorKeys', () => {
  it('reads the flags stored for the chat', () => {
    const metadata = withTurnedOffConnectorKeys({ other: 'kept' }, [connectorOffKey('Email')]);
    expect(readTurnedOffConnectorKeys(metadata)).toEqual([connectorOffKey('Email')]);
  });

  it('reads nothing when the chat stored no choice', () => {
    expect(readTurnedOffConnectorKeys(undefined)).toEqual([]);
    expect(readTurnedOffConnectorKeys(null)).toEqual([]);
    expect(readTurnedOffConnectorKeys({ other: 'kept' })).toEqual([]);
  });
});

describe('withTurnedOffConnectorKeys', () => {
  it('keeps the chat’s other metadata and round-trips the keys', () => {
    const next = withTurnedOffConnectorKeys({ other: 'kept' }, [connectorOffKey('Email')]);
    expect(next['other']).toBe('kept');
    expect(readTurnedOffConnectorKeys(next)).toEqual([connectorOffKey('Email')]);
  });

  it('removes the flags when nothing is turned off', () => {
    const stored = withTurnedOffConnectorKeys({}, [connectorOffKey('Email')]);
    expect(withTurnedOffConnectorKeys(stored, [])).toEqual({});
  });

  it('keeps a very long connector name inside the key and value caps, off and back on', () => {
    const key = connectorOffKey(LONG_NAME);
    const off = withTurnedOffConnectorKeys({}, [key, connectorOffKey('Email'), connectorOffKey('Calendar')]);
    for (const [name, value] of Object.entries(off)) {
      expect(name.length).toBeLessThanOrEqual(KEY_CAP);
      expect(value.length).toBeLessThanOrEqual(VALUE_CAP);
    }
    expect(readTurnedOffConnectorKeys(off)).toContain(key);
    const on = withTurnedOffConnectorKeys(
      off,
      readTurnedOffConnectorKeys(off).filter(item => item !== key),
    );
    expect(readTurnedOffConnectorKeys(on)).not.toContain(key);
  });

  it('refuses a raw connector name, so only short keys are stored', () => {
    expect(() => withTurnedOffConnectorKeys({}, ['Email'])).toThrow('connectorOffKey');
  });
});
