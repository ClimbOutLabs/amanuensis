import { CodeModeDispatcher } from '../../../../src/core/sandbox/codeMode/CodeModeDispatcher';
import { plainDraft } from '../../email/gmail/fixtures';
import { APPROVED, build, json, route, type Route } from '../../email/gmail/harness';
import { makeSilentLogger } from '../../harnessMocks';

const COMPOSE = ['gmail_read', 'gmail_compose'] as const;

const SAVED = plainDraft({ id: 'd-m1', threadId: 't9', to: 'grace@example.com', subject: 'Lease', body: 'Thursday.' });

const draftStore: Route = url =>
  url.pathname === '/gmail/v1/users/me/drafts' ? json({ id: 'd7', message: { id: 'm7', threadId: 't7' } }) : undefined;

/** The writes to the mailbox among everything the tool set asked Google for. */
function writes(urls: readonly string[]): string[] {
  return urls.filter(url => url.includes('/gmail/') && !url.startsWith('GET '));
}

describe('sandbox code cannot save or change a Gmail draft', () => {
  it.each([
    ['a new draft', { name: 'draft_email', arguments: { to: ['grace@example.com'], subject: 'Hi', body: 'Hello.' } }],
    [
      'a change to a saved draft',
      {
        name: 'update_draft',
        arguments: { draft_id: 'd1', to: ['mallory@example.com'], subject: 'Lease', body: 'Send it here.' },
      },
    ],
  ])('saves nothing for %s that arrives over the Code Mode bridge', async (_label, call) => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [route('/drafts/d1', { id: 'd1', message: SAVED }), draftStore],
    });
    const dispatcher = new CodeModeDispatcher({ toolSets: [tools], logger: makeSilentLogger() });

    const reply = await dispatcher.dispatch({
      request: { op: 'call_tool', server: tools.name, tool: call.name, arguments: call.arguments },
      traceCarrier: {},
    });

    expect(JSON.stringify(reply)).toContain('was not approved, so nothing was saved');
    expect(writes(google.urls)).toEqual([]);
  });

  it('saves nothing for a draft call that reaches the tool set with no answer from the person', async () => {
    const { tools, google } = await build({ features: [...COMPOSE], routes: [draftStore] });
    await tools.callTool({
      name: 'draft_email',
      arguments: { to: ['grace@example.com'], subject: 'Hi', body: 'Hello.' },
    });
    expect(writes(google.urls)).toEqual([]);
  });

  it('still saves a draft the person said yes to', async () => {
    const { tools, google } = await build({ features: [...COMPOSE], routes: [draftStore] });
    await tools.callTool(
      { name: 'draft_email', arguments: { to: ['grace@example.com'], subject: 'Hi', body: 'Hello.' } },
      APPROVED,
    );
    expect(writes(google.urls)).toEqual(['POST /gmail/v1/users/me/drafts']);
  });
});
