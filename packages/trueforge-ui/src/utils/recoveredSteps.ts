import { isRecord } from '@truefoundry/trueforge-core/core/util/records';

import { parseToolRefusalNotice, parseToolResultDisposition, toolCallDisposition } from './toolCallParsing.js';

/** The slice of a tool-call part these checks read; a sub-agent's nested messages hold more of them. */
export type StepPart = {
  readonly type: string;
  readonly toolCallId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly args?: unknown;
  readonly argsText?: string | undefined;
  readonly result?: unknown;
  readonly status?: { readonly type: string } | undefined;
  readonly approval?: { readonly approved?: boolean | undefined } | undefined;
  readonly messages?: readonly { readonly content: readonly StepPart[] }[] | undefined;
};

type ToolStepPart = StepPart & { readonly type: 'tool-call'; readonly toolCallId: string };

function isToolStep(part: StepPart): part is ToolStepPart {
  return part.type === 'tool-call' && part.toolCallId !== undefined;
}

/** A step that ended in an error: its result says so, or the runtime marked it incomplete. */
export function toolStepErrored(part: StepPart): boolean {
  if (part.type !== 'tool-call') return false;
  if (part.status?.type === 'incomplete') return true;
  return parseToolResultDisposition(part.result)?.tone === 'error';
}

/** A step that ran into trouble: it failed, was blocked or denied, did not run, or its outcome is unknown. */
export function toolStepUnfinished(part: StepPart): boolean {
  if (part.type !== 'tool-call') return false;
  if (toolStepErrored(part)) return true;
  const disposition = toolCallDisposition(part);
  return disposition !== undefined && disposition.disposition !== 'executed_ok';
}

function isFinished(part: StepPart): boolean {
  return toolCallDisposition(part)?.disposition === 'executed_ok';
}

/** Argument names that say which thing a call is about: `id`, `name`, and any `*_id` or `*_name`. */
const TARGET_KEY = /^(id|name|.+_id|.+_name)$/;

function argumentsOf(part: StepPart): Record<string, unknown> | undefined {
  if (typeof part.argsText === 'string') {
    try {
      const parsed: unknown = JSON.parse(part.argsText);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(part.args) ? part.args : undefined;
}

/**
 * What a call is about, as the text it names it by. Undefined when its arguments are not a finished
 * JSON object (a call cut off mid-write), so what it was about cannot be told.
 */
function targetOf(part: StepPart): ReadonlySet<string> | undefined {
  const args = argumentsOf(part);
  if (args === undefined) return undefined;
  return new Set(
    Object.entries(args).flatMap(([key, value]) =>
      TARGET_KEY.test(key) && typeof value === 'string' && value.trim() !== '' ? [value.trim().toLowerCase()] : [],
    ),
  );
}

/**
 * True when a later call did the same job: the same tool, finished, about the same thing. A call that
 * was cut off cannot say what it was about, so any later finished call of that tool answers it; a
 * call that did name its target is answered only by one that names the same target.
 */
function answeredBy({ failed, later }: { failed: ToolStepPart; later: ToolStepPart }): boolean {
  if (failed.toolName === undefined || failed.toolName !== later.toolName || !isFinished(later)) return false;
  const failedTarget = targetOf(failed);
  if (failedTarget === undefined) return true;
  const laterTarget = targetOf(later);
  return laterTarget !== undefined && [...failedTarget].some(name => laterTarget.has(name));
}

/** Every tool call in these parts, sub-agent threads included, in the order they were made. */
function toolStepsInOrder(parts: readonly StepPart[]): ToolStepPart[] {
  return parts.flatMap(part =>
    isToolStep(part) ? [part, ...toolStepsInOrder((part.messages ?? []).flatMap(message => message.content))] : [],
  );
}

/**
 * The calls that did not finish but were done again, later in the same reply, by a call that did.
 * They stay visible under Agent details; nothing about them is the person's to act on.
 */
export function recoveredToolCallIds(parts: readonly StepPart[]): ReadonlySet<string> {
  const steps = toolStepsInOrder(parts);
  const recovered = new Set<string>();
  steps.forEach((failed, index) => {
    if (!toolStepUnfinished(failed)) return;
    if (steps.slice(index + 1).some(later => answeredBy({ failed, later }))) {
      recovered.add(failed.toolCallId);
    }
  });
  return recovered;
}

/**
 * The plain lines the host wrote for calls that are still undone, each said once, grouped under the
 * top-level call that owns them (a sub-agent's own calls belong to its call). Recovered calls say nothing.
 */
export function stepNoticesByCallId({
  parts,
  recovered,
}: {
  parts: readonly StepPart[];
  recovered: ReadonlySet<string>;
}): ReadonlyMap<string, readonly string[]> {
  const said = new Set<string>();
  const byCall = new Map<string, string[]>();
  const visit = ({ current, ownerId }: { current: readonly StepPart[]; ownerId: string | undefined }): void => {
    for (const part of current) {
      if (!isToolStep(part)) continue;
      const owner = ownerId ?? part.toolCallId;
      const notice = recovered.has(part.toolCallId) ? undefined : parseToolRefusalNotice(part.result);
      if (notice !== undefined && !said.has(notice)) {
        said.add(notice);
        byCall.set(owner, [...(byCall.get(owner) ?? []), notice]);
      }
      for (const message of part.messages ?? []) {
        visit({ current: message.content, ownerId: owner });
      }
    }
  };
  visit({ current: parts, ownerId: undefined });
  return byCall;
}
