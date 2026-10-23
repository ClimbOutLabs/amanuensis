import type { InternalToolCallInfo } from '../llm/LLMTypes';
import { MAX_WRITE_CALLS_PER_TURN, type TurnStepKind } from '../mcp/executeToolCalls';
import {
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_MCP_SERVER_ID,
  SANDBOX_RUN_CODE_TOOL_NAME,
  SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
} from '../sandbox/Sandbox';
import { isSafeToRepeat } from './OpenToolCallCloser';

/** Sent to the model when its reply carried a tool call as text, so that call did not run. */
export const TOOL_MARKUP_RETRY_MESSAGE =
  'That was written as text and did not run. If it is still needed, call the tool.';

/** Result text for a call whose exact action already ran or was refused in this turn. Not run. */
export const REPEATED_ACTION_RESULT =
  'This exact action already ran or was refused in this reply. Do not repeat it; tell the person what happened.';

/** Result text for a write call past the per-turn cap. Not run; the turn ends after this batch. */
export const WRITE_CAP_BLOCKED_RESULT = `Not run: this reply already made the maximum of ${String(MAX_WRITE_CALLS_PER_TURN)} changes. Do not make more changes; tell the person what was changed.`;

/** Ends the turn, shown to the person, when the write cap stopped a call. */
export const WRITE_CAP_STOP_MESSAGE = `Stopped after ${String(MAX_WRITE_CALLS_PER_TURN)} changes in one reply to avoid repeats. Check what was changed, then ask again if you need more.`;

/** The kinds of done-work a reply can claim, each backed by a different kind of step. */
export type UnbackedClaimKind = 'clone' | 'run' | 'read' | 'workspace' | 'change';

const SANDBOX_COMMAND_TOOLS: ReadonlySet<string> = new Set([
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_RUN_CODE_TOOL_NAME,
  SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
]);

/** Connector tools that fetch a repository or its files. */
const GIT_TOOL_NAME = /git|clone|repo/i;

/** Read-only tools that read a file, page, message, or record, as opposed to helpers like the clock. */
const READ_TOOL_NAME = /read|fetch|get_|list|search|open|view|browse|scrape|file|content|page|document|repo|git/i;

const CLOCK_AND_HOST_HELPERS: ReadonlySet<string> = new Set(['get_current_datetime', 'load_bundle']);

/** What a call that ran and succeeded can back. A sandbox step can read and fetch, so it backs those too. */
export function stepKindsOf(info: InternalToolCallInfo): TurnStepKind[] {
  const name = info.original_tool_name;
  if (info.mcp_server_name === SANDBOX_MCP_SERVER_ID) {
    return SANDBOX_COMMAND_TOOLS.has(name) ? ['sandbox', 'command', 'read'] : ['sandbox'];
  }
  const kinds: TurnStepKind[] = [];
  if (GIT_TOOL_NAME.test(name)) {
    kinds.push('git');
  }
  if (isSafeToRepeat(info) && !CLOCK_AND_HOST_HELPERS.has(name) && READ_TOOL_NAME.test(name)) {
    kinds.push('read');
  }
  return kinds;
}

const ADVERB = String.raw`(?:just\s+|now\s+|already\s+|successfully\s+)?`;
/** "I cloned", "I've cloned", "I have just cloned". */
const FIRST_PERSON = String.raw`\bI(?:['’]ve|\s+have)?\s+${ADVERB}`;
/** "has been cloned", "was cloned", "were downloaded". */
const PASSIVE = String.raw`\b(?:(?:has|have)\s+${ADVERB}been|was|were)\s+${ADVERB}`;

function claim(verbs: string): RegExp[] {
  return [new RegExp(`${FIRST_PERSON}(?:${verbs})\\b`, 'i'), new RegExp(`${PASSIVE}(?:${verbs})\\b`, 'i')];
}

/**
 * Done-work claims, by kind. Only past or finished forms count, so an offer ("I can clone it") or a
 * negation ("I haven't run it") never matches. A false match only adds a note.
 */
const CLAIMS: readonly { kind: Exclude<UnbackedClaimKind, 'workspace'>; patterns: readonly RegExp[] }[] = [
  {
    kind: 'clone',
    patterns: claim(
      String.raw`cloned|downloaded|pulled\s+down|checked\s+out\s+(?:\S+\s+){0,2}?(?:repo|repository|branch|code|project)`,
    ),
  },
  {
    kind: 'run',
    patterns: [...claim(String.raw`executed|run`), new RegExp(`${FIRST_PERSON}ran\\b(?!\\s+into\\b)`, 'i')],
  },
  {
    kind: 'read',
    patterns: claim(String.raw`read(?!\s+(?:it|this|that)\s+as\b)|looked\s+(?:at|through|over|into)|opened`),
  },
  {
    kind: 'change',
    patterns: [
      /\bI(?:['’]ve|\s+have)?\s+(?:just\s+)?(?:created|set|sent|saved|added|scheduled)\b/i,
      /\bhas\s+been\s+(?:created|set|sent|saved|added|scheduled)\b/i,
    ],
  },
];

const WORKSPACE_PLACE = /\b(?:in|into|inside|to)\s+(?:your|the)\s+(?:workspace|sandbox)\b/i;
/** "It is now in your workspace", "the repo is checked out". */
const DONE_STATE = /\b(?:is|are)\s+(?:now\s+)?(?:in|inside|checked\s+out)\b/i;
/** Words that make a state sentence an offer or a condition rather than a report. */
const NOT_YET = /\b(?:if|once|when|after|until|unless|would|could|can|will|should|might)\b|['’]ll\b/i;

/** Words that, earlier in the sentence, turn a claim into a denial: "No repository was cloned". */
const NEGATION = /\b(?:no|not|nothing|never|none)\b|n['’]t\b/i;

function affirms(pattern: RegExp, sentence: string): boolean {
  const match = pattern.exec(sentence);
  return match !== null && !NEGATION.test(sentence.slice(0, match.index));
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter(sentence => sentence.trim() !== '');
}

function claimedKinds(text: string): Set<UnbackedClaimKind> {
  const kinds = new Set<UnbackedClaimKind>();
  for (const sentence of sentencesOf(text)) {
    let claimsDoneWork = false;
    for (const { kind, patterns } of CLAIMS) {
      if (patterns.some(pattern => affirms(pattern, sentence))) {
        kinds.add(kind);
        claimsDoneWork = true;
      }
    }
    const statesDone = affirms(DONE_STATE, sentence) && !NOT_YET.test(sentence);
    const checkedOut = /\bchecked\s+out\b/i.test(sentence);
    if ((WORKSPACE_PLACE.test(sentence) || checkedOut) && (claimsDoneWork || statesDone)) {
      kinds.add('workspace');
    }
  }
  return kinds;
}

/** Most specific first: the note names the one claim the person most needs corrected. */
const NOTE_ORDER: readonly UnbackedClaimKind[] = ['clone', 'run', 'read', 'workspace', 'change'];

/**
 * The first claim in a final reply that no step in its turn backs, or undefined. A clone needs a
 * sandbox or git step, a run needs a sandbox command, a read needs a read tool, and a change needs
 * a write. A workspace claim is only checked with the sandbox off, where nothing can be in one.
 */
export function findUnbackedClaim({
  text,
  successfulWrites,
  stepKinds,
  sandboxOn,
}: {
  text: string;
  successfulWrites: number;
  stepKinds: ReadonlySet<TurnStepKind>;
  sandboxOn: boolean;
}): UnbackedClaimKind | undefined {
  const backed: Record<UnbackedClaimKind, boolean> = {
    clone: stepKinds.has('sandbox') || stepKinds.has('git'),
    run: stepKinds.has('command'),
    read: stepKinds.has('read'),
    workspace: sandboxOn,
    change: successfulWrites > 0,
  };
  const claimed = claimedKinds(text);
  return NOTE_ORDER.find(kind => claimed.has(kind) && !backed[kind]);
}
