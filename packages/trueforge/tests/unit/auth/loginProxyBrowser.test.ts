import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createLoginProxy } from '../../../src/auth/loginProxy';
import { createRequestGuardMiddleware } from '../../../src/auth/requestGuard';

const PASSWORD = 'correct horse';
const FORM_HTML = (note: string) =>
  `<html><body><p id="note">${note}</p><form method="post" action="/dex/auth/local/login?state=s">` +
  '<input name="login" value="owner@example.com"><input name="password" type="password"><button>Sign in</button></form></body></html>';

function listen(server: Server): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('The test server has no port.');
      }
      resolve(address.port);
    });
  });
}

/** A stand-in sign-in service: shows the form, redirects on the right password, shows the form again otherwise. */
function signInService(passwordPosts: string[]): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/dex/auth/local/login') {
      let body = '';
      req.on('data', chunk => (body += String(chunk)));
      req.on('end', () => {
        const password = new URLSearchParams(body).get('password') ?? '';
        passwordPosts.push(password);
        if (password === PASSWORD) {
          res.writeHead(303, { location: `http://${req.headers.host ?? ''}/dex/approval` }).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' }).end(FORM_HTML('Invalid password'));
      });
      return;
    }
    if (url.pathname === '/dex/approval') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body id="done">Signed in</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(FORM_HTML(''));
  });
}

describe('signing in through the proxied page in a real browser', () => {
  let browser: Browser;
  let upstream: Server;
  let appServer: ReturnType<typeof serve>;
  let origin: string;
  let passwordPosts: string[];

  beforeAll(async () => {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
    passwordPosts = [];
    upstream = signInService(passwordPosts);
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const appPort = await listen(probe);
    await new Promise(resolve => probe.close(resolve));
    origin = `http://127.0.0.1:${String(appPort)}`;
    const app = new Hono();
    app.use(
      '*',
      createRequestGuardMiddleware({
        port: appPort,
        publicBaseUrl: origin,
        allowedOrigins: [origin],
      }),
    );
    app.all(
      '/dex/*',
      createLoginProxy({ issuerUrl: `http://127.0.0.1:${String(upstreamPort)}/dex`, allowedOrigins: [origin] }),
    );
    appServer = serve({ fetch: app.fetch, port: appPort, hostname: '127.0.0.1' });
  });

  afterAll(async () => {
    await browser.close();
    appServer.close();
    upstream.close();
  });

  async function submit({ page, password }: { page: Page; password: string }): Promise<number> {
    await page.fill('input[name=password]', password);
    const [response] = await Promise.all([
      page.waitForResponse(r => r.request().method() === 'POST'),
      page.click('button'),
    ]);
    return response.status();
  }

  it('sends the page URL as a same-origin referrer only and accepts the correct password', async () => {
    const page = await browser.newPage();
    const posted: Record<string, string>[] = [];
    page.on('request', r => {
      if (r.method() === 'POST') posted.push(r.headers());
    });
    const pageResponse = await page.goto(`${origin}/dex/auth?client_id=c`);
    const status = await submit({ page, password: PASSWORD });
    expect(pageResponse?.headers()['referrer-policy']).toBe('same-origin');
    expect(posted[0]?.origin).toBe(origin);
    expect(status).toBe(303);
    await page.waitForSelector('#done');
    await page.close();
  });

  it('still counts wrong passwords in the browser and stops answering after the limit', async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/dex/auth?client_id=c`);
    passwordPosts.length = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push(await submit({ page, password: `wrong-${String(i)}` }));
      if (statuses.at(-1) === 429) break;
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.at(-1)).toBe(429);
    expect(passwordPosts.length).toBeLessThanOrEqual(5);
    await page.close();
  });
});
