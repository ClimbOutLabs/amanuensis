import {
  isInboxName,
  type ListedMailbox,
  resolveMailboxName,
  unknownMailboxText,
} from '../../../../src/core/email/mailConnector/mailboxNames';

/** Folders as a Gmail-style server lists them, with special-use marks. */
const MARKED: ListedMailbox[] = [
  { name: 'INBOX', delimiter: '/', flags: ['\\HasNoChildren'] },
  { name: '[Gmail]/All Mail', delimiter: '/', flags: ['\\All', '\\HasNoChildren'] },
  { name: '[Gmail]/Drafts', delimiter: '/', flags: ['\\Drafts', '\\HasNoChildren'] },
  { name: '[Gmail]/Sent Mail', delimiter: '/', flags: ['\\HasNoChildren', '\\Sent'] },
  { name: '[Gmail]/Spam', delimiter: '/', flags: ['\\Junk', '\\HasNoChildren'] },
  { name: '[Gmail]/Trash', delimiter: '/', flags: ['\\Trash', '\\HasNoChildren'] },
  { name: 'Receipts', delimiter: '/', flags: ['\\HasNoChildren'] },
];

/** Folders on a server with no special-use marks, nested under the inbox with a dot. */
const UNMARKED: ListedMailbox[] = [
  { name: 'INBOX', delimiter: '.', flags: [] },
  { name: 'INBOX.Sent Items', delimiter: '.', flags: [] },
  { name: 'INBOX.Junk E-mail', delimiter: '.', flags: [] },
];

describe('resolveMailboxName', () => {
  it('uses a name the account has as given', () => {
    expect(resolveMailboxName({ requested: '[Gmail]/Sent Mail', mailboxes: MARKED })).toBe('[Gmail]/Sent Mail');
    expect(resolveMailboxName({ requested: 'Receipts', mailboxes: MARKED })).toBe('Receipts');
  });

  it('matches the everyday names of standard folders by the mark the server puts on them', () => {
    for (const requested of ['Sent', 'sent', 'Sent Items', 'Sent Mail', 'SENT MESSAGES']) {
      expect(resolveMailboxName({ requested, mailboxes: MARKED })).toBe('[Gmail]/Sent Mail');
    }
    expect(resolveMailboxName({ requested: 'Spam', mailboxes: MARKED })).toBe('[Gmail]/Spam');
    expect(resolveMailboxName({ requested: 'Junk', mailboxes: MARKED })).toBe('[Gmail]/Spam');
    expect(resolveMailboxName({ requested: 'Drafts', mailboxes: MARKED })).toBe('[Gmail]/Drafts');
    expect(resolveMailboxName({ requested: 'Deleted Items', mailboxes: MARKED })).toBe('[Gmail]/Trash');
    expect(resolveMailboxName({ requested: 'All Mail', mailboxes: MARKED })).toBe('[Gmail]/All Mail');
  });

  it('matches a name that differs only in letter case, but never moves a folder of its own to another level', () => {
    expect(resolveMailboxName({ requested: 'receipts', mailboxes: MARKED })).toBe('Receipts');
    expect(resolveMailboxName({ requested: 'Work/Receipts', mailboxes: MARKED })).toBeUndefined();
  });

  it('finds standard folders by name on a server that marks none', () => {
    expect(resolveMailboxName({ requested: 'Sent', mailboxes: UNMARKED })).toBe('INBOX.Sent Items');
    expect(resolveMailboxName({ requested: 'Spam', mailboxes: UNMARKED })).toBe('INBOX.Junk E-mail');
  });

  it('finds nothing for a folder the account does not have, or when two folders fit equally', () => {
    expect(resolveMailboxName({ requested: 'Archive', mailboxes: MARKED })).toBeUndefined();
    expect(resolveMailboxName({ requested: 'Taxes', mailboxes: MARKED })).toBeUndefined();
    // An outbox holds mail not yet sent, so it is never read as the sent folder.
    expect(resolveMailboxName({ requested: 'Outbox', mailboxes: MARKED })).toBeUndefined();
    const twoSent: ListedMailbox[] = [
      { name: 'Sent', delimiter: '/', flags: ['\\Sent'] },
      { name: 'Old/Sent', delimiter: '/', flags: ['\\Sent'] },
    ];
    expect(resolveMailboxName({ requested: 'Sent Items', mailboxes: twoSent })).toBeUndefined();
  });
});

describe('isInboxName', () => {
  it('reads the inbox in any letter case', () => {
    expect(isInboxName('inbox')).toBe(true);
    expect(isInboxName('INBOX')).toBe(true);
    expect(isInboxName('INBOX.Sent')).toBe(false);
  });
});

describe('unknownMailboxText', () => {
  it('names the folders the account has and what to do next', () => {
    expect(unknownMailboxText({ requested: 'Taxes', mailboxes: UNMARKED })).toBe(
      "This Email account has no folder named 'Taxes', so nothing was read or changed. Try again with one of its folders: 'INBOX', 'INBOX.Sent Items', 'INBOX.Junk E-mail'.",
    );
  });
});
