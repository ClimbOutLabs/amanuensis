/**
 * One rejection contract for every structured-edit tool (`apply_patch`, `replace_text`,
 * `write_file`) and every module that validates their arguments
 * (`Sandbox.ts`, `structuredEditPaths.ts`, `openaiPatchFormat.ts`).
 *
 * Before this module existed, a rejection named the rule that was violated ("apply_patch
 * requires an unambiguous Git-format unified diff...") but not what the model actually sent, so a
 * retrying model had nothing to correct against and a repeat guard ended the turn. Every
 * rejection built with `structuredEditRejection` states three things in one sentence: what was
 * received, what was expected, and (optionally) a concrete hint for the retry.
 */

export interface StructuredEditRejectionInput {
  /** The tool the argument was destined for, e.g. `apply_patch`, `replace_text`, `write_file`. */
  tool: string;
  /** Short noun phrase naming what was wrong, e.g. `the patch format`, `the target path`. */
  what: string;
  /** What was actually received, rendered as a short, human-readable value. */
  received: string;
  /** What the tool expected instead, as a short, human-readable description. */
  expected: string;
  /** Optional concrete guidance for the retry, e.g. "Send a plain Git unified diff instead." */
  hint?: string;
}

/**
 * Builds one rejection message of the form:
 * `<tool> rejected <what>: received <received>; expected <expected>. <hint>`
 */
export function structuredEditRejection(input: StructuredEditRejectionInput): string {
  const hint = input.hint === undefined || input.hint.trim().length === 0 ? '' : ` ${input.hint.trim()}`;
  return `${input.tool} rejected ${input.what}: received ${input.received}; expected ${input.expected}.${hint}`;
}

const MAX_SNIPPET_LENGTH = 80;
const CONTROL_CHAR_NAMES: Readonly<Record<string, string>> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** Escapes ASCII control characters (including DEL) as backslash-x-NN, with friendly \n \r \t forms. */
function escapeControlChars(text: string): string {
  let out = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      out += CONTROL_CHAR_NAMES[character] ?? `\\x${codePoint.toString(16).padStart(2, '0')}`;
    } else {
      out += character;
    }
  }
  return out;
}

/**
 * Renders an arbitrary received value as a short, quoted, control-character-escaped snippet
 * suitable for the `received` field of a rejection built with `structuredEditRejection`.
 */
export function structuredEditReceivedSnippet(value: string): string {
  const escaped = escapeControlChars(value);
  const truncated = escaped.length > MAX_SNIPPET_LENGTH ? `${escaped.slice(0, MAX_SNIPPET_LENGTH)}…` : escaped;
  return truncated.length === 0 ? '(empty)' : `"${truncated}"`;
}
