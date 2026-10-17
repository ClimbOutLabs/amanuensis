import { Writable } from 'node:stream';
import winston, { type Logger } from 'winston';
import { createServerLogger } from '../../src/logger';

const PLANTED = {
  apiKey: 'sk-test-plantedApiKey000000000000',
  bearer: 'plantedBearerToken1111111111111111',
  cookie: 'planted-session-cookie-2222',
  oauthCode: 'plantedOAuthCode3333',
  password: 'planted-Passw0rd-4444',
  emailBody: 'Planted email body about the quarterly plan 5555',
  eventDescription: 'Planted calendar notes for the offsite 6666',
  urlPassword: 'plantedDbPass7777',
  queryToken: 'plantedQueryToken8888',
  basic: 'cGxhbnRlZDpiYXNpYzk5OTk=',
  secondCookie: 'planted-second-cookie-1010',
  verifier: 'plantedPkceVerifier1212',
};

function captureLogger(standalone: boolean): { logger: Logger; output: () => string } {
  const logger = createServerLogger({ level: 'debug', standalone, version: '0.0.0-test' });
  logger.clear();
  const chunks: string[] = [];
  logger.add(
    new winston.transports.Stream({
      stream: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      }),
    }),
  );
  return { logger, output: () => chunks.join('') };
}

function expectNoPlantedSecret(output: string): void {
  for (const value of Object.values(PLANTED)) {
    expect(output).not.toContain(value);
  }
}

describe.each([
  ['json', false],
  ['standalone', true],
])('server logger redaction (%s)', (_name, standalone) => {
  it('logs a request carrying planted secrets without any of them', () => {
    const { logger, output } = captureLogger(standalone);

    logger.info('request', {
      method: 'POST',
      url: `/api/v1/oauth/callback?code=${PLANTED.oauthCode}&state=abc&token=${PLANTED.queryToken}`,
      headers: {
        Authorization: `Bearer ${PLANTED.bearer}`,
        Cookie: `session=${PLANTED.cookie}`,
        'x-api-key': PLANTED.apiKey,
      },
      body: { email: 'owner@example.test', password: PLANTED.password },
      message_body: { body: PLANTED.emailBody },
      event: { summary: 'Offsite', description: PLANTED.eventDescription },
      database: `postgres://app:${PLANTED.urlPassword}@db.example.test:5432/app`,
      max_tokens: 1024,
    });
    logger.warn(`upstream rejected Authorization: Basic ${PLANTED.basic} with key ${PLANTED.apiKey}`);
    logger.warn(`proxy saw Cookie: session=${PLANTED.cookie}; prefs=${PLANTED.secondCookie}`);

    const text = output();
    expectNoPlantedSecret(text);
    expect(text).toContain('[redacted]');
    expect(text).toContain('state=abc');
    expect(text).toContain('1024');
  });

  it('redacts secrets carried by a logged error, its stack and its cause', () => {
    const { logger, output } = captureLogger(standalone);
    const cause = new Error(`fetch failed for https://api.example.test/v1?api_key=${PLANTED.apiKey}`);
    const error = new Error(
      `token exchange failed: {"access_token":"${PLANTED.bearer}","password":"${PLANTED.password}"}`,
      {
        cause,
      },
    );

    logger.error(error);
    logger.error('Unhandled error', { error, headers: new Headers({ cookie: `sid=${PLANTED.cookie}` }) });
    // A malformed cookie makes JSON.parse quote a window of the value around the fault.
    let parseMessage = '';
    try {
      JSON.parse(`{"state":"abc","code_verifier":${PLANTED.verifier}}`);
    } catch (parseError) {
      parseMessage = parseError instanceof Error ? parseError.message : String(parseError);
    }
    const verifierPrefix = PLANTED.verifier.slice(0, 10);
    expect(parseMessage).toContain(verifierPrefix);
    logger.warn('oauth_state cookie is not valid JSON', { error: parseMessage });

    const text = output();
    expectNoPlantedSecret(text);
    expect(text).not.toContain(verifierPrefix);
    expect(text).toContain('token exchange failed');
  });
});
