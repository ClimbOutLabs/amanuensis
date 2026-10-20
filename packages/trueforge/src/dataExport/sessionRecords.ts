/**
 * Session data as the export writes it: stored records minus fields that are
 * live pointers into this deployment (approval tokens, sandbox handles, OAuth
 * links) and mean nothing, or leak access, anywhere else.
 */
import type { PersistedTurnEvent, TurnSnapshot } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/core';

/** Keys removed wherever they appear in a session, its turns, snapshots and events. */
const DEPLOYMENT_BOUND_KEYS: ReadonlySet<string> = new Set(['approval_token_id', 'sandbox_info', 'auth_url']);

/** Plain JSON copy of `value` without the deployment-bound keys. */
export function withoutDeploymentBoundFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutDeploymentBoundFields);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!DEPLOYMENT_BOUND_KEYS.has(key)) {
        out[key] = withoutDeploymentBoundFields(entry);
      }
    }
    return out;
  }
  return value;
}

/** Sandbox creation events only announce a provider handle, so they are left out entirely. */
export function exportableEvents(events: readonly PersistedTurnEvent[]): PersistedTurnEvent[] {
  return events.filter(event => event.type !== EventType.SANDBOX_CREATED);
}

/** Chat records are spread over numbered files, so no one file outgrows the per-file limit. */
export function sessionPartName(index: number): string {
  return `sessions/${String(index).padStart(4, '0')}.json`;
}

/** The number of a `sessions/0001.json` style name; undefined for any other name. */
export function sessionPartIndex(name: string): number | undefined {
  const match = /^sessions\/(\d{4,})\.json$/.exec(name);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

type ThreadSnapshot = TurnSnapshot['threads'][string];

/** A thread as a turn record carries it: the messages after the first `context_base` of the previous record's copy. */
export type ExportedThread = Pick<
  ThreadSnapshot,
  'thread_id' | 'current_context_usage' | 'parent' | 'agent_info' | 'completion' | 'task_state'
> & { context_base: number; context: ThreadSnapshot['context'] };

function sharedPrefixLength({
  previous,
  next,
}: {
  previous: ThreadSnapshot['context'];
  next: ThreadSnapshot['context'];
}): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit && JSON.stringify(previous[index]) === JSON.stringify(next[index])) {
    index += 1;
  }
  return index;
}

/**
 * The store rebuilds every turn's snapshot with the whole conversation so far, so writing each
 * one in full grows with the square of a chat's length. Each thread keeps only what is new since
 * the previous turn. Server init info, capability state and the tool-call memo are runtime
 * bookkeeping that import never restores, so they are left out.
 */
export function exportedThreads({
  snapshot,
  previous,
}: {
  snapshot: TurnSnapshot;
  previous: TurnSnapshot | undefined;
}): Record<string, ExportedThread> {
  const threads: Record<string, ExportedThread> = {};
  for (const [threadId, thread] of Object.entries(snapshot.threads)) {
    const before = previous?.threads[threadId]?.context ?? [];
    const base = sharedPrefixLength({ previous: before, next: thread.context });
    threads[threadId] = {
      thread_id: thread.thread_id,
      context_base: base,
      context: thread.context.slice(base),
      current_context_usage: thread.current_context_usage,
      parent: thread.parent,
      agent_info: thread.agent_info,
      completion: thread.completion,
      task_state: thread.task_state,
    };
  }
  return threads;
}
