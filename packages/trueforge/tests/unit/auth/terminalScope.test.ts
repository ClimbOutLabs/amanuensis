/**
 * The chat scope of a paired terminal key, path by path. The sessions prefix carries
 * more than chats: the repository binding can clone a repository with the person's
 * GitHub token, and the sandbox file download hands out files from a turn's sandbox.
 * Neither is chat, so both stay closed to a terminal key even though they sit under
 * the sessions prefix. Everyone and everything here is made up.
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
      '/api/v1/sessions/sess-1/turns/turn-1/artifacts',
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

  it('cannot download a sandbox file from a turn', () => {
    expect(terminalKeyMayReachPath('/api/v1/sessions/sess-1/turns/turn-1/download-sandbox-file')).toBe(false);
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
