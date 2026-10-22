/** Lines shown before a long message folds behind "Show full message". */
export const EMAIL_COLLAPSED_LINES = 9;

/** A run of the message: plain text, or a fenced code block that reads in mono. */
export type EmailBodySegment = { kind: 'text' | 'code'; text: string };

const FENCE = '```';

/**
 * Splits a message on its ``` fences. An unclosed fence runs to the end, so a half-typed block still
 * reads as code rather than leaking backticks into the prose.
 */
export function splitEmailBody(body: string): EmailBodySegment[] {
  const segments: EmailBodySegment[] = [];
  let kind: EmailBodySegment['kind'] = 'text';
  let lines: string[] = [];
  const flush = () => {
    const text = lines.join('\n');
    if (text !== '') segments.push({ kind, text });
    lines = [];
  };
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith(FENCE)) {
      flush();
      kind = kind === 'text' ? 'code' : 'text';
      continue;
    }
    lines.push(line);
  }
  flush();
  return segments;
}

/** Words in the whole message, counted the way a reader sees them: runs of non-space characters. */
export function countEmailWords(body: string): number {
  return body.split(/\s+/).filter(word => word !== '').length;
}

/** True when the message has more lines than fit in the collapsed view. */
export function isLongEmailBody(body: string): boolean {
  return body.split('\n').length > EMAIL_COLLAPSED_LINES;
}
