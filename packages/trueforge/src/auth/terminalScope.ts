/**
 * The chat scope of a paired terminal key, enforced at the auth layer for every route
 * the key reaches. A terminal key may use chats and what hangs off them (sessions,
 * turns and their streaming, approvals answered inside a turn, plan grants, recall
 * exclusions), search its own chats, and revoke its own key. Everything else, admin
 * and settings routes above all, refuses it. The list is an allowlist on purpose: a
 * route added later is out of scope until it is named here.
 */
const TERMINAL_KEY_PATH_PREFIXES = ['/api/v1/sessions', '/api/v1/user/chat-search'] as const;

/** Exact paths a terminal key may reach outside the prefixes: revoking its own key at logout. */
const TERMINAL_KEY_EXACT_PATHS = ['/api/v1/terminal-pairings/revoke-current'] as const;

/** Said to a terminal key that reaches outside its scope; it names the one thing to do instead. */
export const TERMINAL_KEY_SCOPE_MESSAGE =
  'A paired terminal can only reach chats. Open Aman on the web to use this part of Aman.';

/** True when a request path is inside the chat scope of a paired terminal key. */
export function terminalKeyMayReachPath(path: string): boolean {
  if ((TERMINAL_KEY_EXACT_PATHS as readonly string[]).includes(path)) {
    return true;
  }
  return TERMINAL_KEY_PATH_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}
