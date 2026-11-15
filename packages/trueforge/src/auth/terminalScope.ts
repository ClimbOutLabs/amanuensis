/**
 * The chat scope of a paired terminal key, enforced at the auth layer for every route
 * the key reaches. A terminal key may use chats and what hangs off them (sessions,
 * turns and their streaming, approvals answered inside a turn, plan grants, recall
 * exclusions), search its own chats, and revoke its own key. Everything else, admin
 * and settings routes above all, refuses it. The list is an allowlist on purpose: a
 * route added later is out of scope until it is named here.
 *
 * Two routes sit under the sessions prefix without being chat, and are carved out
 * below: the session repository routes, whose start-work handler clones a repository
 * with the person's GitHub token, and the sandbox file download, which hands out
 * files from a turn's sandbox. Neither is something a paired terminal was promised.
 */
const TERMINAL_KEY_PATH_PREFIXES = ['/api/v1/sessions', '/api/v1/user/chat-search'] as const;

/** Exact paths a terminal key may reach outside the prefixes: revoking its own key at logout. */
const TERMINAL_KEY_EXACT_PATHS = ['/api/v1/terminal-pairings/revoke-current'] as const;

/** Said to a terminal key that reaches outside its scope; it names the one thing to do instead. */
export const TERMINAL_KEY_SCOPE_MESSAGE =
  'A paired terminal can only reach chats. Open Aman on the web to use this part of Aman.';

/**
 * True when a path under the sessions prefix is one of the carved-out routes: the
 * repository binding of a session (the segments below the prefix are the session id,
 * then `repository`), or a turn's sandbox file download (the session id, then
 * `turns`, the turn id, then `download-sandbox-file`).
 */
function sessionPathIsCarvedOut(path: string, prefix: string): boolean {
  const segments = path
    .slice(prefix.length)
    .split('/')
    .filter(segment => segment !== '');
  if (segments[1] === 'repository') {
    return true;
  }
  return segments[1] === 'turns' && segments[3] === 'download-sandbox-file';
}

/** True when a request path is inside the chat scope of a paired terminal key. */
export function terminalKeyMayReachPath(path: string): boolean {
  if ((TERMINAL_KEY_EXACT_PATHS as readonly string[]).includes(path)) {
    return true;
  }
  const prefix = TERMINAL_KEY_PATH_PREFIXES.find(candidate => path === candidate || path.startsWith(`${candidate}/`));
  if (prefix === undefined) {
    return false;
  }
  return prefix !== '/api/v1/sessions' || !sessionPathIsCarvedOut(path, prefix);
}
