/**
 * Server-side tracked set of agent-written executables for Sentinel's
 * write-then-execute escalation.
 *
 * Entries are keyed by (tenant_id, created_by, workspace). There is no
 * first-class workspace identity in the session model; the session's
 * (repository_id, workspace_cwd) pair is the closest server-side identity
 * (implementation-plan grants bind the same pair), so the tracked set keys on
 * it and documents the choice here. Entries persist across conversations in
 * server-side storage, never in per-turn sandbox state.
 *
 * File identity is the canonical absolute path with all symlinks resolved
 * (realpath), normalized against the resolved working directory. The tracked
 * set, the runner's runtime record, and the approved-hash store all key on
 * file identity. Sandbox destruction orphans entries, which fail closed on
 * lookup: no approved pairs exist for an orphaned identity, so execution
 * escalates.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Scope key for tracked entries: the session's (repository_id, workspace_cwd) pair. */
export interface TrackedExecutableScope {
  tenant_id: string;
  created_by: string;
  repository_id: string | null;
  workspace_cwd: string | null;
}

export function workspaceKey(input: { repository_id: string | null; workspace_cwd: string | null }): string {
  return `${input.repository_id ?? ''}\n${input.workspace_cwd ?? ''}`;
}

function scopeKey(scope: TrackedExecutableScope): string {
  return `${scope.tenant_id}\n${scope.created_by}\n${workspaceKey(scope)}`;
}

export interface TrackApprovalGrantInput {
  conversation_id: string;
  file_identity: string;
  content_hash: string;
  argv_hash: string;
}

export interface TrackedExecutableStore {
  /** Record an agent-created or agent-modified file by identity. */
  track(input: { scope: TrackedExecutableScope; file_identity: string }): void;
  /** Remove the entry when its file is deleted (delete-path hook). */
  untrack(input: { scope: TrackedExecutableScope; file_identity: string }): void;
  /** True when the file identity is in the tracked set for the scope. */
  isTracked(input: { scope: TrackedExecutableScope; file_identity: string }): boolean;
  /**
   * Record an approved (content_hash, argv_hash) pair as a payload-bearing
   * grant keyed by (conversation_id, file_identity). Byte-identical
   * re-execution within the conversation does not re-escalate.
   */
  recordGrant(input: TrackApprovalGrantInput): void;
  /** True when an identical (content_hash, argv_hash) pair was approved. */
  hasGrant(input: TrackApprovalGrantInput): boolean;
  /** Purge a conversation's grant records when the conversation ends. */
  purgeConversationGrants(input: { conversation_id: string }): void;
}

/** Process-scoped store. Durable backends implement the same interface. */
export class InMemoryTrackedExecutableStore implements TrackedExecutableStore {
  private readonly entries = new Map<string, Set<string>>();
  private readonly grants = new Map<string, { content_hash: string; argv_hash: string }[]>();

  track(input: { scope: TrackedExecutableScope; file_identity: string }): void {
    const key = scopeKey(input.scope);
    let set = this.entries.get(key);
    if (set === undefined) {
      set = new Set();
      this.entries.set(key, set);
    }
    set.add(input.file_identity);
  }

  untrack(input: { scope: TrackedExecutableScope; file_identity: string }): void {
    this.entries.get(scopeKey(input.scope))?.delete(input.file_identity);
  }

  isTracked(input: { scope: TrackedExecutableScope; file_identity: string }): boolean {
    return this.entries.get(scopeKey(input.scope))?.has(input.file_identity) ?? false;
  }

  recordGrant(input: TrackApprovalGrantInput): void {
    const key = grantKey(input);
    const list = this.grants.get(key) ?? [];
    if (!list.some(g => g.content_hash === input.content_hash && g.argv_hash === input.argv_hash)) {
      list.push({ content_hash: input.content_hash, argv_hash: input.argv_hash });
    }
    this.grants.set(key, list);
  }

  hasGrant(input: TrackApprovalGrantInput): boolean {
    return (this.grants.get(grantKey(input)) ?? []).some(
      g => g.content_hash === input.content_hash && g.argv_hash === input.argv_hash,
    );
  }

  purgeConversationGrants(input: { conversation_id: string }): void {
    for (const key of [...this.grants.keys()]) {
      if (key.startsWith(`${input.conversation_id}\n`)) {
        this.grants.delete(key);
      }
    }
  }
}

function grantKey(input: { conversation_id: string; file_identity: string }): string {
  return `${input.conversation_id}\n${input.file_identity}`;
}

/**
 * Canonical file identity: absolute path with all symlinks resolved,
 * normalized against the resolved cwd. Returns null when the path cannot be
 * resolved; callers fail closed (escalate) on null.
 */
export function canonicalFileIdentity(input: { p: string; cwd: string }): string | null {
  try {
    const absolute = path.isAbsolute(input.p) ? input.p : path.resolve(input.cwd, input.p);
    return realpathSync(absolute);
  } catch {
    return null;
  }
}

/**
 * Canonical identity for a write target that may not exist yet: resolve the
 * parent directory's symlinks and append the basename. Null when the parent
 * cannot be resolved.
 */
export function canonicalWriteTarget(input: { p: string; cwd: string }): string | null {
  try {
    const absolute = path.isAbsolute(input.p) ? input.p : path.resolve(input.cwd, input.p);
    const parent = path.dirname(absolute);
    return path.join(realpathSync(parent), path.basename(absolute));
  } catch {
    return null;
  }
}

const GIT_CONTROL_FILE_NAMES = new Set(['.gitattributes', '.gitmodules']);

/**
 * True when a path has a component naming git control state: the `.git`
 * directory (any case, trailing dots or spaces, 8.3 aliases), `.gitattributes`
 * or `.gitmodules`. Writing these can make git run agent-chosen programs.
 */
export function isGitControlPath(p: string): boolean {
  return p.split(/[\\/]+/u).some(component => {
    const name = component.replace(/[. ]+$/u, '').toLowerCase();
    return name === '.git' || /^(git|gitmod|gitatt)~\d+$/u.test(name) || GIT_CONTROL_FILE_NAMES.has(name);
  });
}

/**
 * True when a write target is, or resolves through symlinks to, git control
 * state. Checks the path as written and its resolved identities (parent
 * directory, and the final component when it already exists).
 */
export function writeTargetTouchesGitControl(input: { p: string; cwd: string }): boolean {
  if (isGitControlPath(input.p)) {
    return true;
  }
  const identities = [canonicalWriteTarget(input), canonicalFileIdentity(input)];
  return identities.some(identity => identity !== null && isGitControlPath(identity)) || isDanglingSymlink(input);
}

/** A dangling symlink cannot be resolved, so its destination is unknown: fail closed. */
function isDanglingSymlink(input: { p: string; cwd: string }): boolean {
  const absolute = path.isAbsolute(input.p) ? input.p : path.resolve(input.cwd, input.p);
  try {
    return lstatSync(absolute).isSymbolicLink() && canonicalFileIdentity(input) === null;
  } catch {
    return false;
  }
}

/** sha256 of current file content. Null when the file cannot be read: fail closed. */
export function sha256FileContent(filePath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

/** True when the path resolves inside the workspace root (symlinks resolved). */
export function isInsideWorkspace(input: { p: string; cwd: string; workspace_root: string }): boolean {
  const identity = canonicalFileIdentity({ p: input.p, cwd: input.cwd });
  if (identity === null) {
    return false;
  }
  const root = (() => {
    try {
      return realpathSync(input.workspace_root);
    } catch {
      return null;
    }
  })();
  if (root === null) {
    return false;
  }
  return identity === root || identity.startsWith(`${root}${path.sep}`);
}

const INTERPRETERS = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'ksh',
  'python',
  'python3',
  'node',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'lua',
]);

/** Flags whose operand is inline code, not a file. */
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '--command']);

/**
 * Extract the executed file operand from a parsed argv: the first non-option
 * argument after the interpreter, respecting `--` end-of-options. A `-c`/`-e`
 * style operand is inline code, not a file, and yields undefined. Direct
 * execution (`./script.sh`) yields argv[0] itself when it names a file.
 */
export function extractExecutedFileOperand(input: { argv: readonly string[] }): string | undefined {
  const argv = skipWrapperPrefix(input.argv);
  const invoked = argv[0];
  if (invoked === undefined) {
    return undefined;
  }
  const base = path.basename(invoked);
  if (!INTERPRETERS.has(base) && !INTERPRETERS.has(invoked)) {
    // Not an interpreter invocation: direct execution names the file itself
    // when argv[0] looks like a path rather than a bare command name.
    return invoked.includes('/') ? invoked : undefined;
  }
  let seenDoubleDash = false;
  for (const token of argv.slice(1)) {
    if (!seenDoubleDash && token === '--') {
      seenDoubleDash = true;
      continue;
    }
    if (!seenDoubleDash && token.startsWith('-') && token !== '-') {
      if (INLINE_CODE_FLAGS.has(token)) {
        return undefined;
      }
      continue;
    }
    return token;
  }
  return undefined;
}

/**
 * Skip wrapper prefixes and their arguments for operand extraction: `env`
 * with `VAR=val` assignments and options, `nice` with optional `-n`, `timeout`
 * with its duration. Unlisted wrappers are never allowlisted.
 */
export function skipWrapperPrefix(argv: readonly string[]): readonly string[] {
  let rest = argv;
  for (;;) {
    const head = rest[0];
    if (head === undefined) {
      return rest;
    }
    const base = path.basename(head);
    if (base === 'nice') {
      rest = rest.slice(1);
      const flag = rest[0];
      // `nice -n 10 cmd` / `nice -10 cmd`: skip the adjustment argument.
      rest = rest.slice(flag !== undefined && /^-n|^-\d+$/.test(flag) ? (flag === '-n' ? 2 : 1) : 0);
      continue;
    }
    if (base === 'env') {
      let index = 1;
      while (index < rest.length) {
        const token = rest[index];
        if (
          token === undefined ||
          (token !== '--' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && !token.startsWith('-'))
        ) {
          break;
        }
        index += 1;
      }
      rest = rest.slice(index);
      continue;
    }
    if (base === 'timeout') {
      // `timeout <duration> [options] cmd`: skip duration and flags.
      let index = 1;
      const duration = rest[index];
      if (duration !== undefined && !duration.startsWith('-')) {
        index += 1;
      }
      while (index < rest.length && (rest[index]?.startsWith('-') ?? false)) {
        index += 1;
      }
      rest = rest.slice(index);
      continue;
    }
    return rest;
  }
}

/**
 * Lenient quote-aware word splitter for compound commands the strict parser
 * rejects. Best-effort only: used to find script operands and `rm` targets in
 * Tier 3 commands for the tracked-set checks.
 */
export function splitWordsLenient(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let hasCurrent = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = (): void => {
    if (hasCurrent) {
      words.push(current);
      current = '';
      hasCurrent = false;
    }
  };
  for (const ch of command) {
    if (escaped) {
      current += ch;
      hasCurrent = true;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
        hasCurrent = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasCurrent = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      push();
      continue;
    }
    current += ch;
    hasCurrent = true;
  }
  push();
  return words;
}

/**
 * Split a shell command into segments by `;`, `&&`, `||`, `|`, and newlines.
 * Respects single/double quotes and backslash escapes, so separators inside
 * quoted arguments do not split. Every segment of a compound command is
 * scanned for tracked executed operands and hashed.
 */
export function splitCompoundSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const pushSegment = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
    current = '';
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      current += ch;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    // Check for two-character operators first
    if ((ch === '&' || ch === '|') && i + 1 < command.length && command[i + 1] === ch) {
      pushSegment();
      i++; // skip the second character
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      pushSegment();
      continue;
    }
    current += ch;
  }
  pushSegment();
  return segments;
}

const FILE_CREATION_COMMANDS: Record<string, 'all_operands' | 'last_operand'> = {
  touch: 'all_operands',
  cp: 'last_operand',
  mv: 'last_operand',
  ln: 'last_operand',
  install: 'last_operand',
};

/**
 * Best-effort observation of files an agent shell command may have created or
 * modified: redirect targets (`>`/`>>`) and creation-verb operands
 * (touch/cp/mv/ln/install; `ln` hardlink counts as creation). Covers the
 * workspace; the caller resolves each candidate against the cwd.
 */
export function observeShellCreatedFiles(input: { command: string }): string[] {
  const words = splitWordsLenient(input.command);
  const created: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === undefined) {
      continue;
    }
    if ((word === '>' || word === '>>') && i + 1 < words.length) {
      const target = words[i + 1];
      if (target !== undefined && target !== '/dev/null') {
        created.push(target);
      }
      i += 1;
      continue;
    }
    const base = path.basename(word);
    const mode = FILE_CREATION_COMMANDS[base];
    if (mode === undefined) {
      continue;
    }
    // Collect the operand run until the next shell operator or command word.
    const operands: string[] = [];
    let seenDoubleDash = false;
    for (let j = i + 1; j < words.length; j += 1) {
      const token = words[j];
      if (token === undefined || ['|', '&&', '||', ';', '>', '>>', '<'].includes(token)) {
        break;
      }
      if (!seenDoubleDash && token === '--') {
        seenDoubleDash = true;
        continue;
      }
      if (!seenDoubleDash && token.startsWith('-') && token !== '-') {
        continue;
      }
      operands.push(token);
    }
    if (mode === 'all_operands') {
      created.push(...operands);
    } else if (operands.length > 0) {
      const last = operands[operands.length - 1];
      if (last !== undefined) {
        created.push(last);
      }
    }
  }
  return created;
}
