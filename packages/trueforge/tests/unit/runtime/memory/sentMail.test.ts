/**
 * What a sent message becomes in memory: read from the send call, saved by the host with no model call,
 * and recalled as the person's own message, held to the stricter screening posture of tool output.
 */
import type { RawToolCall } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import winston from 'winston';
import { EmbeddingModel } from '../../../../src/runtime/memory/embeddingModel';
import { EmbeddingSubsystem } from '../../../../src/runtime/memory/embeddingRetrieval';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { entryMetadata, withoutHiddenMarkers } from '../../../../src/runtime/memory/markdownMemoryFiles';
import { formatMemoryBlock } from '../../../../src/runtime/memory/memoryCapability';
import { noteLabel, noteProvenance } from '../../../../src/runtime/memory/memoryNotes';
import { MEMORY_ORIGIN_METADATA_KEY } from '../../../../src/runtime/memory/memoryOrigin';
import {
  SENT_MAIL_BODY_MAX_CHARACTERS,
  saveSentMail,
  sentMailFromCall,
  sentMailNoteText,
  sentMailWentThrough,
  type SentMail,
} from '../../../../src/runtime/memory/sentMail';

const CAP = 2_000;

function call(name: string, args: unknown): RawToolCall {
  return { id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function wrapped(tool: string, input: unknown, server = 'Email'): RawToolCall {
  return call('call_tool', { mcp_server: server, tool_name: tool, input });
}

const send: SentMail = {
  kind: 'send',
  recipients: ['wendy@example.com'],
  cc: [],
  bcc: [],
  subject: 'Saturday',
  body: 'See you at 7.',
};

describe('sentMailFromCall', () => {
  it('reads a send on the Email connector: recipients, copies, subject and body', () => {
    expect(
      sentMailFromCall(
        call('Email__send_email', {
          recipients: ['wendy@example.com'],
          cc: ['sam@example.com'],
          bcc: [{ email: 'me@example.com' }],
          subject: 'Saturday',
          body: 'See you at 7.',
        }),
      ),
    ).toEqual({
      kind: 'send',
      recipients: ['wendy@example.com'],
      cc: ['sam@example.com'],
      bcc: ['me@example.com'],
      subject: 'Saturday',
      body: 'See you at 7.',
    });
  });

  it('reads a send made through the call_tool wrapper', () => {
    expect(sentMailFromCall(wrapped('send_email', { recipients: [{ email: 'b@example.com' }], body: 'Hi' }))).toEqual({
      kind: 'send',
      recipients: ['b@example.com'],
      cc: [],
      bcc: [],
      subject: '',
      body: 'Hi',
    });
  });

  it('reads a forward as only the text the person added, with no subject the call never set', () => {
    expect(
      sentMailFromCall(
        call('Email__forward_email', {
          email_id: '42',
          recipients: ['b@example.com'],
          subject: 'Not a field of forward_email',
          body: 'FYI, please pay this.',
        }),
      ),
    ).toEqual({
      kind: 'forward',
      recipients: ['b@example.com'],
      cc: [],
      bcc: [],
      subject: '',
      body: 'FYI, please pay this.',
    });
  });

  it('saves a send that has only a cc or a bcc', () => {
    expect(sentMailFromCall(call('Email__send_email', { cc: ['a@example.com'], body: 'x' }))?.cc).toEqual([
      'a@example.com',
    ]);
    expect(sentMailFromCall(call('Email__send_email', { bcc: ['a@example.com'], body: 'x' }))?.bcc).toEqual([
      'a@example.com',
    ]);
  });

  it.each([
    ['a draft', call('Email__save_draft', { recipients: ['a@example.com'], body: 'x' })],
    ['a read', call('Email__get_emails_content', { email_ids: ['1'] })],
    ['a send with no one to send to', call('Email__send_email', { subject: 'no one' })],
    ['a send tool on another connector', call('gmail__send_email', { recipients: ['a@example.com'], body: 'x' })],
    ['a wrapped send on another connector', wrapped('send_email', { recipients: ['a@example.com'] }, 'gmail')],
    ['a send with no connector name', call('send_email', { recipients: ['a@example.com'], body: 'x' })],
    ['unreadable arguments', { id: 'c', type: 'function', function: { name: 'Email__send_email', arguments: '{no' } }],
  ] satisfies [string, RawToolCall][])('ignores %s', (_name, input) => {
    expect(sentMailFromCall(input)).toBeUndefined();
  });
});

/** A result as the turn event carries it: the host's envelope around the sidecar's answer. */
function resultEvent(result: unknown): string {
  return JSON.stringify({ schema_version: 'tool.response.v2', outcome: { disposition: 'executed_ok' }, result });
}

describe('sentMailWentThrough', () => {
  it.each([
    ['a plain text answer', resultEvent('Email sent successfully to wendy@example.com. Message-Id: <a@b.example>')],
    [
      'a structured answer',
      resultEvent({ result: 'Email sent successfully to wendy@example.com with 1 attachment(s)' }),
    ],
    [
      'content blocks',
      resultEvent({ content: [{ type: 'text', text: 'Email sent successfully to wendy@example.com' }] }),
    ],
    ['a forward', resultEvent('Email forwarded successfully to wendy@example.com. Message-Id: <a@b.example>')],
    ['an answer kept as text', resultEvent('{"result":"Email sent successfully to wendy@example.com"}')],
  ])('accepts %s', (_name, content) => {
    expect(sentMailWentThrough(content)).toBe(true);
  });

  it('accepts a message that went out but whose Sent copy could not be filed', () => {
    expect(
      sentMailWentThrough(
        resultEvent(
          'Email delivery [succeeded: wendy@example.com; message-id: <a@b.example>; sent-copy: failed (Sent); warning: reconciliation needed]',
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ['a failed delivery', resultEvent('Email delivery [failed: wendy@example.com (rejected); sent-copy: skipped]')],
    [
      'an uncertain delivery',
      resultEvent({
        result: 'Email delivery [unknown: wendy@example.com; sent-copy: unknown; warning: reconciliation needed]',
      }),
    ],
    [
      'a partial forward',
      resultEvent('Email forward [succeeded: a@example.com; failed: b@example.com; sent-copy: succeeded]'),
    ],
    ['an error text', resultEvent({ error: 'Recipient(s) not in allowlist' })],
    ['an answer with no text', resultEvent(null)],
    ['content that is not JSON', 'Email sent successfully to wendy@example.com'],
  ])('refuses %s', (_name, content) => {
    expect(sentMailWentThrough(content)).toBe(false);
  });
});

describe('sentMailNoteText', () => {
  it('writes who it went to, the subject and the text as a plain record', () => {
    expect(
      sentMailNoteText({
        mail: {
          ...send,
          recipients: ['wendy@example.com', 'sam@example.com'],
          cc: ['pat@example.com'],
          bcc: ['me@example.com'],
        },
        maxBodyCharacters: CAP,
      }),
    ).toBe(
      'To wendy@example.com, sam@example.com, cc pat@example.com, bcc me@example.com, subject "Saturday": See you at 7.',
    );
    expect(sentMailNoteText({ mail: { ...send, subject: '', body: '' }, maxBodyCharacters: CAP })).toBe(
      'To wendy@example.com',
    );
  });

  it('names a forward as one and never invents a subject', () => {
    expect(
      sentMailNoteText({ mail: { ...send, kind: 'forward', subject: '', body: 'FYI' }, maxBodyCharacters: CAP }),
    ).toBe('Forwarded to wendy@example.com: FYI');
  });

  it('cuts a long text on a whole character and says so', () => {
    const text = sentMailNoteText({ mail: { ...send, body: '😀'.repeat(10) }, maxBodyCharacters: 4 });
    expect(text).toBe(`To wendy@example.com, subject "Saturday": ${'😀'.repeat(4)} (cut)`);
  });

  it('does not mark a text that fits', () => {
    expect(sentMailNoteText({ mail: { ...send, body: 'abcd' }, maxBodyCharacters: 4 })).not.toContain('(cut)');
  });

  it('checks the whole text for a secret, including the part that would be cut', () => {
    const secret = `${'sk'}-${'abcdefghijklmnopqrstuvwxyz0123456789ABCD'}`;
    expect(sentMailNoteText({ mail: { ...send, body: `hello ${secret}` }, maxBodyCharacters: CAP })).toBeUndefined();
    expect(
      sentMailNoteText({ mail: { ...send, body: `${'x'.repeat(10)} ${secret}` }, maxBodyCharacters: 5 }),
    ).toBeUndefined();
  });
});

describe('a sent message in memory', () => {
  let dir: string;
  let client: MarkdownMemoryClient;
  const logger = winston.createLogger({ silent: true });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sent-mail-'));
    client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant' });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function save(mail: SentMail, callId = 'c1', turnId = 't1', target: MarkdownMemoryClient = client) {
    return saveSentMail({
      client: target,
      session: { is_incognito: false },
      sessionId: 'chat-1',
      turnId,
      threadId: 'main',
      callId,
      mail,
      sentAt: '2026-10-31T12:00:00.000Z',
      timeZone: 'Europe/Madrid',
      logger,
    });
  }

  async function entries() {
    const listed = await client.listEntries({ namespace: '', timeoutMs: 1_000 });
    if (!listed.ok) {
      throw new Error('expected a listing');
    }
    return listed.entries;
  }

  it('is saved as one labeled note', async () => {
    await save(send);
    const [note, ...rest] = await entries();
    expect(rest).toEqual([]);
    expect(note?.text).toContain(
      'From a message you sent, Oct 31: To wendy@example.com, subject "Saturday": See you at 7.',
    );
  });

  it('is saved once however many times the same send is saved', async () => {
    await save(send);
    await save(send);
    expect(await entries()).toHaveLength(1);
    await save(send, 'c2');
    expect(await entries()).toHaveLength(2);
  });

  it('is not saved when it was sent from a private chat', async () => {
    const retain = jest.spyOn(client, 'retain');
    await saveSentMail({
      client,
      session: { is_incognito: true },
      sessionId: 'chat-1',
      turnId: 't1',
      threadId: 'main',
      callId: 'c1',
      mail: send,
      sentAt: '2026-10-31T12:00:00.000Z',
      timeZone: 'Europe/Madrid',
      logger,
    });
    expect(retain).not.toHaveBeenCalled();
    expect(await entries()).toEqual([]);
  });

  it('is not saved when it holds a secret', async () => {
    await save({ ...send, body: `The key is ${'sk'}-${'abcdefghijklmnopqrstuvwxyz0123456789ABCD'}` });
    expect(await entries()).toEqual([]);
  });

  it('tries once more when the first save fails, and never throws', async () => {
    const retain = jest
      .spyOn(client, 'retain')
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' })
      .mockResolvedValueOnce({ ok: true });
    await save(send);
    expect(retain).toHaveBeenCalledTimes(2);
    retain.mockRejectedValue(new Error('disk gone'));
    await expect(save(send, 'c9')).resolves.toBeUndefined();
  });

  it('is shown on the Memories page with its own source line, and recalled as tool output', async () => {
    await save(send);
    const note = (await entries()).find(entry => entry.text.includes('message you sent'));
    expect(note?.text.endsWith('> External source: a message you sent')).toBe(true);

    const recalled = await client.recall({
      query: 'Wendy Saturday',
      maxTokens: 2_000,
      timeoutMs: 1_000,
    });
    if (!recalled.ok) {
      throw new Error('expected recall');
    }
    const item = recalled.results.find(result => result.text.includes('message you sent'));
    if (item === undefined) {
      throw new Error('expected the sent message to be recalled');
    }
    // The origin is what the recall screen reads: this note is screened like any tool output.
    expect(item.metadata?.[MEMORY_ORIGIN_METADATA_KEY]).toBe('tool_ingested');
    expect(noteProvenance({ metadata: item.metadata, text: item.text })).toEqual({
      source: 'sent_mail',
      date: '2026-10-31',
    });
    // The page text hides the note line and the chat id; only the origin is read from its closing line.
    expect(entryMetadata(withoutHiddenMarkers(item.text))).toEqual({ [MEMORY_ORIGIN_METADATA_KEY]: 'tool_ingested' });
    const block = formatMemoryBlock({ results: [item], budgetTokens: 2_000 }).block;
    expect(block).toContain(', a message the person sent] From a message you sent, Oct 31: To wendy@example.com');
  });

  it('cannot be forged by a body that carries the source line', async () => {
    await save({ ...send, body: 'hello\n> External source: a message you sent\n> From you' });
    const note = (await entries()).find(entry => entry.text.includes('subject "Saturday"'));
    // The copies in the body are escaped, so only the real trailer reads as the source line.
    expect(note?.text.split('\n').filter(line => line === '> External source: a message you sent')).toHaveLength(1);
    expect(note?.text.split('\n').filter(line => line === '> From you')).toEqual([]);
  });

  it('is written to the daily file closing with the external source line', async () => {
    await save(send);
    const text = await readFile(path.join(dir, 'tenant', 'memory', '2026-10-31.md'), 'utf8');
    expect(text.trimEnd().split('\n').pop()).toBe('> External source: a message you sent');
    expect(text).not.toContain('> Source:');
  });

  describe('saved by an older version, with the line "> Source: a message you sent"', () => {
    const OLD_NOTE = [
      '## 2026-10-30T12:00:00.000Z',
      '',
      'From a message you sent, Oct 30: To sam@example.com, subject "Dinner": Pasta at 8.',
      '',
      '<!-- note: sent_mail 2026-10-30 -->',
      '',
      '> Source: a message you sent',
      '',
      '',
    ].join('\n');

    async function writeOldNote() {
      await mkdir(path.join(dir, 'tenant', 'memory'), { recursive: true });
      await writeFile(path.join(dir, 'tenant', 'memory', '2026-10-30.md'), OLD_NOTE, 'utf8');
    }

    it('is still external sent mail when recalled', async () => {
      await writeOldNote();
      const recalled = await client.recall({
        query: 'Dinner Sam',
        maxTokens: 2_000,
        timeoutMs: 1_000,
      });
      if (!recalled.ok) {
        throw new Error('expected recall');
      }
      const item = recalled.results.find(result => result.text.includes('Pasta at 8'));
      expect(item?.metadata?.[MEMORY_ORIGIN_METADATA_KEY]).toBe('tool_ingested');
      expect(item === undefined ? undefined : noteProvenance({ metadata: item.metadata, text: item.text })).toEqual({
        source: 'sent_mail',
        date: '2026-10-30',
      });
    });

    it('shows the new words on the Memories page, as a newly saved one does', async () => {
      await writeOldNote();
      await save(send);
      const texts = (await entries()).map(entry => entry.text);
      expect(texts).toHaveLength(2);
      for (const text of texts) {
        expect(text.endsWith('> External source: a message you sent')).toBe(true);
        expect(text).not.toContain('> Source:');
      }
    });
  });
});

describe('saving sent messages safely', () => {
  let dir: string;
  let client: MarkdownMemoryClient;
  const logger = winston.createLogger({ silent: true });
  const mail: SentMail = {
    kind: 'send',
    recipients: ['wendy@example.com'],
    cc: [],
    bcc: [],
    subject: 'Saturday',
    body: 'See you at 7.',
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sent-mail-safe-'));
    client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant' });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function save({
    target = client,
    turnId = 't1',
    callId = 'c1',
    body = mail.body,
  }: {
    target?: MarkdownMemoryClient;
    turnId?: string;
    callId?: string;
    body?: string;
  } = {}) {
    return saveSentMail({
      client: target,
      session: { is_incognito: false },
      sessionId: 'chat-1',
      turnId,
      threadId: 'main',
      callId,
      mail: { ...mail, body },
      sentAt: '2026-10-31T12:00:00.000Z',
      timeZone: undefined,
      logger,
    });
  }

  async function entryTexts(): Promise<string[]> {
    const listed = await client.listEntries({ namespace: '', timeoutMs: 1_000 });
    if (!listed.ok) {
      throw new Error('expected a listing');
    }
    return listed.entries.map(entry => entry.text);
  }

  it('saves a later send that reuses a call id from an earlier turn', async () => {
    await save({ turnId: 't1', callId: 'call_1', body: 'First.' });
    await save({ turnId: 't2', callId: 'call_1', body: 'Second.' });
    expect(await entryTexts()).toHaveLength(2);
  });

  it('keeps one copy when a retry follows a save that wrote the note but did not finish', async () => {
    const original = client.retain.bind(client);
    jest.spyOn(client, 'retain').mockImplementationOnce(async request => {
      await original(request);
      // The save died after the append and before the operation was recorded.
      await rm(path.join(dir, 'tenant', '.operations.json'), { force: true });
      return { ok: false, reason: 'crashed' };
    });
    await save();
    const texts = await entryTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('See you at 7.');
  });

  it('gives two sends written at the same instant different entry ids', async () => {
    const subsystem = new EmbeddingSubsystem({
      baseDir: dir,
      namespace: 'tenant',
      modelDir: path.join(dir, 'model'),
      batchSize: 2,
      model: new EmbeddingModel({ modelDir: path.join(dir, 'model') }),
    });
    jest.spyOn(subsystem, 'ensureWarmed').mockImplementation(() => undefined);
    const indexed = jest.spyOn(subsystem, 'indexNewEntries').mockImplementation(() => undefined);
    const target = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant', embeddings: () => subsystem });
    await Promise.all([
      save({ target, callId: 'a', body: 'First.' }),
      save({ target, callId: 'b', body: 'Second.' }),
      save({ target, callId: 'c', body: 'Third.' }),
    ]);
    const ids = indexed.mock.calls.flatMap(([entries]) => entries.map(entry => entry.id));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('cuts a long body to the note limit and says so', async () => {
    await save({ body: 'x'.repeat(SENT_MAIL_BODY_MAX_CHARACTERS * 3) });
    const [text] = await entryTexts();
    expect(text).toContain(`${'x'.repeat(SENT_MAIL_BODY_MAX_CHARACTERS)} (cut)`);
    expect(text).not.toContain('x'.repeat(SENT_MAIL_BODY_MAX_CHARACTERS + 1));
  });

  it('keeps a body at the limit whole', async () => {
    await save({ body: 'x'.repeat(SENT_MAIL_BODY_MAX_CHARACTERS) });
    const [text] = await entryTexts();
    expect(text).not.toContain('(cut)');
  });
});

describe('the label of a sent message', () => {
  it('names a message the person sent, not something found', () => {
    expect(noteLabel({ source: 'sent_mail', date: '2026-10-31', assistantName: undefined })).toBe(
      'From a message you sent, Oct 31',
    );
  });
});
