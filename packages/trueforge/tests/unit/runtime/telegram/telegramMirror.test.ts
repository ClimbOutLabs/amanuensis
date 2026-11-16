import winston from 'winston';

import { TELEGRAM_METADATA_KEY } from '../../../../src/runtime/telegram/telegramChannel';
import { queueAppTurnForTelegram } from '../../../../src/runtime/telegram/telegramMirror';
import { fakePairedConnection, fakeTelegramConnection, InMemoryTelegramStore } from '../../../fixtures/telegramFakes';

const logger = winston.createLogger({ silent: true });
const OWNER = 'test-user';

function chat(params: { telegram: boolean; owner?: string }): Parameters<typeof queueAppTurnForTelegram>[0]['session'] {
  return {
    tenant_id: 'local',
    session_id: 'session-1',
    created_by_subject: {
      subject_id: params.owner ?? OWNER,
      subject_type: 'owner',
      subject_display_name: 'Test User',
    },
    metadata: params.telegram ? { [TELEGRAM_METADATA_KEY]: 'true' } : {},
  };
}

describe('copying a message typed in the app to Telegram', () => {
  it("owes Telegram the turn when it is the paired person's Telegram chat", async () => {
    const store = new InMemoryTelegramStore();
    store.connection = fakePairedConnection();
    await queueAppTurnForTelegram({
      store,
      session: chat({ telegram: true }),
      subjectId: OWNER,
      turnId: 'turn-1',
      logger,
    });
    expect(store.pendingReplies).toMatchObject([{ turn_id: 'turn-1', chat_id: '777', origin: 'app' }]);
  });

  it('never copies any other chat', async () => {
    const store = new InMemoryTelegramStore();
    store.connection = fakePairedConnection();
    await queueAppTurnForTelegram({
      store,
      session: chat({ telegram: false }),
      subjectId: OWNER,
      turnId: 'turn-1',
      logger,
    });
    expect(store.pendingReplies).toEqual([]);
  });

  it('never copies a message someone else typed, or one sent before the bot is paired', async () => {
    const store = new InMemoryTelegramStore();
    store.connection = fakePairedConnection();
    await queueAppTurnForTelegram({
      store,
      session: chat({ telegram: true, owner: 'someone-else' }),
      subjectId: 'someone-else',
      turnId: 'turn-1',
      logger,
    });
    store.connection = fakeTelegramConnection();
    await queueAppTurnForTelegram({
      store,
      session: chat({ telegram: true }),
      subjectId: OWNER,
      turnId: 'turn-2',
      logger,
    });
    expect(store.pendingReplies).toEqual([]);
  });
});
