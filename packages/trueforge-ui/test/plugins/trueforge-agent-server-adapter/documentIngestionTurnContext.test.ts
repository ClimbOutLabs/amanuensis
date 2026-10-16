import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { listDocumentIngestionTurnContext } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';
import { createTrueForgeClient } from '@/plugins/trueforge-agent-server-adapter/client.js';

function ingestion(fileName: string, phase: 'started' | 'finished') {
  return {
    type: 'document.ingestion',
    id: `evt_${fileName}_${phase}`,
    created_at: '2026-08-03T00:00:00.000Z',
    thread_id: 'main',
    file_name: fileName,
    phase,
  };
}

describe('listDocumentIngestionTurnContext', () => {
  it('asks the server for document.ingestion events only and folds them per file', async () => {
    const requested: URL[] = [];
    const fetchMock: typeof fetch = async input => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      requested.push(url);
      return Response.json({
        data: [
          { turn_id: 'trn_1', event: ingestion('a.pdf', 'finished') },
          { turn_id: 'trn_1', event: ingestion('a.pdf', 'started') },
        ],
        pagination: { limit: 100 },
      });
    };

    const context = await listDocumentIngestionTurnContext(createTrueForgeClient({ fetch: fetchMock }), {
      sessionId: 'ses_1',
    });

    assert.deepEqual(
      requested.map(url => url.searchParams.getAll('types')),
      [['document.ingestion']],
    );
    assert.equal(context.length, 1);
    assert.equal(context[0]?.turnId, 'trn_1');
    assert.equal(context[0]?.files.length, 1);
  });
});
