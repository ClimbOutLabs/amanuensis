import {
  CHAT_CONNECTORS_OFF_METADATA_KEY,
  readTurnedOffConnectors,
  withTurnedOffConnectors,
} from '../../../src/core/connectors/chatConnectorChoice';

describe('readTurnedOffConnectors', () => {
  it('reads the names stored for the chat', () => {
    const metadata = { [CHAT_CONNECTORS_OFF_METADATA_KEY]: '["Email","Calendar"]', other: 'kept' };
    expect(readTurnedOffConnectors(metadata)).toEqual(['Email', 'Calendar']);
  });

  it('reads nothing when the chat stored no choice', () => {
    expect(readTurnedOffConnectors(undefined)).toEqual([]);
    expect(readTurnedOffConnectors(null)).toEqual([]);
    expect(readTurnedOffConnectors({})).toEqual([]);
    expect(readTurnedOffConnectors({ other: 'kept' })).toEqual([]);
  });

  it('reads nothing from a damaged value, so the chat falls back to the default', () => {
    expect(readTurnedOffConnectors({ [CHAT_CONNECTORS_OFF_METADATA_KEY]: 'not json' })).toEqual([]);
    expect(readTurnedOffConnectors({ [CHAT_CONNECTORS_OFF_METADATA_KEY]: '{"Email":true}' })).toEqual([]);
    expect(readTurnedOffConnectors({ [CHAT_CONNECTORS_OFF_METADATA_KEY]: '["Email", 7, ""]' })).toEqual(['Email']);
  });

  it('keeps each name once', () => {
    expect(readTurnedOffConnectors({ [CHAT_CONNECTORS_OFF_METADATA_KEY]: '["Email","Email"]' })).toEqual(['Email']);
  });
});

describe('withTurnedOffConnectors', () => {
  it('stores the names and keeps the chat’s other metadata', () => {
    const next = withTurnedOffConnectors({ other: 'kept' }, ['Email']);
    expect(next).toEqual({ other: 'kept', [CHAT_CONNECTORS_OFF_METADATA_KEY]: '["Email"]' });
    expect(readTurnedOffConnectors(next)).toEqual(['Email']);
  });

  it('removes the key when nothing is turned off, so the chat carries no stale choice', () => {
    const stored = withTurnedOffConnectors({}, ['Email', 'Calendar']);
    const cleared = withTurnedOffConnectors(stored, []);
    expect(cleared).toEqual({});
    expect(readTurnedOffConnectors(cleared)).toEqual([]);
  });

  it('starts from no metadata at all', () => {
    expect(withTurnedOffConnectors(undefined, ['Calendar'])).toEqual({
      [CHAT_CONNECTORS_OFF_METADATA_KEY]: '["Calendar"]',
    });
    expect(withTurnedOffConnectors(null, [])).toEqual({});
  });
});
