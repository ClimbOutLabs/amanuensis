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

/** One complete "key": "value" string pair in JSON text; a cut-off tail never completes a pair. */
const COMPLETE_STRING_PAIR = /"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/g;

function decodeJsonString(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(`"${raw}"`);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The target values named by complete pairs in argument text that is not finished JSON (a call
 * cut off mid-write). A pair whose value was itself cut off never closes, so it is not read as
 * a target the call did not finish naming.
 */
function partialTargetOf(argsText: string): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const match of argsText.matchAll(COMPLETE_STRING_PAIR)) {
    const key = match[1] === undefined ? undefined : decodeJsonString(match[1]);
    const value = match[2] === undefined ? undefined : decodeJsonString(match[2]);
    if (key !== undefined && TARGET_KEY.test(key) && value !== undefined && value.trim() !== '') {
      targets.add(value.trim().toLowerCase());
    }
  }
  return targets;
}

/**
 * What a call is about, as the text it names it by. Undefined when its arguments do not name a
 * target: either a finished object with no target field, or a call cut off mid-write before it
 * finished naming one.
 */
function targetOf(part: StepPart): ReadonlySet<string> | undefined {
  const args = argumentsOf(part);
  if (args !== undefined) {
    return new Set(
      Object.entries(args).flatMap(([key, value]) =>
        TARGET_KEY.test(key) && typeof value === 'string' && value.trim() !== '' ? [value.trim().toLowerCase()] : [],
      ),
    );
  }
  if (typeof part.argsText !== 'string') return undefined;
  const partial = partialTargetOf(part.argsText);
  return partial.size > 0 ? partial : undefined;
}

/**
 * True when a later call did the same job: the same tool, finished, about the same thing. A call
 * whose target cannot be told (cut off before it finished naming one) is answered by nothing:
 * with several calls to one tool in a reply, a finished call about one thing must not stand in
 * for a failed call about another.
 */
function answeredBy({ failed, later }: { failed: ToolStepPart; later: ToolStepPart }): boolean {
  if (failed.toolName === undefined || failed.toolName !== later.toolName || !isFinished(later)) return false;
  const failedTarget = targetOf(failed);
  if (failedTarget === undefined) return false;
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
