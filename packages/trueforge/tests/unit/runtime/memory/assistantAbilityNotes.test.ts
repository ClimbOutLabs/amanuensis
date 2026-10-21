import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripAssistantAbilityNotes } from '../../../../src/runtime/memory/assistantAbilityNotes';
import { HindsightClient } from '../../../../src/runtime/memory/hindsightClient';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { buildRetainItem } from '../../../../src/runtime/memory/memoryRetain';

describe('stripAssistantAbilityNotes', () => {
  it.each([
    "I can't read email.",
    "I couldn't open your calendar.",
    'I am unable to check your email right now.',
    "I'm having trouble reaching the mail server.",
    "I don't have access to your email account.",
    "I don't have permission to read that mailbox.",
    "I wasn't able to load your inbox.",
    'The assistant was unable to read the message.',
    'The assistant failed to fetch the email.',
    "Aman can't send email right now.",
    "Assistant couldn't load the calendar.",
    "Unable to read the user's email.",
    'Could not reach the mail server.',
  ])('drops an ability note about Aman in a turn summary: %s', note => {
    expect(stripAssistantAbilityNotes(`Turn summary: ${note}`)).toBe('');
  });

  it.each([
    "I won't be able to read email.",
    "I won't be able to read email until you reconnect the account.",
    "Aman won't be able to check the calendar.",
    'Aman will not be able to send email.',
    'I will not be able to read email.',
    'I will be unable to read email.',
    'The assistant will be unable to read email.',
    "I won't have access to email.",
    "I haven't been able to read email.",
    "Aman hasn't been able to read email.",
    "The assistant hasn't been able to send email.",
    'I lack access to the calendar.',
    'Aman lacks access to the calendar.',
  ])('drops a future or perfect tense ability note about Aman in a turn summary: %s', note => {
    expect(stripAssistantAbilityNotes(`Turn summary: ${note}`)).toBe('');
  });

  it.each([
    "I'll be unable to read email.",
    "I'd be unable to read email.",
    'I would not be able to read email.',
    'I might not be able to read email.',
    "I'm going to be unable to read email.",
    'I had no access to the drive.',
    'Aman had no access to the drive.',
    'I can not read email.',
    "I don't have the ability to read email.",
    'I am incapable of reading email.',
    'Will not be able to read email.',
  ])('drops a future or modal ability note about Aman in a turn summary: %s', note => {
    expect(stripAssistantAbilityNotes(`Turn summary: ${note}`)).toBe('');
  });

  it.each([
    "The user can't check email during work hours.",
    'Alex cannot read small print without glasses.',
    'The user is unable to access her old account.',
    'Marta has no access to the shared drive.',
    'The user prefers a short summary every morning.',
    "The user told Aman he can't swim.",
  ])('keeps a fact about the person: %s', fact => {
    expect(stripAssistantAbilityNotes(fact)).toBe(fact);
  });

  it.each([
    "The user won't be able to attend Friday.",
    'The user will not be able to check email while traveling.',
    "Alex hasn't been able to reach her old account.",
    'The user lacks access to the shared drive.',
  ])('keeps a future or perfect tense fact about the person: %s', fact => {
    expect(stripAssistantAbilityNotes(fact)).toBe(fact);
  });

  it.each([
    'I am able to read email.',
    'I will send the email tomorrow.',
    'I have been reading your email all morning.',
  ])('keeps a positive or plain statement about Aman: %s', statement => {
    expect(stripAssistantAbilityNotes(statement)).toBe(statement);
  });

  it.each([
    "I can't swim.",
    '- I cannot take calls on Fridays.',
    "I'm unable to drive at night.",
    'I have access to the shared drive.',
    'No access to the building after hours.',
    'Cannot be reached after 5pm.',
  ])("keeps the person's own plain text, which is not a turn or a summary: %s", content => {
    expect(stripAssistantAbilityNotes(content)).toBe(content);
  });

  it('keeps a User: turn that has no assistant part', () => {
    expect(stripAssistantAbilityNotes("User: I can't swim.")).toBe("User: I can't swim.");
  });

  it.each([
    'No access to the building after hours.',
    'Cannot be reached after 5pm.',
    'I have access to the shared drive.',
    'Alex said I cannot work Fridays.',
    "The user said I can't swim.",
    'Aman will be able to read email once you reconnect.',
    "The user can't check email at work.",
    'Marta has no access to the shared drive.',
    "The user told Aman he can't swim.",
  ])('keeps a fact inside a turn summary: %s', statement => {
    const content = `Turn summary: ${statement}`;
    expect(stripAssistantAbilityNotes(content)).toBe(content);
  });

  it('drops an ability note Aman reports about himself in a turn summary', () => {
    expect(stripAssistantAbilityNotes("Turn summary: Aman said I can't read email.")).toBe('');
  });

  it('drops a future tense ability note inside a turn summary and keeps the other sentences', () => {
    const content =
      "Turn summary: The mail check failed. I won't be able to read email until the account is reconnected. The user moved lunch to 1pm.";
    expect(stripAssistantAbilityNotes(content)).toBe(
      'Turn summary: The mail check failed. The user moved lunch to 1pm.',
    );
  });

  it('drops a future tense ability note from the assistant side of a verbatim turn only', () => {
    const content = "User: Please read my email.\n\nAssistant: I won't be able to read email until you sign in again.";
    expect(stripAssistantAbilityNotes(content)).toBe('User: Please read my email.');
  });

  it("keeps the person's own future tense statement in a verbatim turn", () => {
    const item = buildRetainItem({
      sessionId: 's1',
      turnId: 't3',
      userText: "I won't be able to check email on Friday.",
      assistantText: 'Noted. I moved the reminder to Monday.',
      completedAt: '2026-09-19T12:00:00.000Z',
    });
    if (item === undefined) {
      throw new Error('expected a retain item');
    }
    const result = stripAssistantAbilityNotes(item.content);
    expect(result).toContain("I won't be able to check email on Friday.");
    expect(result).toContain('I moved the reminder to Monday.');
  });

  it('leaves a line with no ability note byte-identical, doubled spaces included', () => {
    const content = 'The user moved lunch to 1pm.  The dentist appointment moved to Friday.';
    expect(stripAssistantAbilityNotes(content)).toBe(content);
  });

  it('keeps an enthusiasm idiom that is not an inability note', () => {
    expect(stripAssistantAbilityNotes("I can't wait to help you plan the trip.")).toBe(
      "I can't wait to help you plan the trip.",
    );
  });

  it('drops only the ability bullet from a turn summary', () => {
    const content = [
      'Turn summary: - The user asked Aman to check the new email.',
      "- I can't read email right now.",
      '- The user decided to keep Fridays free.',
    ].join('\n');
    const result = stripAssistantAbilityNotes(content);
    expect(result).toContain('Turn summary:');
    expect(result).toContain('The user asked Aman to check the new email.');
    expect(result).toContain('The user decided to keep Fridays free.');
    expect(result).not.toContain("can't read email");
  });

  it('drops an ability sentence inside a longer assistant statement and keeps the rest', () => {
    const content =
      "Turn summary: The inbox check failed because I can't read email right now. The user moved the dentist appointment to Friday.";
    const result = stripAssistantAbilityNotes(content);
    expect(result).toContain('The user moved the dentist appointment to Friday.');
    expect(result).not.toContain("can't read email");
  });

  it('never filters what the person said in a verbatim turn, and filters only the assistant side', () => {
    const item = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: "Please check my email. Also note I can't read my email at work, the firewall blocks it.",
      assistantText:
        "I can't read email right now because the sign-in failed. Your dentist appointment is on Friday at 10.",
      completedAt: '2026-09-19T12:00:00.000Z',
    });
    if (item === undefined) {
      throw new Error('expected a retain item');
    }
    const result = stripAssistantAbilityNotes(item.content);
    expect(result).toContain("I can't read my email at work");
    expect(result).toContain('Your dentist appointment is on Friday at 10.');
    expect(result).not.toContain("I can't read email right now");
  });

  it('keeps the person side when the whole assistant side is an ability note', () => {
    const item = buildRetainItem({
      sessionId: 's1',
      turnId: 't2',
      userText: 'Please read my new email.',
      assistantText: "I can't read email.",
      completedAt: '2026-09-19T12:00:00.000Z',
    });
    if (item === undefined) {
      throw new Error('expected a retain item');
    }
    const result = stripAssistantAbilityNotes(item.content);
    expect(result).toContain('Please read my new email.');
    expect(result).not.toContain("can't read email");
  });

  it('leaves a learned profile document untouched, because it is not a turn or a summary', () => {
    const content = [
      '## Preferences',
      '',
      '- Prefers tea in the morning.',
      "- Aman can't access the work calendar.",
    ].join('\n');
    expect(stripAssistantAbilityNotes(content)).toBe(content);
  });
});

describe('memory write path: MarkdownMemoryClient.retain', () => {
  it('stores the facts from a summary and not the ability note', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mdmem-ability-'));
    try {
      const client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' });
      const outcome = await client.retain({
        items: [
          {
            content: "Turn summary: - I can't read email right now.\n- The user decided to keep Fridays free.",
            timestamp: '2026-09-19T12:00:00.000Z',
            document_id: 'doc-1',
          },
        ],
        operationId: 'op-summary',
        timeoutMs: 5000,
      });
      expect(outcome).toEqual({ ok: true });
      const log = await readFile(path.join(dir, 'tenant-1', 'memory', '2026-09-19.md'), 'utf8');
      expect(log).toContain('The user decided to keep Fridays free.');
      expect(log).not.toContain("can't read email");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores the person's own plain statement unchanged", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mdmem-ability-'));
    try {
      const client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' });
      const outcome = await client.retain({
        items: [{ content: "I can't swim.", timestamp: '2026-09-19T12:00:00.000Z', document_id: 'doc-3' }],
        operationId: 'op-plain',
        timeoutMs: 5000,
      });
      expect(outcome).toEqual({ ok: true });
      const log = await readFile(path.join(dir, 'tenant-1', 'memory', '2026-09-19.md'), 'utf8');
      expect(log).toContain("I can't swim.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stores nothing for an item that is only an ability note, and still completes the operation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mdmem-ability-'));
    try {
      const client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' });
      const outcome = await client.retain({
        items: [
          { content: "Turn summary: I can't read email.", timestamp: '2026-09-19T12:00:00.000Z', document_id: 'doc-2' },
        ],
        operationId: 'op-note-only',
        timeoutMs: 5000,
      });
      expect(outcome).toEqual({ ok: true });
      await expect(readFile(path.join(dir, 'tenant-1', 'memory', '2026-09-19.md'), 'utf8')).rejects.toThrow();
      const operation = await client.getOperation('op-note-only', 5000);
      expect(operation).toEqual({ ok: true, status: 'completed' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('memory write path: HindsightClient.retain', () => {
  function jsonResponse(body: unknown): Response {
    const text = JSON.stringify(body);
    const headers = new Headers();
    headers.set('content-length', String(Buffer.byteLength(text, 'utf8')));
    return new Response(text, { status: 200, headers });
  }

  it('sends only the filtered content to the memory provider', async () => {
    const bodies: string[] = [];
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return jsonResponse({});
    });
    const client = new HindsightClient({
      apiBase: 'https://hindsight.example',
      bank: 'aman',
      headers: {},
      fetchImpl,
    });
    const outcome = await client.retain({
      items: [
        {
          content: "Turn summary: - I can't read email right now.\n- The user decided to keep Fridays free.",
          timestamp: '2026-09-19T12:00:00.000Z',
          document_id: 'doc-1',
        },
      ],
      operationId: 'op-1',
      timeoutMs: 10_000,
    });
    expect(outcome).toEqual({ ok: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('The user decided to keep Fridays free.');
    expect(bodies[0]).not.toContain("can't read email");
  });

  it('sends nothing when every item is an ability note, and still succeeds', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}));
    const client = new HindsightClient({
      apiBase: 'https://hindsight.example',
      bank: 'aman',
      headers: {},
      fetchImpl,
    });
    const outcome = await client.retain({
      items: [
        { content: "Turn summary: I can't read email.", timestamp: '2026-09-19T12:00:00.000Z', document_id: 'doc-2' },
      ],
      operationId: 'op-2',
      timeoutMs: 10_000,
    });
    expect(outcome).toEqual({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
