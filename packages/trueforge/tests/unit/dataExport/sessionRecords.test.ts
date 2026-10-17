import { EventType } from '@truefoundry/trueforge-core/core';

import { makeModelMessageEvent } from '../../../../trueforge-core/tests/agent-session/testHelpers';
import { exportableEvents, withoutDeploymentBoundFields } from '../../../src/dataExport/sessionRecords';

describe('withoutDeploymentBoundFields', () => {
  it('removes approval token ids, sandbox info and OAuth links at any depth, keeping the rest', () => {
    const out = withoutDeploymentBoundFields({
      session_id: 's1',
      turns: [
        {
          snapshot: { sandbox_info: { sandbox_id: 'box' }, mcp_servers: null },
          context: [
            { role: 'assistant', tool_calls: [{ id: 'c1', approval_token_id: 'tok', function: { name: 'f' } }] },
          ],
        },
      ],
      events: [{ type: 'mcp.auth_required', mcp_servers: [{ id: 'a', name: 'n', auth_url: 'https://x/y?state=z' }] }],
    });
    expect(out).toEqual({
      session_id: 's1',
      turns: [
        {
          snapshot: { mcp_servers: null },
          context: [{ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'f' } }] }],
        },
      ],
      events: [{ type: 'mcp.auth_required', mcp_servers: [{ id: 'a', name: 'n' }] }],
    });
  });
});

describe('exportableEvents', () => {
  it('drops sandbox creation events and keeps every other event', () => {
    const message = makeModelMessageEvent();
    const sandbox = {
      type: EventType.SANDBOX_CREATED,
      id: 'evt',
      created_at: '2026-10-16T00:00:00.000Z',
      sandbox_id: 'box',
      thread_id: null,
    };
    expect(exportableEvents([message, sandbox])).toEqual([message]);
  });
});
