import { describe, expect, it } from 'vitest';

import { createTelegramSetupApi } from '@/plugins/trueforge-agent-server-adapter/catalogs/telegramSetup.js';

const CANARY = 'CANARY-BOT-TOKEN-9f2c';

const STATUS_BODY = {
  data: {
    available: true,
    state: 'awaiting_pairing',
    bot_name: 'House Bot',
    bot_username: 'house_bot',
    pairing_name: 'Sam S',
  },
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Seen = {
  url: string;
  method: string;
  body: string | undefined;
  credentials: string | undefined;
};

function apiWith(handler: (seen: Seen) => Promise<Response>) {
  const seen: Seen[] = [];
  const api = createTelegramSetupApi({
    baseUrl: 'http://harness.test',
    fetch: async (input, init) => {
      const entry: Seen = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
        credentials: init?.credentials,
      };
      seen.push(entry);
      return handler(entry);
    },
  });
  return { api, seen };
}

describe('createTelegramSetupApi', () => {
  it('reads the status and maps it to camelCase', async () => {
    const { api, seen } = apiWith(async () => reply(STATUS_BODY));
    const status = await api.getTelegramStatus();
    expect(seen[0]?.url).toBe('http://harness.test/api/v1/user/settings/telegram/status');
    expect(seen[0]?.credentials).toBe('same-origin');
    expect(status).toEqual({
      available: true,
      state: 'awaiting_pairing',
      botName: 'House Bot',
      botUsername: 'house_bot',
      pairingName: 'Sam S',
    });
  });

  it('sends the token once, on connect, and never asks for it back', async () => {
    const { api, seen } = apiWith(async () => reply(STATUS_BODY));
    await api.connectTelegram({ token: CANARY });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('http://harness.test/api/v1/user/settings/telegram');
    expect(seen[0]?.body).toBe(JSON.stringify({ token: CANARY }));
    const status = await api.getTelegramStatus();
    expect(JSON.stringify(status)).not.toContain(CANARY);
  });

  it('confirms a pairing against the confirm path', async () => {
    const { api, seen } = apiWith(async () =>
      reply({ data: { ...STATUS_BODY.data, state: 'connected', pairing_name: null } }),
    );
    const status = await api.confirmTelegramPairing({ code: '123456' });
    expect(seen[0]?.url).toBe('http://harness.test/api/v1/user/settings/telegram/confirm');
    expect(seen[0]?.body).toBe(JSON.stringify({ code: '123456' }));
    expect(status.state).toBe('connected');
  });

  it('cancels a waiting pairing against the cancel path', async () => {
    const { api, seen } = apiWith(async () => reply({ data: { ...STATUS_BODY.data, pairing_name: null } }));
    const status = await api.cancelTelegramPairing();
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('http://harness.test/api/v1/user/settings/telegram/cancel-pairing');
    expect(status.pairingName).toBeNull();
  });

  it('removes with a JSON body, so the call is not mistaken for a cross-site one', async () => {
    const { api, seen } = apiWith(async () =>
      reply({
        data: { available: true, state: 'not_connected', bot_name: null, bot_username: null, pairing_name: null },
      }),
    );
    const status = await api.removeTelegram();
    expect(seen[0]?.method).toBe('DELETE');
    expect(seen[0]?.body).toBe('{}');
    expect(status.state).toBe('not_connected');
  });

  it('surfaces the server refusal line word for word', async () => {
    const { api } = apiWith(async () =>
      reply(
        {
          error: {
            message: 'Telegram refused that token. Copy the token from BotFather again and paste it here.',
            type: 'telegram_refused',
          },
        },
        400,
      ),
    );
    await expect(api.connectTelegram({ token: CANARY })).rejects.toThrow(
      'Telegram refused that token. Copy the token from BotFather again and paste it here.',
    );
  });
});
