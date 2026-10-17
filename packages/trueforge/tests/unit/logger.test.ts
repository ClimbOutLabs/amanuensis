import { Writable } from 'node:stream';
import winston, { type Logger } from 'winston';
import { createExportScrubber, REDACTED } from '../../src/dataExport/secretScrub';
import { createServerLogger } from '../../src/logger';

const PLANTED = {
  providerKey: 'sk-test-plantedApiKey000000000000',
  bearer: 'plantedBearerToken1111111111111111',
  cookie: 'planted-session-cookie-2222',
  oauthCode: 'plantedOAuthCode3333',
  loginPass: 'planted-Passw0rd-4444',
  emailBody: 'Planted email body about the quarterly plan 5555',
  eventDescription: 'Planted calendar notes for the offsite 6666',
  urlPass: 'plantedDbPass7777',
  queryCredential: 'plantedQueryToken8888',
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
      url: `/api/v1/oauth/callback?code=${PLANTED.oauthCode}&state=abc&token=${PLANTED.queryCredential}`,
      headers: {
        Authorization: `Bearer ${PLANTED.bearer}`,
        Cookie: `session=${PLANTED.cookie}`,
        'x-api-key': PLANTED.providerKey,
      },
      body: { email: 'owner@example.test', password: PLANTED.loginPass },
      message_body: { body: PLANTED.emailBody },
      event: { summary: 'Offsite', description: PLANTED.eventDescription },
      database: `postgres://app:${PLANTED.urlPass}@db.example.test:5432/app`,
      max_tokens: 1024,
    });
    logger.warn(`upstream rejected Authorization: Basic ${PLANTED.basic} with key ${PLANTED.providerKey}`);
    logger.warn(`proxy saw Cookie: session=${PLANTED.cookie}; prefs=${PLANTED.secondCookie}`);

    const text = output();
    expectNoPlantedSecret(text);
    expect(text).toContain('[redacted]');
    expect(text).toContain('state=abc');
    expect(text).toContain('1024');
  });

  it('redacts credential and content fields at the top level of an entry', () => {
    const { logger, output } = captureLogger(standalone);
    logger.info('top level', {
      password: PLANTED.loginPass,
      apiKey: PLANTED.providerKey,
      body: PLANTED.emailBody,
      refresh_token: PLANTED.bearer,
      max_tokens: 1024,
    });

    const text = output();
    expectNoPlantedSecret(text);
    expect(text).toContain('top level');
    expect(text).toContain('1024');
  });

  it('redacts a credential field set on a child logger', () => {
    const { logger, output } = captureLogger(standalone);
    logger.child({ authorization: `Bearer ${PLANTED.bearer}`, cookie: PLANTED.cookie }).warn('child entry');

    const text = output();
    expectNoPlantedSecret(text);
    expect(text).toContain('child entry');
  });

  it('redacts a credential property carried by a logged error', () => {
    const { logger, output } = captureLogger(standalone);
    logger.error(Object.assign(new Error('login failed'), { password: PLANTED.loginPass }));

    const text = output();
    expectNoPlantedSecret(text);
    expect(text).toContain('login failed');
  });

  it('redacts secrets carried by a logged error, its stack and its cause', () => {
    const { logger, output } = captureLogger(standalone);
    const cause = new Error(`fetch failed for https://api.example.test/v1?api_key=${PLANTED.providerKey}`);
    const error = new Error(
      `token exchange failed: {"access_token":"${PLANTED.bearer}","password":"${PLANTED.loginPass}"}`,
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

it('shares the credential word list with the data export', () => {
  const fields = { cookie: PLANTED.cookie, code_verifier: PLANTED.verifier, client_secret: PLANTED.urlPass };
  expect(createExportScrubber([]).json(fields)).toEqual({
    cookie: REDACTED,
    code_verifier: REDACTED,
    client_secret: REDACTED,
  });

  const { logger, output } = captureLogger(false);
  logger.info('shared rule', fields);
  expectNoPlantedSecret(output());
});

it('redacts credential fields written into free text by any credential name', () => {
  // Standalone output prints the message unescaped, so the kept field reads as written.
  const { logger, output } = captureLogger(true);
  logger.warn(`upstream said {"private_key":"${PLANTED.loginPass}","max_tokens":1024}`);
  logger.warn(`retrying /v1/connect?client_assertion=x&session_cookie=${PLANTED.cookie}&limit=5`);

  const text = output();
  expectNoPlantedSecret(text);
  expect(text).toContain('"max_tokens":1024');
  expect(text).toContain('limit=5');
});

describe.each([
  ['json', false],
  ['standalone', true],
])('credential words anywhere in a field name (%s)', (_name, standalone) => {
  const names = [
    'secret_key',
    'aws_secret_access_key',
    'token_value',
    'password_hash',
    'clientSecretValue',
    'encryption_key',
  ];
  const planted = (name: string): string => `planted-${name.length}-value-${name.slice(0, 3)}x`;
  const fields = Object.fromEntries(names.map(name => [name, planted(name)]));

  function expectHidden(text: string): void {
    for (const name of names) {
      expect(text).not.toContain(planted(name));
    }
  }

  it('redacts them nested, at the top level and in JSON free text', () => {
    const { logger, output } = captureLogger(standalone);
    logger.info('nested', { cfg: fields });
    logger.info('top level', fields);
    logger.warn(`upstream said ${JSON.stringify(fields)}`);
    expectHidden(output());
  });

  it('keeps counts and flags under such names', () => {
    const { logger, output } = captureLogger(standalone);
    logger.info('usage', { max_tokens: 4096, hasToken: true, cfg: { apiKeyCount: 7 } });
    const text = output();
    expect(text).toContain('4096');
    expect(text).toContain('"hasToken":true');
    expect(text).toContain('"apiKeyCount":7');
  });
});
