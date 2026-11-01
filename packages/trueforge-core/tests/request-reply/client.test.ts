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
    expect(getDel).toHaveBeenCalledTimes(1);
  });
});
