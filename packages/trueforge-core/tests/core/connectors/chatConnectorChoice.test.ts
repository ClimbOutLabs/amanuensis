import {
  connectorOffKey,
  readTurnedOffConnectorKeys,
  upgradeConnectorChoiceMetadata,
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

  it('still reads the single name list that older chats stored', () => {
    const older = { connectors_off: '["Email","Calendar","Email"]', other: 'kept' };
    expect(readTurnedOffConnectorKeys(older)).toEqual([connectorOffKey('Email'), connectorOffKey('Calendar')]);
  });

  it('reads nothing from a damaged older value, so the chat falls back to on', () => {
    expect(readTurnedOffConnectorKeys({ connectors_off: 'not json' })).toEqual([]);
    expect(readTurnedOffConnectorKeys({ connectors_off: '{"Email":true}' })).toEqual([]);
    expect(readTurnedOffConnectorKeys({ connectors_off: '["Email", 7, ""]' })).toEqual([connectorOffKey('Email')]);
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

  it('drops the older name list once its names are flags', () => {
    const next = withTurnedOffConnectorKeys({ connectors_off: '["Email"]' }, [connectorOffKey('Email')]);
    expect(next).not.toHaveProperty('connectors_off');
  });
});

describe('upgradeConnectorChoiceMetadata', () => {
  it('turns an older name list into flags and keeps other keys', () => {
    const upgraded = upgradeConnectorChoiceMetadata({ connectors_off: `["${LONG_NAME}"]`, other: 'kept' });
    expect(upgraded).not.toHaveProperty('connectors_off');
    expect(upgraded['other']).toBe('kept');
    expect(readTurnedOffConnectorKeys(upgraded)).toEqual([connectorOffKey(LONG_NAME)]);
  });
});
