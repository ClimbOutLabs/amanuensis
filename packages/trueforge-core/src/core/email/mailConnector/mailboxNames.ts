/** One folder in the mail account, as the sidecar lists it. Flags hold IMAP special-use marks such as `\Sent`. */
export interface ListedMailbox {
  name: string;
  delimiter: string;
  flags: readonly string[];
}

/**
 * The everyday names a person or the model gives a standard folder, and the IMAP special-use mark the
 * account puts on its own folder of that kind. Providers name these folders differently (Gmail's sent
 * folder is "[Gmail]/Sent Mail", Outlook's is "Sent Items"), so a common name is matched by the mark.
 */
const STANDARD_FOLDERS: readonly { flag: string; words: readonly string[] }[] = [
  { flag: '\\sent', words: ['sent', 'sentmail', 'sentitems', 'sentmessages'] },
  { flag: '\\drafts', words: ['drafts', 'draft'] },
  { flag: '\\trash', words: ['trash', 'bin', 'deleted', 'deleteditems', 'deletedmessages'] },
  { flag: '\\junk', words: ['junk', 'spam', 'junkemail', 'junkmail', 'bulk', 'bulkmail'] },
  { flag: '\\archive', words: ['archive', 'archives'] },
  { flag: '\\all', words: ['allmail'] },
  { flag: '\\flagged', words: ['flagged', 'starred'] },
];

/** A folder name's last level, in lower case with spaces and punctuation dropped: "[Gmail]/Sent Mail" reads "sentmail". */
function leafWord({ name, delimiter }: { name: string; delimiter: string }): string {
  const levels = delimiter === '' ? [name] : name.split(delimiter);
  const leaf = levels[levels.length - 1] ?? name;
  return leaf.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function standardFolderOf(word: string): { flag: string; words: readonly string[] } | undefined {
  return STANDARD_FOLDERS.find(folder => folder.words.includes(word));
}

/** The one listed folder that fits, or undefined when none or several do. */
function onlyOne(found: readonly ListedMailbox[]): ListedMailbox | undefined {
  const [first, ...others] = found;
  return others.length === 0 ? first : undefined;
}

/** Whether the name is the inbox, which every account has and IMAP reads in any case. */
export function isInboxName(name: string): boolean {
  return name.toUpperCase() === 'INBOX';
}

/**
 * The account's own folder for the name the call gave. An exact name is used as given; otherwise a name that
 * differs only in case, then a standard folder (sent, drafts, trash, spam, archive) found by its special-use
 * mark or, on a server without marks, by its everyday name. Undefined when no single folder fits.
 */
export function resolveMailboxName({
  requested,
  mailboxes,
}: {
  requested: string;
  mailboxes: readonly ListedMailbox[];
}): string | undefined {
  if (mailboxes.some(mailbox => mailbox.name === requested)) {
    return requested;
  }
  const sameLetters = onlyOne(mailboxes.filter(mailbox => mailbox.name.toLowerCase() === requested.toLowerCase()));
  if (sameLetters !== undefined) {
    return sameLetters.name;
  }
  const standard = standardFolderOf(leafWord({ name: requested, delimiter: '/' }));
  if (standard === undefined) {
    return undefined;
  }
  const marked = mailboxes.filter(mailbox => mailbox.flags.some(flag => flag.toLowerCase() === standard.flag));
  if (marked.length > 0) {
    return onlyOne(marked)?.name;
  }
  return onlyOne(mailboxes.filter(mailbox => standard.words.includes(leafWord(mailbox))))?.name;
}

/** The plain refusal for a folder the account does not have, naming the folders it does have. */
export function unknownMailboxText({
  requested,
  mailboxes,
}: {
  requested: string;
  mailboxes: readonly ListedMailbox[];
}): string {
  const listed = mailboxes.map(mailbox => `'${mailbox.name}'`).join(', ');
  return `This Email account has no folder named '${requested}', so nothing was read or changed. Try again with one of its folders: ${listed}.`;
}
