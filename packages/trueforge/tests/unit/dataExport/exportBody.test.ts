import { serve } from '@hono/node-server';

import { exportResponseBody } from '../../../src/dataExport/exportBody';

async function listen(handler: () => Response): Promise<{ url: string; close: () => Promise<void> }> {
  const server = serve({ fetch: handler, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('The test server has no TCP address.');
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    close: () =>
      new Promise<void>(resolve => {
        if ('closeAllConnections' in server) {
          server.closeAllConnections();
        }
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe('exportResponseBody', () => {
  it('delivers everything produced, in order', async () => {
    const body = exportResponseBody({
      produce: async out => {
        for (let index = 0; index < 5; index += 1) {
          out.write(Buffer.from(`part-${String(index)};`));
        }
        await Promise.resolve();
      },
    });
    expect(await new Response(body).text()).toBe('part-0;part-1;part-2;part-3;part-4;');
  });

  it('applies backpressure: a large production waits for the reader', async () => {
    let writes = 0;
    const body = exportResponseBody({
      produce: async out => {
        for (let index = 0; index < 200; index += 1) {
          if (!out.write(Buffer.alloc(64 * 1024, 0x61))) {
            await new Promise<void>(resolve => out.once('drain', resolve));
          }
          writes += 1;
        }
      },
    });
    const reader = body.getReader();
    await reader.read();
    await new Promise(resolve => setTimeout(resolve, 100));
    // Roughly the queue size, not all 12.5 MiB.
    expect(writes).toBeLessThan(100);
    await reader.cancel();
  });

  it('errors the body when production fails, so a reader cannot take a short body for a whole one', async () => {
    const body = exportResponseBody({
      produce: async out => {
        out.write(Buffer.from('half an archive'));
        await Promise.resolve();
        throw new Error('export failed');
      },
    });
    await expect(new Response(body).arrayBuffer()).rejects.toThrow();
  });

  it('drops the connection on a failed export when served over a real socket', async () => {
    // The server adapter logs the failure it is meant to turn into a dropped connection.
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { url, close } = await listen(
      () =>
        new Response(
          exportResponseBody({
            produce: async out => {
              out.write(Buffer.alloc(100 * 1024, 0x61));
              await new Promise(resolve => setTimeout(resolve, 20));
              throw new Error('export failed');
            },
          }),
          { headers: { 'content-type': 'application/zip' } },
        ),
    );
    try {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      await expect(response.arrayBuffer()).rejects.toThrow();
    } finally {
      await close();
      logged.mockRestore();
    }
  });

  it('stops production when the reader cancels', async () => {
    let failure: unknown;
    const body = exportResponseBody({
      produce: async out => {
        try {
          for (;;) {
            if (!out.write(Buffer.alloc(64 * 1024))) {
              await new Promise<void>((resolve, reject) => {
                out.once('drain', resolve);
                out.once('close', () => {
                  reject(new Error('closed'));
                });
              });
            }
          }
        } catch (error) {
          failure = error;
          throw error;
        }
      },
    });
    const reader = body.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(failure).toBeInstanceOf(Error);
  });
});
