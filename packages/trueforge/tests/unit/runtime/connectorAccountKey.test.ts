import {
  connectorKeyId,
  deliverConnectorKey,
  keepConnectorKeyDelivered,
  type ConnectorKeyDeps,
} from '../../../src/runtime/connectorAccountKey';

const SECRET = 'made-up-account-secret-0123456789abcdef';
const CURRENT = Buffer.alloc(32, 7);
const EARLIER = Buffer.alloc(32, 9);

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/** A stand-in account agent: it holds no key until it is given one, and answers as the real agents do. */
function fakeAgent({ refuse }: { refuse?: { status: number; error: string } } = {}) {
  const calls: Call[] = [];
  let held: string | null = null;
  let down = false;
  const fetchImpl: typeof fetch = (input, init) => {
    if (down) {
      return Promise.reject(new Error('connect ECONNREFUSED'));
    }
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(input), authorization: headers.get('authorization'), body });
    if (method === 'GET') {
      return Promise.resolve(Response.json({ key_id: held }));
    }
    if (refuse !== undefined) {
      return Promise.resolve(Response.json({ error: refuse.error }, { status: refuse.status }));
    }
    held = connectorKeyId(CURRENT);
    return Promise.resolve(Response.json({ key_id: held }));
  };
  return {
    calls,
    fetchImpl,
    restart: () => {
      held = null;
    },
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

function depsFor(agent: { fetchImpl: typeof fetch }): ConnectorKeyDeps {
  return {
    accountUrl: 'http://mail-email:9559',
    secret: SECRET,
    keys: { current: CURRENT, earlier: [EARLIER] },
    label: 'Email',
    fetchImpl: agent.fetchImpl,
  };
}

describe('handing a connector the key of its account file', () => {
  it('hands the key over with the secret, and not again while the connector holds it', async () => {
    const agent = fakeAgent();
    expect(await deliverConnectorKey(depsFor(agent))).toBe('delivered');
    expect(agent.calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET http://mail-email:9559/key',
      'POST http://mail-email:9559/key',
    ]);
    expect(agent.calls.every(call => call.authorization === `Bearer ${SECRET}`)).toBe(true);
    expect(agent.calls[1]?.body).toEqual({ current: CURRENT.toString('hex'), earlier: [EARLIER.toString('hex')] });
    expect(await deliverConnectorKey(depsFor(agent))).toBe('held');
    expect(agent.calls).toHaveLength(3);
  });

  it('says why when the connector does not take the key', async () => {
    expect(await deliverConnectorKey(depsFor(fakeAgent({ refuse: { status: 409, error: 'wrong_key' } })))).toBe(
      'wrong_key',
    );
    expect(await deliverConnectorKey(depsFor(fakeAgent({ refuse: { status: 501, error: 'no_cipher' } })))).toBe(
      'no_cipher',
    );
    expect(await deliverConnectorKey(depsFor(fakeAgent({ refuse: { status: 500, error: 'internal' } })))).toBe(
      'refused',
    );
    const down = fakeAgent();
    down.setDown(true);
    expect(await deliverConnectorKey(depsFor(down))).toBe('unreachable');
  });

  it('hands the key over again after the connector restarts, and logs each change once without the key', async () => {
    const agent = fakeAgent();
    const lines: string[] = [];
    const logger = {
      info: (line: string) => lines.push(`info ${line}`),
      warn: (line: string) => lines.push(`warn ${line}`),
    };
    let round = 0;
    await keepConnectorKeyDelivered({
      ...depsFor(agent),
      logger,
      rounds: 6,
      sleep: () => {
        round += 1;
        if (round === 2) {
          agent.setDown(true);
        }
        if (round === 4) {
          agent.setDown(false);
          agent.restart();
        }
        return Promise.resolve();
      },
    });
    expect(lines).toEqual([
      'info Email connector was handed the key of its account file',
      'warn Email connector could not be reached to hand it the key of its account file; trying again.',
      'info Email connector was handed the key of its account file',
    ]);
    expect(lines.join('\n')).not.toContain(CURRENT.toString('hex'));
  });
});
