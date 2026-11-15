/** A voice line can only be opened for a chat the caller owns, decided by the real sessions route. */
import { z } from '@hono/zod-openapi';

import configuration from '../../../src/config';
import { voiceTickets } from '../../../src/voice/voiceTickets';
import { MODEL_FQN, startOwnershipServer, type OwnershipServer } from '../../fixtures/ownershipServer';

jest.mock('../../../src/voice/sttAvailability', () => ({
  ...jest.requireActual('../../../src/voice/sttAvailability'),
  isVoiceAvailable: () => true,
}));
jest.mock('../../../src/voice/ttsClient', () => ({
  ...jest.requireActual('../../../src/voice/ttsClient'),
  probeTtsHealth: () => Promise.resolve(true),
}));
jest.mock('../../../src/voice/voiceSocket', () => ({
  ...jest.requireActual('../../../src/voice/voiceSocket'),
  readyVadModel: () => Promise.resolve(new Uint8Array(0)),
}));

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const TIMEOUT_MS = 60_000;

describe('POST /api/v1/voice/connect on the real server', () => {
  let server: OwnershipServer | undefined;
  let aliceChat = '';

  function live(): OwnershipServer {
    if (server === undefined) {
      throw new Error('server not started');
    }
    return server;
  }

  const connect = ({ user, sessionId }: { user: string; sessionId: string }) =>
    live().request({
      user,
      path: '/api/v1/voice/connect',
      method: 'POST',
      json: { session_id: sessionId },
      // The replay inside the server sees only the headers voice mode forwards.
      headers: { authorization: `Test ${user}` },
    });

  beforeAll(async () => {
    configuration.TTS_ENABLED = true;
    server = await startOwnershipServer('sqlite');
    const created = await live().request({
      user: ALICE,
      path: '/api/v1/sessions',
      method: 'POST',
      json: { agent: { spec: { model: { name: MODEL_FQN }, instructions: 'Be brief.' } } },
    });
    aliceChat = z.object({ data: z.object({ id: z.string() }).loose() }).parse(await created.json()).data.id;
  }, TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
  }, TIMEOUT_MS);

  it('gives the owner a ticket bound to their chat', async () => {
    const response = await connect({ user: ALICE, sessionId: aliceChat });
    expect(response.status).toBe(200);
    const { data } = z.object({ data: z.object({ ticket: z.string() }) }).parse(await response.json());
    expect(voiceTickets.redeem(data.ticket)).toMatchObject({ subjectId: ALICE, sessionId: aliceChat });
  });

  it("gives someone else no ticket for another person's chat", async () => {
    const response = await connect({ user: BOB, sessionId: aliceChat });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('ticket');
  });
});
