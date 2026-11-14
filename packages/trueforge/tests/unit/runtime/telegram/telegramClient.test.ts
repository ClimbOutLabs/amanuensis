import {
  createTelegramClient,
  splitTelegramText,
  TelegramApiError,
} from '../../../../src/runtime/telegram/telegramClient';

type SeenRequest = { url: string; body: unknown };

function clientWith(handler: (url: string, body: unknown) => Promise<Response>) {
  const seen: SeenRequest[] = [];
  const client = createTelegramClient({
    token: '123:secret-token',
    fetchImpl: async (input, init) => {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      seen.push({ url: String(input), body });
      return handler(String(input), body);
    },
  });
  return { client, seen };
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function refused(status: number, description: string, parameters?: { retry_after?: number }): Response {
  return new Response(
    JSON.stringify({ ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

describe('telegram client', () => {
  it('reads the bot identity', async () => {
    const { client, seen } = clientWith(async () => ok({ id: 42, first_name: 'My Bot', username: 'my_bot' }));
    const me = await client.getMe();
    expect(me).toEqual({ id: '42', name: 'My Bot', username: 'my_bot' });
    expect(seen[0]?.url).toBe('https://api.telegram.org/bot123:secret-token/getMe');
  });

  it('long polls with the stored offset', async () => {
    const { client, seen } = clientWith(async () => ok([]));
    await client.getUpdates({ offset: '9' });
    expect(seen[0]?.body).toEqual({ offset: 9, timeout: 25, allowed_updates: ['message', 'callback_query'] });
  });

  it('sets the webhook with a single connection', async () => {
    const { client, seen } = clientWith(async () => ok(true));
    await client.setWebhook({ url: 'https://aman.example.com/api/telegram/webhook', secret_token: 'test-secret' });
    expect(seen[0]?.url).toBe('https://api.telegram.org/bot123:secret-token/setWebhook');
    expect(seen[0]?.body).toEqual({
      url: 'https://aman.example.com/api/telegram/webhook',
      secret_token: 'test-secret',
      max_connections: 1,
      allowed_updates: ['message', 'callback_query'],
    });
  });

  it('skips one update in a shape it cannot read and keeps the rest of the batch', async () => {
    const good = (update_id: number) => ({
      update_id,
      message: {
        message_id: update_id,
        date: 1762000000,
        chat: { id: 777, type: 'private' },
        from: { id: 555, first_name: 'Person' },
        text: 'hi',
      },
    });
    // A message whose id arrives as words instead of a number: a shape this build cannot read.
    const misfit = {
      update_id: 10,
      message: { message_id: 'ten', date: 1762000000, chat: { id: 777, type: 'private' }, text: 'hi' },
    };
    const { client } = clientWith(async () => ok([good(9), misfit, good(11)]));
    const skipped: { update_id: number | null }[] = [];
    const updates = await client.getUpdates({
      offset: '9',
      onSkippedUpdate: entry => {
        skipped.push(entry);
      },
    });
    expect(updates.map(entry => entry.update_id)).toEqual([9, 10, 11]);
    // The skipped update travels bare, carrying only its id, so the stored offset moves past it.
    expect(updates[1]).toEqual({ update_id: 10 });
    expect(skipped).toEqual([{ update_id: 10 }]);
  });

  it('skips an update whose id cannot be read at all and still returns the ones after it', async () => {
    const good = {
      update_id: 11,
      message: {
        message_id: 11,
        date: 1762000000,
        chat: { id: 777, type: 'private' },
        from: { id: 555, first_name: 'Person' },
        text: 'hi',
      },
    };
    const { client } = clientWith(async () => ok([{ something_else: true }, good]));
    const skipped: { update_id: number | null }[] = [];
    const updates = await client.getUpdates({
      offset: null,
      onSkippedUpdate: entry => {
        skipped.push(entry);
      },
    });
    expect(updates.map(entry => entry.update_id)).toEqual([11]);
    expect(skipped).toEqual([{ update_id: null }]);
  });

  it('still fails the call when the answer itself is not a list of updates', async () => {
    const { client } = clientWith(async () => ok({ not: 'a list' }));
    const error: unknown = await client.getUpdates({ offset: null }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
  });

  it('sends a message with an inline keyboard when buttons are given', async () => {
    const { client, seen } = clientWith(async () => ok({ message_id: 7 }));
    const sent = await client.sendMessage({
      chat_id: '777',
      text: 'Approve this?',
      inline_buttons: [[{ text: 'Approve', callback_data: 'tg:a:1' }]],
    });
    expect(sent.message_id).toBe(7);
    expect(seen[0]?.body).toEqual({
      chat_id: 777,
      text: 'Approve this?',
      reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: 'tg:a:1' }]] },
    });
  });

  it('maps a refused call to an error that never carries the token', async () => {
    const { client } = clientWith(async () => refused(401, 'Unauthorized'));
    const error: unknown = await client.getMe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    if (error instanceof TelegramApiError) {
      expect(error.refused).toBe(true);
      expect(error.message).toContain('Unauthorized');
      expect(error.message).not.toContain('secret-token');
    }
  });

  it('carries the retry delay Telegram asks for on a 429', async () => {
    const { client } = clientWith(async () => refused(429, 'Too Many Requests', { retry_after: 3 }));
    const error: unknown = await client.sendMessage({ chat_id: '1', text: 'hi' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    if (error instanceof TelegramApiError) {
      expect(error.retryAfterSeconds).toBe(3);
      expect(error.refused).toBe(true);
    }
  });

  it('downloads a file in two steps', async () => {
    const { client } = clientWith(async url => {
      if (url.endsWith('/getFile')) {
        return ok({ file_path: 'photos/file_1.jpg', file_size: 4 });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    });
    const bytes = await client.downloadFile({ file_id: 'file-id' });
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });
});

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('splitTelegramText', () => {
  it('keeps short text in one piece', () => {
    expect(splitTelegramText('hello')).toEqual(['hello']);
  });

  it('splits long text and never exceeds the limit', () => {
    const text = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
    const parts = splitTelegramText(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.length <= 4096)).toBe(true);
    expect(parts.join('')).toContain('b'.repeat(100));
  });

  it('never cuts an emoji in half at the hard cut, and loses no text', () => {
    // The emoji's two halves straddle the 4096 cut exactly: a naive cut leaves the first
    // piece ending on half an emoji, which Telegram refuses, losing it and the rest.
    const text = `${'a'.repeat(4095)}😀${'b'.repeat(500)}`;
    const parts = splitTelegramText(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.length <= 4096)).toBe(true);
    expect(parts.every(part => !hasLoneSurrogate(part))).toBe(true);
    expect(parts.join('')).toBe(text);
  });
});
