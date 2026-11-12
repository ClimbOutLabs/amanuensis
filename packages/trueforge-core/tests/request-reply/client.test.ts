import { createClient } from 'redis';
import { redisRequest } from '../../src/request-reply/client';
import { NoResponderError } from '../../src/request-reply/errors';
import { heartbeatKey } from '../../src/request-reply/utils';

describe('redisRequest', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails with NoResponderError when the executor dies while waiting for a reply', async () => {
    const redis = createClient({ url: 'redis://127.0.0.1:6379', RESP: 2 });
    const exists = jest.spyOn(redis, 'exists').mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    jest.spyOn(redis, 'publish').mockResolvedValue(1);
    const getDel = jest.spyOn(redis, 'getDel').mockResolvedValue(null);

    await expect(
      redisRequest({
        redis,
        executorId: 'exec-1',
        path: '/ping',
        request: { body: { ping: true } },
        options: { replyTimeoutMs: 5_000, pollIntervalMs: 1 },
      }),
    ).rejects.toBeInstanceOf(NoResponderError);

    expect(exists).toHaveBeenCalledTimes(2);
    expect(exists).toHaveBeenNthCalledWith(1, heartbeatKey('exec-1'));
    expect(exists).toHaveBeenNthCalledWith(2, heartbeatKey('exec-1'));
    // One poll, plus one final check of the reply key before throwing.
    expect(getDel).toHaveBeenCalledTimes(2);
  });

  it('returns the reply when the final check finds one written just before the heartbeat expired', async () => {
    const redis = createClient({ url: 'redis://127.0.0.1:6379', RESP: 2 });
    jest.spyOn(redis, 'exists').mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    jest.spyOn(redis, 'publish').mockResolvedValue(1);
    const reply = { status: 200, headers: {}, body: { pong: true } };
    jest.spyOn(redis, 'getDel').mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify(reply));

    await expect(
      redisRequest({
        redis,
        executorId: 'exec-1',
        path: '/ping',
        request: { body: { ping: true } },
        options: { replyTimeoutMs: 5_000, pollIntervalMs: 1 },
      }),
    ).resolves.toEqual(reply);
  });
});
