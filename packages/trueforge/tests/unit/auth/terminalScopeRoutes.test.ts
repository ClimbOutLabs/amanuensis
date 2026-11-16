/**
 * The guard on the terminal key scope: every route mounted under the sessions
 * prefix is enumerated from the route modules themselves and classified here, so a
 * route added under the prefix later cannot join the terminal scope silently. It
 * fails until the new route is named in the classification below and, when it is
 * not chat, carved out of the scope. Everyone and everything here is made up.
 */
import { terminalKeyMayReachPath } from '../../../src/auth/terminalScope';
import * as personaRoutes from '../../../src/routes/personaRoutes';
import * as recallExclusionRoutes from '../../../src/routes/recallExclusionRoutes';
import * as repositoryRoutes from '../../../src/routes/repositoryRoutes';
import * as sessionFolderRoutes from '../../../src/routes/sessionFolderRoutes';
import * as sessionRoutes from '../../../src/routes/sessionRoutes';
import * as turnRoutes from '../../../src/routes/turnRoutes';

const SESSIONS_PREFIX = '/api/v1/sessions';

/**
 * Whether a terminal key may reach each route under the sessions prefix, by path
 * template. Chat, its turns and streaming, plan grants, chat organization and the
 * persona that answers a chat are in scope. The repository binding, the sandbox
 * file download and the turn artifact list hand out files or act outside the chat,
 * and the bug report, the audit log, the recall exclusions and the privacy read
 * are diagnostics, memory controls and settings-shaped reads: out of scope.
 */
const CLASSIFICATION: Record<string, boolean> = {
  '/': true,
  '/get-or-create-by-external-id': true,
  '/{session_id}': true,
  '/{session_id}/cancel': true,
  '/{session_id}/events': true,
  '/{session_id}/turns': true,
  '/{session_id}/turns/{turn_id}': true,
  '/{session_id}/turns/{turn_id}/events': true,
  '/{session_id}/turns/{turn_id}/subscribe': true,
  '/{session_id}/implementation-plan-grants': true,
  '/{session_id}/implementation-plan-grants/{grant_id}': true,
  '/{session_id}/folder': true,
  '/{session_id}/persona': true,
  '/{session_id}/persona-activations': true,
  '/{session_id}/repository': false,
  '/{session_id}/repository/github-repositories': false,
  '/{session_id}/repository/github-repository': false,
  '/{session_id}/repository/start-work': false,
  '/{session_id}/turns/{turn_id}/download-sandbox-file': false,
  '/{session_id}/turns/{turn_id}/artifacts': false,
  '/{session_id}/bug-report': false,
  '/{session_id}/audit-log': false,
  '/{session_id}/recall-exclusions': false,
  '/{session_id}/privacy': false,
};

interface RouteShape {
  method: string;
  path: string;
}

function isRouteShape(value: unknown): value is RouteShape {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate: { method?: unknown; path?: unknown } = value;
  return typeof candidate.method === 'string' && typeof candidate.path === 'string';
}

/** Every route a module declares, whatever it exports them as. */
function routesOf(moduleNamespace: Record<string, unknown>): RouteShape[] {
  return Object.values(moduleNamespace).filter(isRouteShape);
}

/** A concrete path for a template, with made-up ids in place of the parameters. */
function samplePath(template: string): string {
  const filled = template
    .replaceAll('{session_id}', 'sess-1')
    .replaceAll('{turn_id}', 'turn-1')
    .replaceAll('{grant_id}', 'grant-1')
    .replaceAll('{folder_id}', 'folder-1')
    .replaceAll('{persona_id}', 'persona-1')
    .replaceAll('{repository_id}', 'repo-1');
  return filled === '/' ? SESSIONS_PREFIX : `${SESSIONS_PREFIX}${filled}`;
}

describe('terminal key scope over the sessions routes as declared', () => {
  const enumerated: { template: string; method: string }[] = [
    ...routesOf(sessionRoutes),
    ...routesOf(turnRoutes),
    ...routesOf(recallExclusionRoutes),
    // These modules also declare routes for other mounts; only the session-scoped
    // ones (their paths open with the session id) belong to this prefix.
    ...routesOf(sessionFolderRoutes).filter(route => route.path.startsWith('/{session_id}')),
    ...routesOf(personaRoutes).filter(route => route.path.startsWith('/{session_id}')),
    ...routesOf(repositoryRoutes).filter(route => route.path.startsWith('/{session_id}')),
  ].map(route => ({ template: route.path, method: route.method }));

  it('enumerates the sessions routes from their modules', () => {
    // A floor, so an import gone quiet cannot make the guard pass over nothing.
    expect(enumerated.length).toBeGreaterThanOrEqual(30);
  });

  it('classifies every enumerated route, and the scope matches the classification', () => {
    for (const route of enumerated) {
      const expected = CLASSIFICATION[route.template];
      if (expected === undefined) {
        throw new Error(
          `Route ${route.method.toUpperCase()} ${route.template} is mounted under the sessions prefix but is not classified for terminal keys. ` +
            'Name it in CLASSIFICATION in this test, and carve it out of terminalScope.ts when it is not chat.',
        );
      }
      expect(terminalKeyMayReachPath(samplePath(route.template))).toBe(expected);
    }
  });

  it('classifies no route that does not exist', () => {
    const templates = new Set(enumerated.map(route => route.template));
    for (const template of Object.keys(CLASSIFICATION)) {
      expect(templates.has(template)).toBe(true);
    }
  });
});
