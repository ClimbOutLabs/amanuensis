import { createConnectorAccountHandlers } from '../../../src/apis/connectorAccountHandlers';
import {
  ACCOUNT_AGENT_TIMEOUTS_MS,
  ConnectorAccountError,
  type ConnectorAccountState,
} from '../../../src/runtime/connectorAccount';

const NONE: ConnectorAccountState<string> = { connected: false, sign_in: null, account: null };
const SAVED: ConnectorAccountState<string> = { connected: true, sign_in: 'ok', account: 'owner' };

function makeKind() {
  const readTimeouts: (number | undefined)[] = [];
  const synced: ConnectorAccountState<string>[] = [];
  const control: { saveFails: boolean } = { saveFails: false };
  return {
    readTimeouts,
    synced,
    control,
    kind: {
      isAvailable: () => true,
      unavailableBody: () => 'unavailable',
      statusBody: (state: ConnectorAccountState<string>) => (state.connected ? 'connected' : 'none'),
      readState: (options: { timeoutMs?: number | undefined }) => {
        readTimeouts.push(options.timeoutMs);
        return Promise.resolve(SAVED);
      },
      save: (_request: string): Promise<ConnectorAccountState<string>> =>
        control.saveFails
          ? Promise.reject(new ConnectorAccountError({ failure: 'connector_unreachable', message: 'later' }))
          : Promise.resolve(SAVED),
      remove: () => Promise.resolve(NONE),
      sync: (state: ConnectorAccountState<string>) => {
        synced.push(state);
        return Promise.resolve();
      },
    },
  };
}

describe('the account endpoint handlers', () => {
  it('reads the status with the full wait, and a cut-off save with a short one', async () => {
    const fake = makeKind();
    const handlers = createConnectorAccountHandlers(fake.kind);
    await handlers.status();
    fake.control.saveFails = true;
    const answer = await handlers.save('request');
    expect(answer.status).toBe(502);
    expect(fake.readTimeouts).toEqual([undefined, ACCOUNT_AGENT_TIMEOUTS_MS.reconcile]);
    expect(fake.synced).toEqual([SAVED, SAVED]);
  });

  it('keeps a save and its re-read under a minute together, and a removal and its re-read well under that', () => {
    expect(ACCOUNT_AGENT_TIMEOUTS_MS.save + ACCOUNT_AGENT_TIMEOUTS_MS.reconcile).toBeLessThan(60_000);
    expect(ACCOUNT_AGENT_TIMEOUTS_MS.remove + ACCOUNT_AGENT_TIMEOUTS_MS.reconcile).toBeLessThan(60_000);
  });
});
