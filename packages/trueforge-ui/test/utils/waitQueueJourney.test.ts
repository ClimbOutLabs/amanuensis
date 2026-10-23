import { describe, expect, it } from 'vitest';

import { parseToolNotDoneReason } from '@/utils/toolCallParsing.js';
import {
  arrivalSignature,
  buildLongWaitAnnouncement,
  buildLongWaitNote,
  COMPACTING_LINE,
  countWords,
  deriveWaitQueue,
  LONG_WAIT_MS,
  type WaitQueueInput,
  type WaitQueuePart,
} from '@/utils/waitQueueJourney.js';

function part(overrides: Partial<WaitQueuePart> & Pick<WaitQueuePart, 'type'>): WaitQueuePart {
  return { statusType: 'running', ...overrides };
}

function input(overrides: Partial<WaitQueueInput> = {}): WaitQueueInput {
  return {
    isRunning: true,
    parts: [],
    memory: { available: false, landed: false },
    ...overrides,
  };
}

function stationState(snapshot: ReturnType<typeof deriveWaitQueue>, id: string) {
  return snapshot.stations.find(station => station.id === id)?.state;
}

describe('deriveWaitQueue', () => {
  it('starts a fresh turn at Listening with nothing claimed', () => {
    const snapshot = deriveWaitQueue(input());

    expect(snapshot.activeStation).toBe('listening');
    expect(stationState(snapshot, 'listening')).toBe('active');
    expect(stationState(snapshot, 'doing')).toBe('pending');
    expect(stationState(snapshot, 'writing')).toBe('pending');
    // No memory provider: the Remembering station is omitted, not faked.
    expect(snapshot.stations.some(station => station.id === 'remembering')).toBe(false);
    expect(snapshot.microcopy).toBe('On it…');
    expect(snapshot.ticks).toEqual([]);
  });

  it('shows Remembering as pending while the recall event has not landed', () => {
    const snapshot = deriveWaitQueue(input({ memory: { available: true, landed: false } }));

    expect(snapshot.stations.some(station => station.id === 'remembering')).toBe(true);
    expect(stationState(snapshot, 'remembering')).toBe('pending');
    // The queue never claims recall is running: no input can make it active.
    expect(snapshot.activeStation).toBe('listening');
  });

  it('lands the Remembering station as a done tick when recall arrives', () => {
    const snapshot = deriveWaitQueue(input({ memory: { available: true, landed: true, items: 4, outcome: 'ok' } }));

    expect(stationState(snapshot, 'remembering')).toBe('done');
    expect(stationState(snapshot, 'listening')).toBe('done');
    expect(snapshot.activeStation).toBeNull();
    expect(snapshot.ticks).toEqual(['Found 4 memories']);
    expect(snapshot.microcopy).toBe('Thinking it through…');
  });

  it('ticks a singular memory and an empty recall honestly', () => {
    const singular = deriveWaitQueue(input({ memory: { available: true, landed: true, items: 1, outcome: 'ok' } }));
    expect(singular.ticks).toEqual(['Found 1 memory']);

    const empty = deriveWaitQueue(input({ memory: { available: true, landed: true, items: 0, outcome: 'empty' } }));
    expect(empty.ticks).toEqual(['Checked memories — nothing new']);
  });

  it('stays quiet on recall timeout — the context card owns that failure', () => {
    const snapshot = deriveWaitQueue(
      input({ memory: { available: true, landed: true, items: 0, outcome: 'timeout' } }),
    );

    expect(stationState(snapshot, 'remembering')).toBe('done');
    expect(snapshot.ticks).toEqual([]);
  });

  it('says the history is being tidied while compaction runs, and gives way once writing starts', () => {
    const compacting = deriveWaitQueue(input({ compacting: true }));
    expect(compacting.microcopy).toBe(COMPACTING_LINE);
    expect(
      buildLongWaitNote({
        elapsedMs: 125_000,
        activeStation: compacting.activeStation,
        microcopy: compacting.microcopy,
      }),
    ).toMatch(/^Still tidying up the conversation, /);
    expect(
      buildLongWaitAnnouncement({ activeStation: compacting.activeStation, microcopy: compacting.microcopy }),
    ).toBe('Still tidying up the conversation. This can take a few minutes.');

    const writing = deriveWaitQueue(input({ compacting: true, parts: [part({ type: 'text' })] }));
    expect(writing.microcopy).toBe('Writing…');
  });

  it('lights Writing when the first tokens stream', () => {
    const snapshot = deriveWaitQueue(input({ parts: [part({ type: 'text' })] }));

    expect(snapshot.activeStation).toBe('writing');
    expect(stationState(snapshot, 'writing')).toBe('active');
    expect(stationState(snapshot, 'listening')).toBe('done');
    expect(snapshot.microcopy).toBe('Writing…');
  });

  it('lights Doing and names the actual running tool', () => {
    const snapshot = deriveWaitQueue(input({ parts: [part({ type: 'tool-call', toolName: 'web_search' })] }));

    expect(snapshot.activeStation).toBe('doing');
    expect(stationState(snapshot, 'doing')).toBe('active');
    expect(snapshot.microcopy).toBe('Searching the web…');
  });

  it('humanizes unknown tool names instead of leaking raw identifiers', () => {
    const snapshot = deriveWaitQueue(
      input({ parts: [part({ type: 'tool-call', toolName: 'mcp__gmail__list_messages' })] }),
    );

    expect(snapshot.microcopy).toBe('List messages…');
  });

  it('names the inner tool for MCP meta-tools', () => {
    const snapshot = deriveWaitQueue(
      input({
        parts: [
          part({
            type: 'tool-call',
            toolName: 'call_tool',
            argsText: JSON.stringify({ mcp_server: 'gmail', tool_name: 'list_messages' }),
          }),
        ],
      }),
    );

    expect(snapshot.microcopy).toBe('Using List messages…');
  });

  it('never throws on non-string MCP args: model-crafted values fall back safely', () => {
    // parseMcpToolArgs casts without runtime validation and argsText is
    // model-generated; a hostile tool_name must not crash the render.
    const hostileArgs = [
      JSON.stringify({ tool_name: { evil: 1 } }),
      JSON.stringify({ tool_name: 123 }),
      JSON.stringify({ tool_name: true }),
      JSON.stringify({ mcp_server: ['x'] }),
      JSON.stringify({ mcp_server: '', tool_name: null }),
      'not json at all',
    ];

    for (const argsText of hostileArgs) {
      const snapshot = deriveWaitQueue(
        input({ parts: [part({ type: 'tool-call', toolName: 'call_tool', argsText })] }),
      );
      expect(snapshot.microcopy).toBe('Using tools…');
    }
  });

  it('never throws on non-string toolName: model-crafted values fall back safely', () => {
    // toolName is typed as a string but arrives over the model/runtime wire;
    // a non-string must degrade to the generic label, never throw mid-render.
    const hostileNames = [42, null, true, { evil: 1 }, ['x']];

    for (const toolName of hostileNames) {
      const running = deriveWaitQueue(
        input({ parts: [part({ type: 'tool-call', toolName: toolName as unknown as string })] }),
      );
      expect(running.microcopy).toBe('Working…');

      const settled = deriveWaitQueue(
        input({
          parts: [part({ type: 'tool-call', toolName: toolName as unknown as string, statusType: 'complete' })],
        }),
      );
      expect(settled.ticks).toEqual(['Finished Working']);
    }
  });

  it('renders an approval wait as a user-action state, not model waiting', () => {
    const snapshot = deriveWaitQueue(
      input({ parts: [part({ type: 'tool-call', toolName: 'exec', statusType: 'requires-action' })] }),
    );

    expect(snapshot.microcopy).toBe('Waiting for your approval…');
    // The parked tool never ran: Doing stays active, never done — stations
    // change only on real events.
    expect(stationState(snapshot, 'doing')).toBe('active');
    expect(snapshot.activeStation).toBe('doing');
    expect(snapshot.ticks).toEqual([]);
  });

  it('counts additional running tools without pretending to name them all', () => {
    const snapshot = deriveWaitQueue(
      input({
        parts: [
          part({ type: 'tool-call', toolName: 'read_file' }),
          part({ type: 'tool-call', toolName: 'exec' }),
          part({ type: 'tool-call', toolName: 'web_search' }),
        ],
      }),
    );

    expect(snapshot.microcopy).toBe('Reading · +2 more…');
  });

  it('ticks completed tools with file names from real args', () => {
    const snapshot = deriveWaitQueue(
      input({
        parts: [
          part({
            type: 'tool-call',
            toolName: 'read_file',
            statusType: 'complete',
            argsText: JSON.stringify({ path: '/repo/src/schema.sql' }),
          }),
        ],
      }),
    );

    expect(stationState(snapshot, 'doing')).toBe('done');
    expect(snapshot.ticks).toEqual(['Read schema.sql']);
    expect(snapshot.microcopy).toBe('Thinking it through…');
  });

  it('keeps Doing active while any tool still runs and caps ticks for pacing', () => {
    const snapshot = deriveWaitQueue(
      input({
        parts: [
          part({ type: 'tool-call', toolName: 'read_file', statusType: 'complete' }),
          part({ type: 'tool-call', toolName: 'exec', statusType: 'complete' }),
          part({ type: 'tool-call', toolName: 'web_search', statusType: 'complete' }),
          part({ type: 'tool-call', toolName: 'write_file', statusType: 'running' }),
        ],
      }),
    );

    expect(stationState(snapshot, 'doing')).toBe('active');
    expect(snapshot.microcopy).toBe('Editing files…');
    // Three completions, but the queue paces itself to the most recent two.
    expect(snapshot.ticks).toHaveLength(2);
    expect(snapshot.ticks).toEqual(['Ran a command', 'Searched the web']);
  });

  it('skips stations honestly when a tool-less turn finishes', () => {
    const snapshot = deriveWaitQueue({
      isRunning: false,
      parts: [part({ type: 'text', statusType: 'complete' })],
      memory: { available: true, landed: false },
    });

    expect(stationState(snapshot, 'listening')).toBe('done');
    expect(stationState(snapshot, 'remembering')).toBe('skipped');
    expect(stationState(snapshot, 'doing')).toBe('skipped');
    expect(stationState(snapshot, 'writing')).toBe('done');
    expect(snapshot.activeStation).toBeNull();
  });

  it('lets stations re-light when tools and text interleave', () => {
    const afterTools = deriveWaitQueue(
      input({
        parts: [
          part({ type: 'tool-call', toolName: 'read_file', statusType: 'complete' }),
          part({ type: 'text', statusType: 'complete' }),
          part({ type: 'tool-call', toolName: 'exec', statusType: 'running' }),
        ],
      }),
    );

    expect(stationState(afterTools, 'doing')).toBe('active');
    expect(stationState(afterTools, 'writing')).toBe('done');
    expect(afterTools.activeStation).toBe('doing');
  });

  it('never advances without a backing event: identical inputs, identical snapshots', () => {
    const cases: WaitQueueInput[] = [
      input(),
      input({ memory: { available: true, landed: false } }),
      input({ parts: [part({ type: 'tool-call', toolName: 'exec' })] }),
      input({
        parts: [part({ type: 'tool-call', toolName: 'exec', statusType: 'complete' })],
        memory: { available: true, landed: true, items: 2, outcome: 'ok' },
      }),
      input({ parts: [part({ type: 'text' })] }),
      { isRunning: false, parts: [], memory: { available: false, landed: false } },
    ];

    for (const turn of cases) {
      const first = deriveWaitQueue(turn);
      const second = deriveWaitQueue(turn);
      expect(second).toEqual(first);
      // And Remembering is never the active station: there is no "recall
      // running" signal, so claiming it would be fake progress.
      expect(first.activeStation).not.toBe('remembering');
    }
  });

  it('walks a scripted turn with each transition tied to an input delta', () => {
    const empty = input();
    const toolStarts = input({ parts: [part({ type: 'tool-call', toolName: 'read_file' })] });
    const toolDone = input({
      parts: [part({ type: 'tool-call', toolName: 'read_file', statusType: 'complete' })],
    });
    const writing = input({
      parts: [part({ type: 'tool-call', toolName: 'read_file', statusType: 'complete' }), part({ type: 'text' })],
    });

    const s0 = deriveWaitQueue(empty);
    expect(s0.activeStation).toBe('listening');

    const s1 = deriveWaitQueue(toolStarts);
    expect(s1.activeStation).toBe('doing');
    expect(s1.microcopy).toBe('Reading…');

    const s2 = deriveWaitQueue(toolDone);
    expect(s2.activeStation).toBeNull();
    expect(stationState(s2, 'doing')).toBe('done');
    expect(s2.ticks).toEqual(['Read files']);

    const s3 = deriveWaitQueue(writing);
    expect(s3.activeStation).toBe('writing');
    expect(s3.microcopy).toBe('Writing…');
  });
});

describe('long-wait show', () => {
  it('sets the threshold at fifteen seconds', () => {
    expect(LONG_WAIT_MS).toBe(15_000);
  });

  it('names the actual slow activity with elapsed time', () => {
    expect(buildLongWaitNote({ elapsedMs: 24_000, activeStation: 'doing', microcopy: 'Searching the web…' })).toBe(
      'Still searching the web — 24s so far.',
    );
  });

  it('is honest when nothing has arrived yet', () => {
    expect(buildLongWaitNote({ elapsedMs: 90_000, activeStation: 'listening', microcopy: 'On it…' })).toBe(
      'Still waiting for the first response — 1m 30s so far.',
    );
  });

  it('keeps the screen-reader announcement stable across timer ticks', () => {
    const first = buildLongWaitAnnouncement({ activeStation: 'doing', microcopy: 'Searching the web…' });
    const second = buildLongWaitAnnouncement({ activeStation: 'doing', microcopy: 'Searching the web…' });
    expect(first).toBe(second);
    expect(first).not.toMatch(/\d+s/);
    expect(first).toBe('Still searching the web — this is taking longer than usual.');
  });
});

/** A tool result envelope as the server writes it, for one disposition. */
function toolResult(outcome: Record<string, unknown>): string {
  return JSON.stringify({ schema_version: 'tool.response.v2', outcome, result: {} });
}

describe('refused and not-run tool calls in progress lines', () => {
  it('says a refused send_draft was not sent, using the owner line the chat shows', () => {
    const result = toolResult({
      disposition: 'policy_blocked',
      remediation: { suggested_action: 'contact_user', message: 'Sending mail needs your approval first.' },
    });
    const snapshot = deriveWaitQueue(
      input({
        parts: [
          part({
            type: 'tool-call',
            toolName: 'send_draft',
            statusType: 'complete',
            notDoneReason: parseToolNotDoneReason(result),
          }),
        ],
      }),
    );

    expect(snapshot.ticks).toEqual(['Not sent: Sending mail needs your approval first.']);
  });

  it('says a refused create_event was not done, and never shows it as finished', () => {
    const snapshot = deriveWaitQueue(
      input({
        parts: [
          part({
            type: 'tool-call',
            toolName: 'create_event',
            statusType: 'complete',
            notDoneReason: parseToolNotDoneReason(toolResult({ disposition: 'denied' })),
          }),
        ],
      }),
    );

    expect(snapshot.ticks).toEqual(['Not done: you said no']);
    expect(snapshot.ticks.some(tick => tick.startsWith('Finished'))).toBe(false);
  });

  it('keeps the normal tick for a call that ran', () => {
    const result = toolResult({ disposition: 'executed_ok' });
    expect(parseToolNotDoneReason(result)).toBeUndefined();
    const snapshot = deriveWaitQueue(
      input({ parts: [part({ type: 'tool-call', toolName: 'send_draft', statusType: 'complete' })] }),
    );

    expect(snapshot.ticks).toEqual(['Finished Send draft']);
  });
});

describe('reasoning in the wait line', () => {
  it('says "Reasoning…" with a live word count while reasoning streams', () => {
    const snapshot = deriveWaitQueue(input({ parts: [part({ type: 'reasoning', reasoningWords: 1240 })] }));

    expect(snapshot.microcopy).toBe('Reasoning… 1,240 words so far');
    expect(stationState(snapshot, 'listening')).toBe('done');
  });

  it('counts words across every reasoning part of the turn', () => {
    const snapshot = deriveWaitQueue(
      input({
        parts: [
          part({ type: 'reasoning', statusType: 'complete', reasoningWords: 300 }),
          part({ type: 'tool-call', toolName: 'web_search', statusType: 'complete' }),
          part({ type: 'reasoning', reasoningWords: 1 }),
        ],
      }),
    );

    expect(snapshot.microcopy).toBe('Reasoning… 301 words so far');
  });

  it('says "1 word" for a single word', () => {
    const snapshot = deriveWaitQueue(input({ parts: [part({ type: 'reasoning', reasoningWords: 1 })] }));

    expect(snapshot.microcopy).toBe('Reasoning… 1 word so far');
  });

  it('says just "Reasoning…" when the stream carries no reasoning text', () => {
    const snapshot = deriveWaitQueue(input({ parts: [part({ type: 'reasoning', reasoningWords: 0 })] }));

    expect(snapshot.microcopy).toBe('Reasoning…');
  });

  it('gives way to writing and to running tools', () => {
    const writing = deriveWaitQueue(
      input({ parts: [part({ type: 'reasoning', reasoningWords: 50 }), part({ type: 'text' })] }),
    );
    const tool = deriveWaitQueue(
      input({
        parts: [part({ type: 'reasoning', reasoningWords: 50 }), part({ type: 'tool-call', toolName: 'web_search' })],
      }),
    );

    expect(writing.microcopy).toBe('Writing…');
    expect(tool.microcopy).toBe('Searching the web…');
  });

  it('goes back to "Thinking it through…" once reasoning has finished', () => {
    const snapshot = deriveWaitQueue(
      input({ parts: [part({ type: 'reasoning', statusType: 'complete', reasoningWords: 80 })] }),
    );

    expect(snapshot.microcopy).toBe('Thinking it through…');
  });

  it('counts words the way a person would', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('Check the calendar,\nthen  reply.')).toBe(5);
  });
});

describe('arrivalSignature', () => {
  const memory = { available: true, landed: false };

  it('changes when more reasoning text arrives', () => {
    const before = arrivalSignature({ parts: [part({ type: 'reasoning', arrivedChars: 10 })], memory });
    const after = arrivalSignature({ parts: [part({ type: 'reasoning', arrivedChars: 42 })], memory });

    expect(after).not.toBe(before);
  });

  it('changes when a part finishes, a part appears, or memory lands', () => {
    const base = arrivalSignature({ parts: [part({ type: 'tool-call', arrivedChars: 2 })], memory });

    expect(
      arrivalSignature({ parts: [part({ type: 'tool-call', statusType: 'complete', arrivedChars: 3 })], memory }),
    ).not.toBe(base);
    expect(
      arrivalSignature({
        parts: [part({ type: 'tool-call', arrivedChars: 2 }), part({ type: 'text', arrivedChars: 1 })],
        memory,
      }),
    ).not.toBe(base);
    expect(
      arrivalSignature({ parts: [part({ type: 'tool-call', arrivedChars: 2 })], memory: { ...memory, landed: true } }),
    ).not.toBe(base);
  });

  it('stays the same when nothing new arrived', () => {
    const parts = [part({ type: 'reasoning', arrivedChars: 10 }), part({ type: 'indicator' })];

    expect(arrivalSignature({ parts, memory })).toBe(
      arrivalSignature({ parts: [part({ type: 'reasoning', arrivedChars: 10 })], memory }),
    );
  });
});
