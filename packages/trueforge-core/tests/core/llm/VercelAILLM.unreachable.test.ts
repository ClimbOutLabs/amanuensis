/**
 * A model server that refuses the connection, through the real model client and a real socket: the call fails as a
 * connection that never started, in the host's words for where the model is, never as a reply that broke off.
 */
import net from 'node:net';
import { VercelAILLM } from '../../../src/core/llm/VercelAILLM';
import { ModelUnreachableError } from '../../../src/core/llm/modelUnreachable';
import { makeSilentLogger } from '../harnessMocks';

/** A port on this machine that nothing listens on: taken, then let go. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (address === null || typeof address === 'string') {
    throw new Error('no port');
  }
  return address.port;
}

async function drain(llm: VercelAILLM): Promise<unknown> {
  try {
    const stream = llm.create({ stream: true, messages: [{ role: 'user', content: 'hello' }] });
    for (let next = await stream.next(); !next.done; next = await stream.next()) {
      // nothing arrives
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('a model server that refuses the connection', () => {
  it('fails as unreachable, at the place the host names for the address', async () => {
    const port = await closedPort();
    const asked: string[] = [];
    const llm = new VercelAILLM({
      logger: makeSilentLogger(),
      providerConfig: {
        provider: { type: 'custom', name: 'local' },
        model: { id: 'local-model', name: 'local-model' },
        name: 'local',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'unused',
        headers: {},
      },
      placeOfModelHost: hostname => {
        asked.push(hostname);
        return 'elsewhere';
      },
    });

    const error = await drain(llm);

    expect(error).toBeInstanceOf(ModelUnreachableError);
    expect(asked).toEqual(['127.0.0.1']);
    if (!(error instanceof ModelUnreachableError)) {
      throw new Error('expected ModelUnreachableError');
    }
    expect(error.place).toBe('elsewhere');
    expect(error.message).toContain(`the model at 127.0.0.1:${port}`);
    expect(error.message).not.toContain('broke off');
  });

  it('fails as unreachable when the connection is closed before any answer, the way the local link passes on a refusal', async () => {
    // The link side accepts, then closes as soon as the model behind it refuses.
    const relay = net.createServer(socket => socket.destroy());
    await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
    const address = relay.address();
    if (address === null || typeof address === 'string') {
      throw new Error('no port');
    }
    try {
      const llm = new VercelAILLM({
        logger: makeSilentLogger(),
        providerConfig: {
          provider: { type: 'custom', name: 'local' },
          model: { id: 'local-model', name: 'local-model' },
          name: 'local',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: 'unused',
          headers: {},
        },
        placeOfModelHost: () => 'local_link',
      });

      const error = await drain(llm);

      expect(error).toBeInstanceOf(ModelUnreachableError);
      if (!(error instanceof ModelUnreachableError)) {
        throw new Error('expected ModelUnreachableError');
      }
      expect(error.message).toContain(`Nothing answered at port ${address.port} on this computer.`);
    } finally {
      relay.close();
    }
  });
});
