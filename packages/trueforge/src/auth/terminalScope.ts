/**
 * The chat scope of a paired terminal key, enforced at the auth layer for every route
 * the key reaches. A terminal key may use chats and what hangs off them (sessions,
 * turns and their streaming, approvals answered inside a turn, plan grants), search
 * its own chats, and revoke its own key. Everything else, admin and settings routes
 * above all, refuses it. The list is an allowlist on purpose: a route added later is
 * out of scope until it is named here.
 *
 * Some routes sit under the sessions prefix without being chat, and are carved out
 * below: the session repository routes, whose start-work handler clones a repository
 * with the person's GitHub token; the sandbox file download, which hands out files
 * from a turn's sandbox; the bug-report bundle, which packs up diagnostics about a
 * session; the session audit log read; the session privacy read; the recall
 * exclusions write, which changes what memory recall may surface; and the turn
 * artifact list, which names a turn's persisted files. None of them is something a
 * paired terminal was promised, and a stolen key must not reach them. The route
 * enumeration test in tests/unit/auth/terminalScopeRoutes.test.ts pins every route
 * under the prefix to one side or the other, so a new route cannot join this scope
 * by falling under the prefix unnoticed.
 */
const TERMINAL_KEY_PATH_PREFIXES = ['/api/v1/sessions', '/api/v1/user/chat-search'] as const;

/** Exact paths a terminal key may reach outside the prefixes: revoking its own key at logout. */
const TERMINAL_KEY_EXACT_PATHS: readonly string[] = ['/api/v1/terminal-pairings/revoke-current'];

/** Said to a terminal key that reaches outside its scope; it names the one thing to do instead. */
export const TERMINAL_KEY_SCOPE_MESSAGE =
  'A paired terminal can only reach chats. Open Aman on the web to use this part of Aman.';

/** The session-level routes under the prefix that are not chat, named by the segment after the session id. */
const CARVED_OUT_SESSION_SEGMENTS: ReadonlySet<string> = new Set([
  'repository',
  'bug-report',
  'audit-log',
  'recall-exclusions',
  'privacy',
]);

/** The turn-level routes under the prefix that are not chat, named by the segment after the turn id. */
const CARVED_OUT_TURN_SEGMENTS: ReadonlySet<string> = new Set(['download-sandbox-file', 'artifacts']);

/**
 * True when a path under the sessions prefix is one of the carved-out routes: a
 * session-level route named in {@link CARVED_OUT_SESSION_SEGMENTS} (the segments
 * below the prefix are the session id, then the route's name), or a turn-level
 * route named in {@link CARVED_OUT_TURN_SEGMENTS} (the session id, then `turns`,
 * the turn id, then the route's name).
 */
function sessionPathIsCarvedOut(path: string, prefix: string): boolean {
  const segments = path
    .slice(prefix.length)
    .split('/')
    .filter(segment => segment !== '');
  const sessionSegment = segments[1];
  if (sessionSegment !== undefined && CARVED_OUT_SESSION_SEGMENTS.has(sessionSegment)) {
    return true;
  }
  const turnSegment = segments[3];
  return segments[1] === 'turns' && turnSegment !== undefined && CARVED_OUT_TURN_SEGMENTS.has(turnSegment);
}

/** True when a request path is inside the chat scope of a paired terminal key. */
export function terminalKeyMayReachPath(path: string): boolean {
  if (TERMINAL_KEY_EXACT_PATHS.includes(path)) {
    return true;
  }
  const prefix = TERMINAL_KEY_PATH_PREFIXES.find(candidate => path === candidate || path.startsWith(`${candidate}/`));
  if (prefix === undefined) {
    return false;
  }
  return prefix !== '/api/v1/sessions' || !sessionPathIsCarvedOut(path, prefix);
}
