/**
 * A message must be what the user sees. Text that would not show (Unicode tags, variation selectors, soft
 * hyphens, deprecated format controls) is refused on every path that could send it, and every header or part
 * that could change who gets a message or what it contains makes a draft unsendable.
 */
import { assessDraft } from '../../../../src/core/email/gmail/draftAssessment';
import { hasHiddenCharacters, stripInvisible } from '../../../../src/core/email/gmail/mimeText';
import { DraftEmailSchema, UpdateDraftSchema } from '../../../../src/core/email/gmail/toolContract';
import { escapeDisplayText } from '../../../../src/core/permissions/extractorRegistry';
import { message, plainDraft } from './fixtures';
import { build, json, route, sentDraft, text } from './harness';

const ACCOUNT = 'ada@example.com';
const COMPOSE = ['gmail_read', 'gmail_compose'] as const;

/** "ignore" written in Unicode tag characters, which render as nothing. */
const TAGS = String.fromCodePoint(...[...'ignore'].map(letter => 0xe0000 + letter.charCodeAt(0)));
const HIDING = [
  ['Unicode tag characters', TAGS],
  ['a variation selector', '︀'],
  ['a variation selector supplement', '\u{E0100}'],
  ['a stray emoji marker', '️'],
  ['a soft hyphen', '­'],
  ['a deprecated format control', '⁪'],
  ['the Mongolian vowel separator', '᠎'],
  ['a zero-width space', '​'],
  ['a bidi override', '‮'],
] as const;

describe('hasHiddenCharacters', () => {
  it.each(HIDING)('sees %s', (_name, hidden) => {
    expect(hasHiddenCharacters(`Thursday${hidden}works`)).toBe(true);
    expect(stripInvisible(`Thursday${hidden}works`)).toBe('Thursdayworks');
  });

  it('leaves the text people write alone: accents, scripts, joiners and an emoji marker after a pictograph', () => {
    for (const fine of ['Olá, até quinta', '日本語のメール', 'שלום עולם', 'مرحبا', 'می‌خواهم', '❤️ thanks 👍']) {
      expect(hasHiddenCharacters(fine)).toBe(false);
    }
  });
});

describe('the card shows what is hidden', () => {
  it.each(HIDING)('turns %s into a visible escape', (_name, hidden) => {
    const shown = escapeDisplayText(`a${hidden}b`);
    expect(shown).toContain('\\u{');
    expect(shown).not.toContain(hidden);
  });

  it('keeps an emoji marker that follows a pictograph', () => {
    expect(escapeDisplayText('❤️')).toBe('❤️');
  });
});

describe('draft_email and update_draft refuse text that would not show', () => {
  const ok = { to: ['grace@example.com'], subject: 'Lease', body: 'Thursday works.' };

  it.each(HIDING)('in the subject, body and recipients: %s', (_name, hidden) => {
    for (const bad of [
      { ...ok, subject: `Le${hidden}ase` },
      { ...ok, body: `Thursday${hidden} works.` },
      { ...ok, cc: [`lin${hidden}@example.com`] },
      { ...ok, bcc: [`lin${hidden}@example.com`] },
    ]) {
      expect(DraftEmailSchema.safeParse(bad).success).toBe(false);
      expect(UpdateDraftSchema.safeParse({ draft_id: 'd1', ...bad }).success).toBe(false);
    }
    expect(DraftEmailSchema.safeParse(ok).success).toBe(true);
  });

  it('never saves, and never shows a card for, a draft hiding a tag-character payload', async () => {
    const { tools, google } = await build({ features: [...COMPOSE], routes: [] });
    const hiding = { to: ['grace@example.com'], subject: 'Lease', body: `Thursday works.${TAGS}` };
    const info = await tools.toolCallInfo({ name: 'draft_email', arguments: hiding });
    expect(info.tier3_card ?? null).toBeNull();
    expect(info.is_approval_required).not.toBe(true);
    expect(text(await tools.callTool({ name: 'draft_email', arguments: hiding }))).toContain('Validation failed');
    expect(google.urls).toHaveLength(0);
  });
});

describe('assessDraft refuses a draft that hides text', () => {
  const assess = (mail: ReturnType<typeof plainDraft>, forSend = true) =>
    assessDraft({ message: mail, account: ACCOUNT, forSend });

  it.each(HIDING)('in the body, subject or recipients: %s', (_name, hidden) => {
    for (const mail of [
      plainDraft({ id: 'd', to: 'grace@example.com', body: `Thursday${hidden} works.` }),
      plainDraft({ id: 'd', to: 'grace@example.com', subject: `Le${hidden}ase`, body: 'x' }),
      plainDraft({ id: 'd', to: `grace${hidden}@example.com`, body: 'x' }),
      plainDraft({ id: 'd', to: 'grace@example.com', cc: `lin${hidden}@example.com`, body: 'x' }),
    ]) {
      const result = assess(mail);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain('do not show');
      expect(assess(mail, false).ok).toBe(false);
    }
  });

  it('refuses a hidden payload in an encoded-word subject too', () => {
    const encoded = `=?utf-8?B?${Buffer.from(`Lease${TAGS}`).toString('base64')}?=`;
    expect(assess(plainDraft({ id: 'd', to: 'grace@example.com', subject: encoded, body: 'x' })).ok).toBe(false);
  });

  it('on every path: no card, no review, no send', async () => {
    const hidden = plainDraft({ id: 'd-m1', to: 'grace@example.com', body: `Thursday works.${TAGS}` });
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        route('/drafts/d1', { id: 'd1', message: hidden }),
        url => (url.pathname.endsWith('/drafts/send') ? json({ id: 's', threadId: 't' }) : undefined),
      ],
    });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(info.tier3_card ?? null).toBeNull();
    expect(info.pre_dispatch_failure?.message).toContain('do not show');
    const update = await tools.toolCallInfo({
      name: 'update_draft',
      arguments: { draft_id: 'd1', to: ['grace@example.com'], subject: 'Lease', body: 'clean' },
    });
    expect(update.tier3_card ?? null).toBeNull();
    expect(text(await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } }))).toContain('not reviewed');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it('allows an emoji that a draft really has', () => {
    expect(assess(plainDraft({ id: 'd', to: 'grace@example.com', body: 'See you ❤️ 👍' })).ok).toBe(true);
  });
});

describe('assessDraft allows only the headers a draft needs', () => {
  const header = (name: string, value: string) => ({ name, value });
  const assess = (mail: ReturnType<typeof plainDraft>) =>
    assessDraft({ message: mail, account: ACCOUNT, forSend: true });
  const base = { id: 'd', to: 'grace@example.com', body: 'x' };

  it('sends a plain draft', () => {
    expect(assess(plainDraft(base)).ok).toBe(true);
  });

  it.each([
    ['an empty Reply-To followed by a real one', [header('Reply-To', ''), header('Reply-To', 'mallory@example.com')]],
    ['a Reply-To', [header('Reply-To', 'mallory@example.com')]],
    ['a Sender', [header('Sender', 'mallory@example.com')]],
    ['a Return-Path', [header('Return-Path', '<mallory@example.com>')]],
    ['a Delivered-To', [header('Delivered-To', 'mallory@example.com')]],
    ['a receipt request', [header('Disposition-Notification-To', 'mallory@example.com')]],
    ['a Resent-To', [header('Resent-To', 'mallory@example.com')]],
    ['an X header', [header('X-Forward-To', 'mallory@example.com')]],
    ['a Content-Disposition attachment', [header('Content-Disposition', 'attachment; filename="x.pdf"')]],
    ['a second Subject', [header('Subject', 'Something else')]],
    ['a second To', [header('To', 'mallory@example.com')]],
    ['a second From', [header('From', 'mallory@example.com')]],
    ['a second Bcc', [header('Bcc', 'a@example.com'), header('Bcc', 'mallory@example.com')]],
    ['a header whose name has other letters in it', [header('rEpLy-tO', 'mallory@example.com')]],
  ])('refuses %s', (_name, extraHeaders) => {
    expect(assess(plainDraft({ ...base, extraHeaders })).ok).toBe(false);
  });

  it.each([
    ['a display name that is another address', '"mallory@example.com" <ada@example.com>', true],
    ['a name that looks like the account and an address that is not', 'ada@example.com <mallory@example.com>', false],
    ['two addresses', 'Ada <ada@example.com>, mallory@example.com', false],
    ['a second angle address', 'Ada <ada@example.com> <mallory@example.com>', false],
    ['an unterminated quote', '"Ada <ada@example.com>', false],
    ['a different address', 'Ada <ada2@example.com>', false],
    ['an address in other case', 'ADA@Example.com', true],
    ['no From at all', '', false],
  ])('judges From by its address alone: %s', (_name, from, allowed) => {
    const mail = plainDraft(base);
    const headers = (mail.payload?.headers ?? []).filter(item => item.name !== 'From');
    const withFrom = from === '' ? headers : [...headers, header('From', from)];
    const changed = { ...mail, payload: { ...mail.payload, headers: withFrom } };
    expect(assess(changed).ok).toBe(allowed);
  });

  it('refuses a draft whose single part has a file name', () => {
    const mail = plainDraft(base);
    expect(assess({ ...mail, payload: { ...mail.payload, filename: 'notes.txt' } }).ok).toBe(false);
  });

  it('refuses a recipient list a reader could split differently', () => {
    expect(assess(plainDraft({ ...base, to: 'a@example.com, "b <mallory@example.com>' })).ok).toBe(false);
    expect(assess(plainDraft({ ...base, to: 'a@example.com <<mallory@example.com>' })).ok).toBe(false);
  });

  it('refuses a header too long to have been read in full', () => {
    expect(assess(plainDraft({ ...base, to: `${'a@example.com, '.repeat(1000)}` })).ok).toBe(false);
  });
});

describe('a subject is never cut on the card', () => {
  it('refuses a send whose subject is over 300 characters, even though the card header holds 1000', () => {
    const long = 'x'.repeat(301);
    const result = assessDraft({
      message: plainDraft({ id: 'd', to: 'grace@example.com', subject: long, body: 'x' }),
      account: ACCOUNT,
      forSend: true,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('subject');
  });

  it('refuses a subject that is long only once its encoded words are read', () => {
    const encoded = `=?utf-8?B?${Buffer.from('y'.repeat(400)).toString('base64')}?=`;
    expect(
      assessDraft({
        message: plainDraft({ id: 'd', to: 'grace@example.com', subject: encoded, body: 'x' }),
        account: ACCOUNT,
        forSend: true,
      }).ok,
    ).toBe(false);
  });

  it('sends one of exactly 300', () => {
    expect(
      assessDraft({
        message: plainDraft({ id: 'd', to: 'grace@example.com', subject: 'x'.repeat(300), body: 'x' }),
        account: ACCOUNT,
        forSend: true,
      }).ok,
    ).toBe(true);
  });
});

describe('what a received message shows', () => {
  it('has its hidden text removed when read, so the model never sees a smuggled payload', async () => {
    const mail = message({ id: 'm1', body: `Hi${TAGS} there` });
    const { tools } = await build({ routes: [route('/messages/m1', mail)] });
    const result = JSON.parse(text(await tools.callTool({ name: 'read_email', arguments: { message_id: 'm1' } })));
    expect(result.body).toBe('Hi there');
  });
});

describe('a draft Aman writes itself', () => {
  it('keeps an emoji with its presentation marker, since that text shows as it is', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        url =>
          url.pathname === '/gmail/v1/users/me/drafts'
            ? json({ id: 'd9', message: { id: 'm', threadId: 't' } })
            : undefined,
      ],
    });
    await tools.callTool({
      name: 'draft_email',
      arguments: { to: ['grace@example.com'], subject: 'Lease', body: 'Thursday works. ❤️' },
    });
    const encodedBody = sentDraft(google.bodies[0]).mime.split('\r\n\r\n')[1] ?? '';
    expect(Buffer.from(encodedBody, 'base64').toString('utf8')).toBe('Thursday works. ❤\uFE0F');
  });
});
