/**
 * Parses a `sandbox_artifacts` fence body (the format the host tells the model to emit, see the
 * guidance built in Sandbox.ts) into `{ name, path }` entries. Shared by the host (turn-completion
 * persistence) and the UI (`SandboxArtifactDownload`), so both read the same declaration the same
 * way: the host must persist exactly what the UI will later offer for download.
 */

export interface SandboxArtifact {
  name: string;
  path: string;
}

const PREFIX = 'sandbox_artifacts';
/** tfy / agent format: `[name](path)` */
const PAIR_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
/** Matches every non-nested `(...)` group on a line, e.g. the two groups in `foo (bar) (baz)`. */
const PAREN_GROUP_RE = /\(([^()]*)\)/g;
/** An absolute path with no parens or spaces, the only content a `(path)` group is treated as a path. */
const ABSOLUTE_PATH_ONLY_RE = /^\/[^()\s]+$/;
/** An absolute-path token: starts with `/`, no spaces unless the whole path is quoted. */
const ABSOLUTE_PATH_TOKEN_RE = /"(\/[^"]+)"|'(\/[^']+)'|(\/\S+)/;

function basename(path: string): string {
  const segments = path.split('/');
  const last = segments[segments.length - 1];
  return last !== undefined && last.length > 0 ? last : path;
}

/** Strips a single leading `-`/`*` bullet marker, as in `- name: path`. */
function stripBullet(line: string): string {
  return line.replace(/^\s*[-*]\s+/, '');
}

/** Strips a leading `-`/`:` separator left over after a name/path split. */
function stripLeadingSeparator(text: string): string {
  return text
    .trim()
    .replace(/^[-:]\s*/, '')
    .trim();
}

/** Strips a trailing `-`/`:` separator left over after a name/path split. */
function stripTrailingSeparator(text: string): string {
  return text
    .trim()
    .replace(/[-:]\s*$/, '')
    .trim();
}

/**
 * Finds the last non-nested `(...)` group on a line, e.g. the `(baz)` in
 * `foo (bar) (baz)`. Returns null when the line has no parenthesized group.
 */
function lastParenGroup(line: string): { content: string; start: number; end: number } | null {
  PAREN_GROUP_RE.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  for (let match = PAREN_GROUP_RE.exec(line); match !== null; match = PAREN_GROUP_RE.exec(line)) {
    last = match;
  }
  if (!last) {
    return null;
  }
  return { content: last[1] ?? '', start: last.index, end: last.index + last[0].length };
}

/**
 * Trims trailing punctuation the greedy `\S+` path match can swallow from
 * surrounding text, without damaging a path that legitimately ends that way:
 * - a trailing `)` is dropped only when the path carries no matching `(`
 *   (an unmatched `)` is closing text around the path, not the path itself)
 * - a trailing `.`, `,`, `:`, or `;` is dropped only when what remains still
 *   ends in a file extension (a dot followed by 1-8 alphanumerics), so
 *   `report.` (no extension after the dot) keeps its dot.
 */
function trimTrailingPunctuation(path: string): string {
  let result = path;
  let changed = true;
  while (changed) {
    changed = false;
    if (result.endsWith(')') && !result.includes('(')) {
      result = result.slice(0, -1);
      changed = true;
      continue;
    }
    if (/[.,:;]$/.test(result)) {
      const withoutTrailing = result.slice(0, -1);
      if (/\.[A-Za-z0-9]{1,8}$/.test(withoutTrailing)) {
        result = withoutTrailing;
        changed = true;
      }
    }
  }
  return result;
}

/**
 * Parses one non-link line into an artifact by finding an absolute-path token
 * (`/like/this`, optionally quoted) and treating the remaining text as the name.
 * Handles `name (path)`, a bare path, and a path followed by a description.
 */
function parseLooseLine(rawLine: string): SandboxArtifact | null {
  const line = stripBullet(rawLine.trim());
  if (!line) {
    return null;
  }

  // `name (path)`: the whole line ends in a parenthesized group. Only the
  // last such group is considered, and only when it holds an absolute path
  // with nothing after it, so `foo (bar) (baz)` (last group not a path)
  // falls through to the rules below instead of misreading `(bar)` as a path.
  const paren = lastParenGroup(line);
  if (paren) {
    const parenPath = paren.content.trim();
    const afterParen = line.slice(paren.end).trim();
    if (afterParen.length === 0 && ABSOLUTE_PATH_ONLY_RE.test(parenPath)) {
      const name = stripTrailingSeparator(line.slice(0, paren.start));
      return { name: name.length > 0 ? name : basename(parenPath), path: parenPath };
    }
  }

  const pathMatch = ABSOLUTE_PATH_TOKEN_RE.exec(line);
  if (!pathMatch) {
    return null;
  }
  // The greedy `\S+` branch can swallow trailing punctuation adjacent to the path.
  const path = trimTrailingPunctuation((pathMatch[1] ?? pathMatch[2] ?? pathMatch[3] ?? '').trim());
  if (!path) {
    return null;
  }

  const before = stripTrailingSeparator(line.slice(0, pathMatch.index));
  const after = stripLeadingSeparator(line.slice(pathMatch.index + pathMatch[0].length));
  const name = before.length > 0 ? before : after;
  return { name: name.length > 0 ? name : basename(path), path };
}

/**
 * Parses a `sandbox_artifacts` fence body into `{ name, path }` entries.
 * Accepts, in order of precedence:
 * 1. Markdown links: `[name](path)` (tfy-web-components primary format)
 * 2. `name: path` per line
 * 3. Any other line carrying an absolute path token: `name (path)`,
 *    `- name: path`, a bare `/absolute/path`, or a path followed by a
 *    description. The remaining text on the line becomes the name,
 *    falling back to the path's basename.
 */
export function parseSandboxArtifacts(raw: string): SandboxArtifact[] {
  const trimmed = raw.trim();
  const body = trimmed.startsWith(PREFIX) ? trimmed.slice(PREFIX.length).trimStart() : trimmed;

  const fromLinks: SandboxArtifact[] = [];
  PAIR_RE.lastIndex = 0;
  let match: RegExpExecArray | null = PAIR_RE.exec(body);
  while (match !== null) {
    const name = match[1]?.trim() ?? '';
    const path = match[2]?.trim() ?? '';
    if (name && path) {
      fromLinks.push({ name, path });
    }
    match = PAIR_RE.exec(body);
  }
  if (fromLinks.length > 0) {
    return fromLinks;
  }

  // Fallback: `name: path` per line (a leading `- ` bullet is allowed)
  const fromColonLines = body.split('\n').flatMap(rawLine => {
    const line = stripBullet(rawLine);
    const idx = line.indexOf(':');
    if (idx === -1) {
      return [];
    }
    const name = line.slice(0, idx).trim();
    const path = line.slice(idx + 1).trim();
    if (!name || !path) {
      return [];
    }
    // Skip leftover markdown link debris
    if (name.startsWith('[') || path.startsWith('(')) {
      return [];
    }
    return [{ name, path }];
  });
  if (fromColonLines.length > 0) {
    return fromColonLines;
  }

  // Last resort: any line carrying a recognizable absolute-path token.
  return body
    .split('\n')
    .map(parseLooseLine)
    .filter((artifact): artifact is SandboxArtifact => artifact !== null);
}

/** One `sandbox_artifacts` block found in a message, with where it sits in the text. */
interface SandboxArtifactBlock {
  start: number;
  end: number;
  body: string;
  closed: boolean;
}

/**
 * A `sandbox_artifacts` opener anywhere in the text: models indent it, glue it to the end of a
 * sentence, wrap it in another fence, or spell it `sandbox-artifacts`, and every one of those
 * still declares a file the user should get.
 */
const BLOCK_OPEN_RE = /(`{3,}|~{3,})[ \t]*sandbox[_-]artifacts\b/gi;

function findSandboxArtifactBlocks(text: string): SandboxArtifactBlock[] {
  const blocks: SandboxArtifactBlock[] = [];
  BLOCK_OPEN_RE.lastIndex = 0;
  for (let open = BLOCK_OPEN_RE.exec(text); open !== null; open = BLOCK_OPEN_RE.exec(text)) {
    const fence = open[1] ?? '```';
    const bodyStart = open.index + open[0].length;
    const closeAt = text.indexOf(fence, bodyStart);
    const closed = closeAt !== -1;
    const bodyEnd = closed ? closeAt : text.length;
    const end = closed ? closeAt + fence.length : text.length;
    blocks.push({ start: open.index, end, body: text.slice(bodyStart, bodyEnd), closed });
    BLOCK_OPEN_RE.lastIndex = end;
  }
  return blocks;
}

/**
 * Extracts every `sandbox_artifacts` block from a full assistant message and parses each one, in
 * order. Used at turn completion to find what to persist from the sandbox, and by the UI (through
 * `normalizeSandboxArtifactBlocks`) to find what to render: same extraction, same parse, so
 * persistence and download always agree on what the model declared. A block the model never
 * closed still counts, since the message is final.
 */
export function extractSandboxArtifactsFromMessage(messageText: string): SandboxArtifact[] {
  return findSandboxArtifactBlocks(messageText).flatMap(block => parseSandboxArtifacts(block.body));
}

/** Removes a fence left holding nothing but whitespace once a block inside it was taken out. */
const EMPTY_FENCE_RE = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n`~]*\n(?:[ \t]*\n)*[ \t]*\2[ \t]*(?=\n|$)/g;

/**
 * Rewrites a message so every `sandbox_artifacts` block, however the model formatted it, becomes
 * one well-formed fence at the end that a markdown renderer turns into a file card. A block that
 * names no file is dropped, so its raw text never shows. While the message is still streaming
 * (`complete: false`) an unclosed block is hidden until it closes.
 */
export function normalizeSandboxArtifactBlocks({ text, complete }: { text: string; complete: boolean }): string {
  const blocks = findSandboxArtifactBlocks(text);
  if (blocks.length === 0) {
    return text;
  }
  let rest = '';
  let cursor = 0;
  const artifacts: SandboxArtifact[] = [];
  for (const block of blocks) {
    rest += text.slice(cursor, block.start);
    cursor = block.end;
    if (block.closed || complete) {
      artifacts.push(...parseSandboxArtifacts(block.body));
    }
  }
  rest += text.slice(cursor);
  const prose = rest.replace(EMPTY_FENCE_RE, '$1').trimEnd();
  if (artifacts.length === 0) {
    return prose;
  }
  const lines = artifacts.map(artifact => `[${artifact.name.replace(/[[\]]/g, '')}](${artifact.path})`);
  return `${prose}\n\n\`\`\`sandbox_artifacts\n${lines.join('\n')}\n\`\`\`\n`;
}
