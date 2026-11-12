/**
 * Masks regions of a body where a literal `<!-- @block:… -->` is documentation text, not a
 * structural marker: fenced code blocks (``` / ~~~) and <pre>/<code> elements. Masked
 * characters become spaces, so offsets into the masked body match the original body and the
 * marker regex can run on it directly.
 *
 * This is fail-closed by construction: without masking, a fenced sample documenting the
 * marker syntax would parse as a real addressable block, and an edit_space call could
 * silently destroy everything after it — the exact fail-open class the reliability work
 * exists to eliminate. An unclosed fence or tag masks to the end of the body.
 *
 * Single O(n) line pass with indexOf-based tag counting: no nested quantifiers, so this
 * cannot reintroduce the backtracking the anchor pattern was fixed for.
 */
export function maskDocumentationRegions(body: string): string {
  const lines = body.split('\n');
  const roles = codeFenceRoles(lines);
  let tagDepth = 0;
  const masked = lines.map((line, index) => {
    const lower = line.toLowerCase();
    const role = roles[index] ?? 'outside';
    let isCode = role !== 'outside' || tagDepth > 0;

    // <pre> / <code> elements: crude open/close counting with indexOf (no regex
    // backtracking). Over-matching (e.g. `<preview>`) only masks more, never less.
    // Not counted inside a fenced code block: every line there is masked already, and a
    // literal "<pre>" in the sample text must not leak into the tag depth. A fence-closing
    // line still counts its tags — a <pre> after the closing fence is real.
    if (role === 'outside' || role === 'close') {
      const opens = countAny(lower, ['<pre', '<code']);
      const closes = countAny(lower, ['</pre', '</code']);
      if (opens > 0) {
        isCode = true;
      }
      tagDepth = Math.max(0, tagDepth + opens - closes);
    }

    return isCode ? line.replace(/[\s\S]/g, ' ') : line;
  });
  return masked.join('\n');
}

/** Where a line sits relative to a fenced code block: its opening line, inside it, its closing line, or outside. */
type CodeFenceRole = 'outside' | 'open' | 'inside' | 'close';

/**
 * The role of each line in fenced code blocks: ``` or ~~~, up to 3 leading spaces
 * (CommonMark). An info string is allowed on the opening line; the closing line is the
 * same fence character, at least as long, and nothing else. An unclosed fence runs to the
 * end. The one fence reader for space bodies.
 */
export function codeFenceRoles(lines: readonly string[]): CodeFenceRole[] {
  let fence: { char: string; minLength: number } | null = null;
  return lines.map(line => {
    const fenceOpen = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (fenceOpen === null) {
        return 'outside';
      }
      const sequence = fenceOpen[1] ?? '';
      fence = { char: sequence.charAt(0), minLength: sequence.length };
      return 'open';
    }
    const closePattern = new RegExp(`^ {0,3}[${fence.char}]{${String(fence.minLength)},}\\s*$`);
    if (closePattern.test(line)) {
      fence = null;
      return 'close';
    }
    // A fence-like line of the other style, or a shorter one, inside a fence is content.
    return 'inside';
  });
}

function countAny(haystack: string, needles: string[]): number {
  let count = 0;
  for (const needle of needles) {
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
      count += 1;
      index += needle.length;
    }
  }
  return count;
}
