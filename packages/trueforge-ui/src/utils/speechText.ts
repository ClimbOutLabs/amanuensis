/**
 * Plain-sentence helpers for reading an answer aloud. Pure: no browser speech APIs here, so the
 * rules can be tested without a speech engine.
 */

/** Most words an automatically spoken answer reads before pointing at the screen. */
export const SPOKEN_WORD_LIMIT = 60;
export const REST_ON_SCREEN = 'The rest is on screen.';
export const APPROVAL_SPEECH_PREFIX = 'I need your OK on screen.';
const APPROVAL_WORD_LIMIT = 20;

/** The part fields speech reads; a content part of any message fits this shape. */
export type SpeechContentPart = {
  readonly type: string;
  readonly text?: string;
  readonly toolCallId?: string;
  readonly approval?: { readonly approved?: boolean; readonly resolution?: string };
};

/**
 * Turns markdown into sentences a listener can follow: fenced code, tables and rules are dropped,
 * links keep their words, and URLs and markup are removed.
 */
export function plainSpeechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .split('\n')
    .filter(line => !/^\s*\|/.test(line) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(line))
    .map(line =>
      line
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<https?:\/\/[^>]+>/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/\*\*|__|~~|\*/g, '')
        .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1'),
    )
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keeps the first `maxWords` words of already-plain text and says where the rest is. */
export function limitSpeechWords(text: string, maxWords: number = SPOKEN_WORD_LIMIT): string {
  const words = text.split(' ').filter(word => word !== '');
  if (words.length <= maxWords) return text;
  const head = words.slice(0, maxWords).join(' ');
  return /[.!?]$/.test(head) ? `${head} ${REST_ON_SCREEN}` : `${head}. ${REST_ON_SCREEN}`;
}

/**
 * The answer a person hears: the text after the last tool call or thinking step, in plain words.
 * Status text that came before a tool call is not part of it.
 */
export function finalAnswerSpeech(content: readonly SpeechContentPart[]): string {
  let start = content.length;
  while (start > 0 && content[start - 1]?.type === 'text') start--;
  const text = content
    .slice(start)
    .map(part => part.text ?? '')
    .join('\n');
  return plainSpeechText(text);
}

/** The tool calls in a message that are still waiting for the person's answer. */
export function pendingApprovalCallIds(content: readonly SpeechContentPart[]): string[] {
  return content.flatMap(part =>
    part.type === 'tool-call' &&
    part.toolCallId != null &&
    part.approval != null &&
    part.approval.approved === undefined &&
    part.approval.resolution === undefined
      ? [part.toolCallId]
      : [],
  );
}

/** One short line for a reply that stops at an approval. Built from the card's plain sentence. */
export function approvalSpeechLine(plainWhat: string): string {
  const words = plainSpeechText(plainWhat)
    .split(' ')
    .filter(word => word !== '');
  const head = words.slice(0, APPROVAL_WORD_LIMIT).join(' ');
  return head === '' ? APPROVAL_SPEECH_PREFIX : `${APPROVAL_SPEECH_PREFIX} ${head}`;
}
