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
    expect(text(await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } }))).toContain(
      'needs your OK again',
    );
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

describe('joiners are allowed only where they do their job', () => {
  const bits = (separator: string) => `Thursday${separator} works${separator}${separator}.`;

  it.each([
    ['a zero-width joiner between ordinary letters', 'a‍b'],
    ['joiners used as bits after normal text', bits('‍')],
    ['a joiner at the start or end', '‍abc‍'],
    ['a joiner between a pictograph and a letter', '😀‍b'],
    ['a zero-width non-joiner between Latin letters', 'a‌b'],
    ['non-joiners used as bits after normal text', bits('‌')],
    ['a non-joiner between a Latin letter and an Arabic one', 'a‌م'],
    ['a non-joiner between Arabic digits and Latin', '1‌a'],
  ])('refuses %s', (_name, text) => {
    expect(hasHiddenCharacters(text)).toBe(true);
    expect(DraftEmailSchema.safeParse({ to: ['grace@example.com'], subject: 'Lease', body: text }).success).toBe(false);
  });

  it.each([
    ['a family emoji', '👨‍👩‍👧'],
    ['a flag with a presentation marker', '🏳️‍🌈'],
    ['a skin tone', '👩🏽‍💻'],
    ['a heart on fire', '❤️‍🔥'],
    ['Persian', 'می‌خواهم'],
    ['Arabic', 'ك‌ل'],
    ['Devanagari', 'क‌ष'],
    ['Malayalam', 'ക‌ഷ'],
  ])('allows %s', (_name, text) => {
    expect(hasHiddenCharacters(text)).toBe(false);
    expect(stripInvisible(text)).toBe(text);
  });

  it('refuses a draft whose body hides joiner bits after normal text, on every path', async () => {
    const hidden = plainDraft({ id: 'd-m1', to: 'grace@example.com', body: bits('‍') });
    const { tools } = await build({
      features: [...COMPOSE],
      routes: [route('/drafts/d1', { id: 'd1', message: hidden })],
    });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(info.tier3_card ?? null).toBeNull();
    expect(info.pre_dispatch_failure?.message).toContain('do not show');
  });
});

describe('every character Unicode says is invisible is hidden', () => {
  it.each([
    ['a combining grapheme joiner', '͏'],
    ['a Braille blank', '⠀'],
    ['NUL', '\u0000'],
    ['ESC', '\u001B'],
    ['DEL', '\u007F'],
    ['a C1 control', '\u0085'],
    ['a form feed', '\f'],
    ['a Hangul filler', 'ㅤ'],
    ['a halfwidth Hangul filler', 'ﾠ'],
    ['a Hangul choseong filler', 'ᅟ'],
    ['a Hangul jungseong filler', 'ᅠ'],
    ['an interlinear annotation anchor', '￹'],
    ['an interlinear annotation terminator', '￻'],
    ['a line separator', ' '],
    ['a paragraph separator', ' '],
    ['a Mongolian free variation selector', '᠋'],
    ['a Khmer inherent vowel', '឴'],
    ['an invisible plus', '⁤'],
    ['a musical invisible mark', '\u{1D173}'],
  ])('%s', (_name, hidden) => {
    expect(hasHiddenCharacters(`Thursday${hidden}works`)).toBe(true);
    expect(stripInvisible(`Thursday${hidden}works`)).toBe('Thursdayworks');
    expect(escapeDisplayText(`a${hidden}b`)).not.toContain(hidden);
  });

  it('allows tab, newline and carriage return', () => {
    expect(hasHiddenCharacters('a\tb\r\nc\nd')).toBe(false);
  });

  it('refuses a draft that hides data in any of them, on the schema and in assessDraft', () => {
    for (const hidden of ['͏', '⠀', '\u0000', '\u001B', 'ㅤ', '￹']) {
      const body = `Thursday works${hidden}`;
      expect(DraftEmailSchema.safeParse({ to: ['grace@example.com'], subject: 'Lease', body }).success).toBe(false);
      expect(
        assessDraft({
          message: plainDraft({ id: 'd', to: 'grace@example.com', body }),
          account: ACCOUNT,
          forSend: true,
        }).ok,
      ).toBe(false);
    }
  });

  it('allows an emoji marker only after a pictograph that needs one', () => {
    expect(hasHiddenCharacters('❤️')).toBe(false);
    expect(hasHiddenCharacters('☺️')).toBe(false);
    expect(hasHiddenCharacters('😀️')).toBe(true);
    expect(hasHiddenCharacters('1️')).toBe(true);
    expect(hasHiddenCharacters('a️')).toBe(true);
    expect(hasHiddenCharacters('️')).toBe(true);
  });
});

describe('a send delivers the body exactly as the card shows it', () => {
  const assess = (body: string, forSend = true) =>
    assessDraft({ message: plainDraft({ id: 'd', to: 'grace@example.com', body }), account: ACCOUNT, forSend });

  it('refuses a megabyte of trailing tabs, and any trailing or leading blank space', () => {
    for (const body of [
      `Thursday works.${'\t'.repeat(1_000_000)}`,
      'Thursday works. ',
      'Thursday works.\t',
      'Thursday works.\n\n',
      'Thursday works.\r\n\r\n',
      'Thursday works.\n \n',
      ' Thursday works.',
      '\nThursday works.',
      '\tThursday works.',
      ' Thursday works.',
    ]) {
      const result = assess(body);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain('blank space');
    }
  });

  it('sends one closing newline, and shows and hashes the body untrimmed', () => {
    for (const body of ['Thursday works.', 'Thursday works.\n', 'Thursday works.\r\n', 'One.\n\nTwo.\n']) {
      const result = assess(body);
      expect(result.ok && result.draft.body).toBe(body);
    }
  });

  it('refuses a send whose trailing blank space is replaced after review, because the hash is of the exact body', async () => {
    let live = plainDraft({ id: 'd-m1', threadId: 't9', to: 'grace@example.com', body: 'Thursday works.\n' });
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        url => (url.pathname === '/gmail/v1/users/me/drafts/d1' ? json({ id: 'd1', message: live }) : undefined),
        url => (url.pathname.endsWith('/drafts/send') ? json({ id: 's', threadId: 't9' }) : undefined),
      ],
    });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(info.tier3_card?.email?.body).toBe('Thursday works.\n');
    live = plainDraft({ id: 'd-m1', threadId: 't9', to: 'grace@example.com', body: 'Thursday works.' });
    expect(text(await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } }))).toContain(
      'changed after you reviewed it',
    );
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it('writes a draft without blank space at its edges, so what Aman saves is what its card showed', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        url =>
          url.pathname === '/gmail/v1/users/me/drafts'
            ? json({ id: 'd7', message: { id: 'm', threadId: 't' } })
            : undefined,
      ],
    });
    const args = { to: ['grace@example.com'], subject: '  Lease  ', body: '\n\n  Thursday works.\n\n\n' };
    const info = await tools.toolCallInfo({ name: 'draft_email', arguments: args });
    expect(info.tier3_card?.email).toMatchObject({ subject: 'Lease', body: 'Thursday works.' });
    await tools.callTool({ name: 'draft_email', arguments: args });
    const { mime } = sentDraft(google.bodies[0]);
    expect(mime).toContain('Subject: Lease\r\n');
    expect(Buffer.from(mime.split('\r\n\r\n')[1] ?? '', 'base64').toString('utf8')).toBe('Thursday works.');
  });
});

describe('a draft in a charset Aman cannot read for certain is refused', () => {
  const assess = (mail: ReturnType<typeof plainDraft>) =>
    assessDraft({ message: mail, account: ACCOUNT, forSend: true });
  const base = { id: 'd', to: 'grace@example.com', body: 'x' };
  const withContentType = (value: string) => {
    const mail = plainDraft(base);
    const headers = (mail.payload?.headers ?? []).map(item =>
      item.name === 'Content-Type' ? { ...item, value } : item,
    );
    return { ...mail, payload: { ...mail.payload, headers } };
  };

  it.each([
    'text/plain; charset=utf-7',
    'text/plain; charset="UTF-7"',
    'text/plain; charset=x-made-up',
    'text/plain; charset=utf7',
  ])('refuses a body declared %s', contentType => {
    const result = assess(withContentType(contentType));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('text encoding');
  });

  it.each([
    ['a UTF-7 subject', '=?utf-7?Q?Lease?='],
    ['a UTF-7 subject in base64', '=?UTF-7?B?TGVhc2U=?='],
    ['an unknown charset', '=?x-made-up?B?TGVhc2U=?='],
    ['an encoded word with a space inside', '=?utf-8?Q?Lease x?='],
    ['an encoded word with a space in base64', '=?utf-8?B?TGVh c2U=?='],
  ])('refuses %s', (_name, subject) => {
    expect(assess(plainDraft({ ...base, subject })).ok).toBe(false);
  });

  it('refuses the same in a recipient header', () => {
    expect(assess(plainDraft({ ...base, to: '=?utf-7?Q?a?= <grace@example.com>' })).ok).toBe(false);
  });

  it('allows a readable charset and a well-formed encoded word', () => {
    expect(assess(withContentType('text/plain; charset="UTF-8"')).ok).toBe(true);
    expect(assess(plainDraft({ ...base, subject: '=?utf-8?B?TGVhc2U=?=' })).ok).toBe(true);
    expect(assess(plainDraft({ ...base, subject: '=?iso-8859-1?Q?Ol=E1_a_todos?=' })).ok).toBe(true);
  });
});

describe('every recipient is a bare address or Name <address>, with no comments', () => {
  const assess = (to: string, extra: { cc?: string; bcc?: string } = {}) =>
    assessDraft({ message: plainDraft({ id: 'd', to, body: 'x', ...extra }), account: ACCOUNT, forSend: true });

  it.each([
    ['a comment that hides a comma and a second address', 'grace@example.com (x, mallory@example.com)'],
    ['a comment before an address', '(grace@example.com) mallory@example.com'],
    ['a comment after an angle address', 'Grace <grace@example.com> (lin@example.com, mallory@example.com)'],
    ['a nested comment', 'a@example.com (a (b) c), mallory@example.com'],
    ['a group', 'Team: grace@example.com, mallory@example.com;'],
    ['a quoted local part', '"grace, mallory"@example.com'],
    ['a quoted address in angles', 'Grace <"grace"@example.com>'],
    ['a route', 'Grace <@relay.example.net:grace@example.com>'],
    ['a name that is an address', 'grace@example.com <mallory@example.com>'],
    ['an escape in a quoted name', '"Gra\\"ce" <grace@example.com>'],
    ['a trailing comma', 'grace@example.com,'],
    ['an empty entry', 'grace@example.com,, lin@example.com'],
    ['two addresses without a comma', 'grace@example.com lin@example.com'],
    ['two angle pairs', 'Grace <grace@example.com> <lin@example.com>'],
    ['text after the angle address', 'Grace <grace@example.com> lin'],
    ['an address with no domain', 'grace'],
  ])('refuses %s', (_name, to) => {
    expect(assess(to).ok).toBe(false);
    expect(assess('grace@example.com', { cc: to }).ok).toBe(false);
    expect(assess('grace@example.com', { bcc: to }).ok).toBe(false);
  });

  it.each([
    ['a bare address', 'grace@example.com'],
    ['a list of bare addresses', 'grace@example.com, lin@example.com'],
    ['a named address', 'Grace Lima <grace@example.com>'],
    ['a quoted name with a comma and parentheses', '"Costa, Rui (Lisbon)" <rui@example.com>'],
    ['a mixed list', 'Grace <grace@example.com>, lin@example.com, "Sam, Jr." <sam@example.com>'],
    ['a non-ASCII name', 'José Müller <jose@example.com>'],
  ])('allows %s', (_name, to) => {
    expect(assess(to).ok).toBe(true);
  });
});
