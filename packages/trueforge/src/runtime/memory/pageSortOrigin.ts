import { isMemoryNoteSource, NOTE_SOURCE_METADATA_KEY, SENT_MAIL_SOURCE, type FactSource } from './memoryNotes';
import { MEMORY_ORIGIN_METADATA_KEY, USER_STATED_ORIGIN } from './memoryOrigin';

/**
 * Whose words a saved note holds, which decides what sorting it may do. Read from the note's stored origin and
 * source, never from its text.
 */
export type NoteOrigin =
  | { kind: 'own_words' }
  | { kind: 'sent_mail' }
  | { kind: 'read'; source: Extract<FactSource, 'mail' | 'calendar' | 'read_content'> }
  | { kind: 'assistant_reply' };

/**
 * An origin whose notes may be sorted onto pages. What the assistant said in a reply is not a fact about anyone
 * in the person's life, so such a note is never sorted and no model is asked about it.
 */
export type SortableOrigin = Exclude<NoteOrigin, { kind: 'assistant_reply' }>;

/**
 * The note's origin from its recall metadata. Only a note with no source and the person's own origin is their
 * own words. A note with a missing or unknown source is read content.
 */
export function noteOriginOf(metadata: Readonly<Record<string, string>>): NoteOrigin {
  const source = metadata[NOTE_SOURCE_METADATA_KEY];
  const own = metadata[MEMORY_ORIGIN_METADATA_KEY] === USER_STATED_ORIGIN;
  if (source === undefined) {
    return own ? { kind: 'own_words' } : { kind: 'read', source: 'read_content' };
  }
  if (!isMemoryNoteSource(source) || own) {
    return { kind: 'read', source: 'read_content' };
  }
  switch (source) {
    case SENT_MAIL_SOURCE:
      return { kind: 'sent_mail' };
    case 'email':
      return { kind: 'read', source: 'mail' };
    case 'calendar':
      return { kind: 'read', source: 'calendar' };
    case 'assistant_response':
      return { kind: 'assistant_reply' };
    case 'web':
    case 'attachment':
    case 'other':
      return { kind: 'read', source: 'read_content' };
  }
}

/** The source written on every statement made from a note of this origin. The model never chooses it. */
export function statementSourceOf(origin: SortableOrigin): FactSource {
  switch (origin.kind) {
    case 'own_words':
      return 'you_said';
    case 'sent_mail':
      return 'sent_mail';
    case 'read':
      return origin.source;
  }
}

/** Where the note came from, in words for the prompt. */
export function describeNoteOrigin(origin: SortableOrigin): string {
  switch (origin.kind) {
    case 'own_words':
      return "the person's own words";
    case 'sent_mail':
      return 'a message the person sent';
    case 'read':
      return {
        mail: 'an email the assistant read',
        calendar: 'a calendar entry the assistant read',
        read_content: 'something the assistant read, such as a web page or a file',
      }[origin.source];
  }
}
