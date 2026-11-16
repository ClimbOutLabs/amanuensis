/**
 * The chat scope of a paired terminal key, path by path. The sessions prefix carries
 * more than chats: the repository binding can clone a repository with the person's
 * GitHub token, the sandbox file download hands out files from a turn's sandbox, and
 * the bug report, audit log, recall exclusions, privacy read and turn artifact list
 * are diagnostics, memory controls and settings-shaped reads rather than chat. All
 * of them stay closed to a terminal key even though they sit under the sessions
 * prefix. Everyone and everything here is made up.
 */
import { terminalKeyMayReachPath } from '../../../src/auth/terminalScope';

describe('terminal key scope', () => {
  it('reaches chats, turns, streaming, plan grants and chat search', () => {
    const allowed = [
      '/api/v1/sessions',
      '/api/v1/sessions/sess-1',
      '/api/v1/sessions/sess-1/turns',
      '/api/v1/sessions/sess-1/turns/turn-1',
      '/api/v1/sessions/sess-1/turns/turn-1/events',
      '/api/v1/sessions/sess-1/turns/turn-1/subscribe',
      '/api/v1/sessions/sess-1/implementation-plan-grants',
      '/api/v1/sessions/sess-1/implementation-plan-grants/grant-1',
      '/api/v1/user/chat-search',
      '/api/v1/terminal-pairings/revoke-current',
    ];
    for (const path of allowed) {
      expect(terminalKeyMayReachPath(path)).toBe(true);
    }
  });

  it('cannot reach the session repository routes under the sessions prefix', () => {
    const refused = [
      '/api/v1/sessions/sess-1/repository',
      '/api/v1/sessions/sess-1/repository/start-work',
      '/api/v1/sessions/sess-1/repository/github-repositories',
      '/api/v1/sessions/sess-1/repository/github-repository',
    ];
    for (const path of refused) {
      expect(terminalKeyMayReachPath(path)).toBe(false);
    }
  });

  it('cannot download a sandbox file from a turn or list a turn artifact files', () => {
    expect(terminalKeyMayReachPath('/api/v1/sessions/sess-1/turns/turn-1/download-sandbox-file')).toBe(false);
    expect(terminalKeyMayReachPath('/api/v1/sessions/sess-1/turns/turn-1/artifacts')).toBe(false);
  });

  it('cannot reach the sessions routes that are not chat', () => {
    const refused = [
      '/api/v1/sessions/sess-1/bug-report',
      '/api/v1/sessions/sess-1/audit-log',
      '/api/v1/sessions/sess-1/recall-exclusions',
      '/api/v1/sessions/sess-1/privacy',
    ];
    for (const path of refused) {
      expect(terminalKeyMayReachPath(path)).toBe(false);
    }
  });

  it('still reaches a chat whose own id reads like a subresource name', () => {
    expect(terminalKeyMayReachPath('/api/v1/sessions/repository')).toBe(true);
    expect(terminalKeyMayReachPath('/api/v1/sessions/repository/turns')).toBe(true);
  });

  it('refuses everything outside the chat scope', () => {
    const refused = [
      '/api/v1/models',
      '/api/v1/settings/terminal-keys',
      '/api/v1/settings/model-providers',
      '/api/v1/auth/me',
      '/api/v1/sessions-other',
      '/api/v1/user/chat-search-extra',
      '/api/v1/terminal-pairings',
      '/api/v1/terminal-pairings/confirm',
    ];
    for (const path of refused) {
      expect(terminalKeyMayReachPath(path)).toBe(false);
    }
  });
});
