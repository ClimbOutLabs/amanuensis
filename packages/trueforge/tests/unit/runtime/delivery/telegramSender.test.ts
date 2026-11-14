import { createTelegramSender, telegramDeliveryText } from '../../../../src/runtime/delivery/telegramSender';
import { createTelegramService } from '../../../../src/runtime/telegram/telegramService';
import type { Delivery } from '../../../../src/schemas/deliveries';
import {
  fakePairedConnection,
  FakeTelegramClient,
  fakeTelegramConnection,
  immediateQueue,
  InMemoryTelegramStore,
} from '../../../fixtures/telegramFakes';

function delivery(overrides: Partial<Pick<Delivery, 'level'>> = {}): Delivery {
  const base: Delivery = {
    id: 'd1',
    kind: 'reminder',
    level: 'nudge',
    text: 'Time for the evening pills.',
    reason: 'You asked to be reminded at 9 pm.',
    link: { type: 'chat', session_id: 's1' },
    created_at: '2026-11-06T10:00:00.000Z',
    seen_at: null,
    attempts: [],
  };
  return { ...base, ...overrides };
}

function harness(paired: boolean) {
  const store = new InMemoryTelegramStore();
  store.connection = paired ? fakePairedConnection() : fakeTelegramConnection();
  const client = new FakeTelegramClient();
  const service = createTelegramService({ store, publicBaseUrl: 'http://localhost', createClient: () => client });
  const sender = createTelegramSender({ store, service, queue: immediateQueue });
  return { store, client, sender };
}

describe('telegram delivery sender', () => {
  it('sends a nudge to the paired chat and records the attempt', async () => {
    const { client, sender } = harness(true);
    const attempts = await sender.send({
      delivery: delivery(),
      tenant_id: 'local',
      created_by: 'test-user',
      test: false,
    });
    expect(client.sent).toEqual([{ chat_id: '777', text: 'Time for the evening pills.', inline_buttons: undefined }]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ channel: 'telegram', outcome: 'sent', target: '777' });
  });

  it.each(['note', 'call'] as const)(
    'sends nothing at %s level: a note stays in the app, and a call reaches Telegram only as its fallback nudge',
    async level => {
      const { client, sender } = harness(true);
      const attempts = await sender.send({
        delivery: delivery({ level }),
        tenant_id: 'local',
        created_by: 'test-user',
        test: false,
      });
      expect(attempts).toEqual([]);
      expect(client.sent).toHaveLength(0);
    },
  );

  it('makes no attempt while nobody is paired', async () => {
    const { client, sender } = harness(false);
    const attempts = await sender.send({
      delivery: delivery(),
      tenant_id: 'local',
      created_by: 'test-user',
      test: false,
    });
    expect(attempts).toEqual([]);
    expect(client.sent).toHaveLength(0);
  });

  it('records a failed attempt when the send fails, and never throws', async () => {
    const { client, sender } = harness(true);
    client.failSend = true;
    const attempts = await sender.send({
      delivery: delivery(),
      tenant_id: 'local',
      created_by: 'test-user',
      test: false,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ channel: 'telegram', outcome: 'failed', target: '777' });
  });

  it('points an approval delivery at the app, where the card lives', () => {
    const approval: Delivery = {
      id: 'd2',
      kind: 'approval_waiting',
      level: 'call',
      text: 'A send is waiting for your ok.',
      reason: 'An action was held for your answer.',
      link: { type: 'approval', session_id: 's1', approval_id: 'a1' },
      created_at: '2026-11-06T10:00:00.000Z',
      seen_at: null,
      attempts: [],
    };
    expect(telegramDeliveryText(approval)).toBe('A send is waiting for your ok.\nOpen Aman to answer it.');
    expect(telegramDeliveryText(delivery())).toBe('Time for the evening pills.');
  });
});
