import type { ContextMessage } from '../runtime/AgentThread.types';
import { isLLMContextMessage } from '../runtime/contextUtils';
import type { UnfinishedKind } from '../runtime/replyBudget';
import { envelopedResult, turnBoundaryIndex } from '../runtime/replyToolDumpRepair';
import { isRecord } from '../util/records';
import {
  CREATE_SPACE_TOOL_NAME,
  isSpaceWriteToolName,
  MOVE_SPACE_TOOL_NAME,
  SPACE_WRITE_NOTHING_SAVED_FIELD,
} from './toolContract';

/** What this turn's space writes did to one space. `changes` counts the saved writes, a creation included. */
export interface SpaceWrites {
  name: string;
  link: string;
  created: boolean;
  changes: number;
  last_failed: boolean;
}

function argumentSpaceName(args: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed)) {
      return undefined;
    }
    const name = parsed['space_name'] ?? parsed['name'];
    return typeof name === 'string' && name !== '' ? name : undefined;
  } catch {
    return undefined;
  }
}

/** A space write's result object, inside the tool response envelope or bare; undefined when it is not JSON. */
function spaceWriteResult(content: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? (envelopedResult(parsed) ?? parsed) : undefined;
}

/** True when a space write succeeded but saved nothing new, so it is neither a change nor progress. */
export function spaceWriteSavedNothing(content: string): boolean {
  return spaceWriteResult(content)?.[SPACE_WRITE_NOTHING_SAVED_FIELD] === true;
}

/** The spaces this turn's create, edit and restore calls reached, in the order they were first written. */
export function spaceWritesThisTurn(context: readonly ContextMessage[]): SpaceWrites[] {
  const boundary = turnBoundaryIndex(context);
  const calls = new Map<string, { tool: string; args: string }>();
  const writes = new Map<string, SpaceWrites>();
  for (let i = boundary + 1; i < context.length; i += 1) {
    const message = context[i];
    if (message === undefined || !isLLMContextMessage(message)) {
      continue;
    }
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        calls.set(call.id, { tool: call.function.name, args: call.function.arguments });
      }
      continue;
    }
    if (message.role !== 'tool') {
      continue;
    }
    const call = calls.get(message.tool_call_id);
    // Filing a space in a folder changes nothing in the space, so it is never reported as a saved change.
    if (call === undefined || call.tool === MOVE_SPACE_TOOL_NAME || !isSpaceWriteToolName(call.tool)) {
      continue;
    }
    const result = spaceWriteResult(message.content);
    const space = result === undefined ? undefined : result['space'];
    const name = isRecord(space) ? space['name'] : undefined;
    const link = isRecord(space) ? space['link'] : undefined;
    if (typeof name === 'string' && typeof link === 'string') {
      const earlier = writes.get(name);
      const savedNothing = result?.[SPACE_WRITE_NOTHING_SAVED_FIELD] === true;
      writes.set(name, {
        name,
        link,
        created: (earlier?.created ?? false) || call.tool === CREATE_SPACE_TOOL_NAME,
        changes: (earlier?.changes ?? 0) + (savedNothing ? 0 : 1),
        last_failed: false,
      });
      continue;
    }
    // A refused write names no space in its result, so the call's own arguments say which one it was for.
    const failedName = argumentSpaceName(call.args);
    const earlier = failedName === undefined ? undefined : writes.get(failedName);
    if (earlier !== undefined) {
      writes.set(earlier.name, { ...earlier, last_failed: true });
    }
  }
  // A space whose writes all saved nothing new has nothing to report.
  return [...writes.values()].filter(write => write.changes > 0);
}

function plural(count: number): string {
  return count === 1 ? '1 change' : `${String(count)} changes`;
}

/** A name is person-visible link text, so it cannot close the link or start another one. */
function safeSpaceName(name: string): string {
  return name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\[\]<]/g, match => `\\${match}`);
}

function spaceLinkText(write: SpaceWrites): string {
  return `[${safeSpaceName(write.name)}](${write.link})`;
}

function savedPart(write: SpaceWrites): string {
  if (!write.created) {
    return `saved ${plural(write.changes)} to the space ${spaceLinkText(write)}`;
  }
  return write.changes === 1
    ? `created the space ${spaceLinkText(write)}`
    : `created the space ${spaceLinkText(write)} and saved ${plural(write.changes - 1)} to it`;
}

/** The plain closing line for a reply that wrote spaces but never named them; empty when nothing was written. */
export function spaceClosingLine({
  writes,
  unfinished,
  noticeShown,
}: {
  writes: readonly SpaceWrites[];
  unfinished: UnfinishedKind | undefined;
  /** The reply already carries the host's own step-budget or failure notice, so the caveats would repeat it. */
  noticeShown: boolean;
}): string {
  if (writes.length === 0) {
    return '';
  }
  const parts = writes.map(savedPart);
  const [first = '', ...rest] = parts;
  const sentence = `I ${rest.length === 0 ? first : `${first}, and I ${rest.join(', and I ')}`}.`;
  const extra: string[] = [];
  if (!noticeShown) {
    const refused = writes.filter(write => write.last_failed);
    const [firstRefused] = refused;
    if (firstRefused !== undefined) {
      const subject = writes.length === 1 ? 'it' : refused.map(write => safeSpaceName(write.name)).join(' and ');
      extra.push(`My last change to ${subject} was refused, so the page may be incomplete. Ask me to finish it.`);
    }
    if (unfinished === 'budget') {
      extra.push('I stopped before the page was complete. Ask me to continue.');
    }
  }
  return [sentence, ...extra].join(' ');
}
