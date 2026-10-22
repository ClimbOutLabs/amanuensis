/**
 * Which threads a continuation rebuilds. A turn paused for approval is stored as `done` with its
 * pending actions, so a sub-agent that is waiting on one must come back, or its answer has no thread.
 */
import { threadIdsForCurrentTurn, type ThreadSelectionTurn } from '../../src/agent-session/SessionHandle';

const RUNNING_WITH_CHILD: ThreadSelectionTurn = {
  state: { status: 'running' },
  snapshot: { threads: { main: {}, 'child-1': {} } },
};

function pausedTurn(waitingOn: Array<string | null>): ThreadSelectionTurn {
  return {
    state: {
      status: 'done',
      required_actions: waitingOn.map(thread_id => ({ thread_id })),
    },
    snapshot: { threads: { main: {}, 'child-1': {}, 'child-2': {} } },
  };
}

describe('threadIdsForCurrentTurn', () => {
  it('starts with the main thread when there is no previous turn', () => {
    expect(threadIdsForCurrentTurn(undefined)).toEqual(['main']);
  });

  it('rebuilds every thread of a running turn', () => {
    expect(threadIdsForCurrentTurn(RUNNING_WITH_CHILD)).toEqual(['main', 'child-1']);
  });

  it('rebuilds a sub-agent whose approval paused the turn', () => {
    expect(threadIdsForCurrentTurn(pausedTurn(['child-1']))).toEqual(['main', 'child-1']);
  });

  it('keeps main alone when a paused turn waits on no sub-agent', () => {
    expect(threadIdsForCurrentTurn(pausedTurn(['main']))).toEqual(['main']);
  });

  it('does not resume a terminal child that has no pending action', () => {
    expect(threadIdsForCurrentTurn(pausedTurn(['child-1']))).not.toContain('child-2');
  });

  it('ignores a pending action that names no thread', () => {
    expect(threadIdsForCurrentTurn(pausedTurn([null]))).toEqual(['main']);
  });

  it('keeps main alone after a cancelled or failed turn', () => {
    const cancelled: ThreadSelectionTurn = { state: { status: 'cancelled' }, snapshot: RUNNING_WITH_CHILD.snapshot };
    expect(threadIdsForCurrentTurn(cancelled)).toEqual(['main']);
  });
});
