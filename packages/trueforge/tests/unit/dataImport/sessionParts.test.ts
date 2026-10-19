import { z } from 'zod';

import { DataImportError } from '../../../src/dataImport/importError';
import type { ImportSessionPartRecord } from '../../../src/dataImport/importSchemas';
import { ImportSessionPartRecordSchema } from '../../../src/dataImport/importSchemas';
import { assembleSessionParts } from '../../../src/dataImport/sessionParts';

const NOW = '2026-10-16T10:00:00.000Z';

function sessionRecord(sessionId: string): unknown {
  return {
    kind: 'session',
    session: {
      session_id: sessionId,
      tenant_id: 'default',
      created_by_subject: { subject_id: 'owner', subject_type: 'user', subject_display_name: 'owner' },
      agent: { type: 'reference', id: 'agent-1', name: 'helper' },
      title: 'A chat',
      folder_id: null,
      external_id: null,
      source: null,
      metadata: {},
      custom: null,
      task_checklist: { items: [], revision: 0 },
      metrics: { total_turns: 2, total_duration_ms: 0 },
      repository_id: null,
      workspace_cwd: null,
      last_turn_id: null,
      created_at: NOW,
      updated_at: NOW,
      last_activity_timestamp_ms: 0,
    },
    persona_activations: [],
  };
}

function turnRecord(input: { sessionId: string; turnId: string; base: number; added: string[] }): unknown {
  return {
    kind: 'turn',
    turn: {
      turn_id: input.turnId,
      session_id: input.sessionId,
      first_turn_id: input.turnId,
      ancestor_ids: [],
      previous_turn_id: null,
      state: { status: 'done', output: null, required_actions: [], completed_at: NOW },
      input: [],
      custom: null,
      created_at: NOW,
      updated_at: NOW,
      snapshot: {
        threads: {
          main: {
            thread_id: 'main',
            context_base: input.base,
            context: input.added.map(content => ({ role: 'user', content })),
            current_context_usage: { prompt_tokens: 1, completion_tokens: 1 },
          },
        },
      },
    },
    events: [],
    artifacts: [],
  };
}

function records(raw: unknown[]): ImportSessionPartRecord[] {
  return z.array(ImportSessionPartRecordSchema).parse(raw);
}

describe('assembleSessionParts', () => {
  it('rebuilds each turn from the previous one, sharing the messages it kept', () => {
    const [entry] = [
      ...assembleSessionParts(
        records([
          sessionRecord('chat-1'),
          turnRecord({ sessionId: 'chat-1', turnId: 'turn-1', base: 0, added: ['one', 'two'] }),
          turnRecord({ sessionId: 'chat-1', turnId: 'turn-2', base: 1, added: ['three'] }),
        ]),
      ),
    ];
    const contexts = entry?.turns.map(({ turn }) => turn.snapshot.threads['main']?.context ?? []);
    expect(contexts?.map(context => context.map(message => ('content' in message ? message.content : '')))).toEqual([
      ['one', 'two'],
      ['one', 'three'],
    ]);
    expect(contexts?.[1]?.[0]).toBe(contexts?.[0]?.[0]);
  });

  it('refuses a turn that builds on messages the chat does not have', () => {
    const run = () => [
      ...assembleSessionParts(
        records([sessionRecord('chat-1'), turnRecord({ sessionId: 'chat-1', turnId: 'turn-1', base: 3, added: [] })]),
      ),
    ];
    expect(run).toThrow(DataImportError);
    expect(run).toThrow('turn turn-1 in chat chat-1 builds on messages that are not in it.');
  });

  it('refuses a turn that is not listed after its own chat', () => {
    const run = () => [
      ...assembleSessionParts(
        records([sessionRecord('chat-1'), turnRecord({ sessionId: 'chat-2', turnId: 'turn-1', base: 0, added: [] })]),
      ),
    ];
    expect(run).toThrow('turn turn-1 is not listed after its chat chat-2.');
  });
});
