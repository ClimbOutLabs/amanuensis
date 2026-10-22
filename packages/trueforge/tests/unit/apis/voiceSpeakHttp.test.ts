import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger, transports } from 'winston';

import { createVoiceRouter } from '../../../src/apis/voice';
import type { Authenticator } from '../../../src/auth/authenticator';
import { STANDALONE_REQUEST_CONTEXT, resolveRequestContext } from '../../../src/auth/identity';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import configuration from '../../../src/config';
import { MAX_SPEAK_TEXT_CHARS } from '../../../src/schemas/voice';
import { SpeechRateLimiter } from '../../../src/voice/speechRateLimit';

const SECRET_REPLY = 'your bank password is hunter two';
const FAKE_WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

/** `x-test-user` names the caller; no header means not signed in. */
const headerAuthenticator: Authenticator = {
  authenticate: c => {
    const user = c.req.header('x-test-user');
    if (user === undefined) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    return Promise.resolve({ ...STANDALONE_REQUEST_CONTEXT, subject: { id: user, type: 'user', display_name: user } });
  },
};

interface FakeTtsCall {
  path: string;
  contentType: string | undefined;
  body: unknown;
}

/** Stands in for the aman-tts sidecar on a local port. */
class FakeTts {
  readonly calls: FakeTtsCall[] = [];
  reply: (res: ServerResponse) => void = res => {
    res.writeHead(200, { 'content-type': 'audio/wav' });
    res.end(Buffer.from(FAKE_WAV));
  };
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body: unknown = raw === '' ? undefined : JSON.parse(raw);
        this.calls.push({ path: req.url ?? '', contentType: req.headers['content-type'], body });
        this.reply(res);
      });
    });
    const server = this.server;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fake TTS server has no port');
    }
    return `http://127.0.0.1:${String(address.port)}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server !== undefined) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
}

function speakRequest(body: unknown, user: string | null = 'alice'): RequestInit {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (user !== null) {
    headers['x-test-user'] = user;
  }
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

describe('POST /speak', () => {
  const logger = createLogger({ transports: [new transports.Console({ silent: true })] });
  const infoSpy = jest.spyOn(logger, 'info');
  const warnSpy = jest.spyOn(logger, 'warn');
  const fakeTts = new FakeTts();
  const originalTtsUrl = configuration.TTS_URL;
  let fakeTtsUrl = '';

  function appWith(speechLimiter = new SpeechRateLimiter()): OpenAPIHono {
    const app = new OpenAPIHono();
    app.use('*', createAuthMiddleware(headerAuthenticator));
    app.route('/', createVoiceRouter({ logger, resolveRequestContext, speechLimiter }));
    return app;
  }

  beforeAll(async () => {
    fakeTtsUrl = await fakeTts.start();
    // The trailing slash proves the base URL is normalized.
    configuration.TTS_URL = `${fakeTtsUrl}/`;
  });

  afterAll(async () => {
    configuration.TTS_URL = originalTtsUrl;
    await fakeTts.stop();
  });

  beforeEach(() => {
    fakeTts.calls.length = 0;
    fakeTts.reply = res => {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(Buffer.from(FAKE_WAV));
    };
    infoSpy.mockClear();
    warnSpy.mockClear();
  });

  it('returns the audio the voice service made', async () => {
    const res = await appWith().request('/speak', speakRequest({ text: 'Hello there.', voice: 'am_michael' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FAKE_WAV);
    expect(fakeTts.calls).toEqual([
      { path: '/v1/speak', contentType: 'application/json', body: { text: 'Hello there.', voice: 'am_michael' } },
    ]);
  });

  it('leaves the voice to the service when none is named', async () => {
    const res = await appWith().request('/speak', speakRequest({ text: 'Hi.' }));

    expect(res.status).toBe(200);
    expect(fakeTts.calls[0]?.body).toEqual({ text: 'Hi.' });
  });

  it('refuses unauthenticated calls without reaching the voice service', async () => {
    const res = await appWith().request('/speak', speakRequest({ text: 'Hi.' }, null));

    expect(res.status).toBe(401);
    expect(fakeTts.calls).toHaveLength(0);
  });

  it('refuses text over the length cap', async () => {
    const res = await appWith().request('/speak', speakRequest({ text: 'x'.repeat(MAX_SPEAK_TEXT_CHARS + 1) }));

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'text_too_long' } });
    expect(fakeTts.calls).toHaveLength(0);
  });

  it('accepts text exactly at the cap', async () => {
    const res = await appWith().request('/speak', speakRequest({ text: 'x'.repeat(MAX_SPEAK_TEXT_CHARS) }));

    expect(res.status).toBe(200);
  });

  it('rejects empty text', async () => {
    const res = await appWith().request('/speak', speakRequest({ text: '' }));

    expect(res.status).toBe(400);
    expect(fakeTts.calls).toHaveLength(0);
  });

  it('reports unavailable when the voice service is not warm', async () => {
    fakeTts.reply = res => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Model is not warm yet' }));
    };

    const res = await appWith().request('/speak', speakRequest({ text: 'Hi.' }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        message: 'The voice on this computer is not available right now. Try again in a minute.',
        code: 'tts_unavailable',
      },
    });
  });

  it('reports unavailable when the voice service is down', async () => {
    configuration.TTS_URL = 'http://127.0.0.1:9';
    try {
      const res = await appWith().request('/speak', speakRequest({ text: 'Hi.' }));

      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: 'tts_unavailable' } });
    } finally {
      configuration.TTS_URL = fakeTtsUrl;
    }
  });

  it('maps a refused text to a bad request', async () => {
    fakeTts.reply = res => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'text has nothing to say aloud' }));
    };

    const res = await appWith().request('/speak', speakRequest({ text: '```code```' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_text' } });
  });

  it('treats a non-audio answer as a failure', async () => {
    fakeTts.reply = res => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    };

    const res = await appWith().request('/speak', speakRequest({ text: 'Hi.' }));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'tts_error' } });
  });

  it('limits each person separately', async () => {
    const app = appWith(new SpeechRateLimiter({ maxPerWindow: 2 }));

    expect((await app.request('/speak', speakRequest({ text: 'one' }))).status).toBe(200);
    expect((await app.request('/speak', speakRequest({ text: 'two' }))).status).toBe(200);
    const limited = await app.request('/speak', speakRequest({ text: 'three' }));
    const other = await app.request('/speak', speakRequest({ text: 'one' }, 'bob'));

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(other.status).toBe(200);
    expect(fakeTts.calls).toHaveLength(3);
  });

  it('never logs the reply text', async () => {
    await appWith().request('/speak', speakRequest({ text: SECRET_REPLY }));

    const logged = [...infoSpy.mock.calls, ...warnSpy.mock.calls].map(call => JSON.stringify(call)).join(' ');
    expect(logged).toContain('voice speak');
    expect(logged).not.toContain('hunter');
  });
});
