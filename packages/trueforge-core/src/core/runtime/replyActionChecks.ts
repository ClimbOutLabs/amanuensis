import type { InternalToolCallInfo } from '../llm/LLMTypes';
import {
  isHostVouchedRead,
  isReadOnlyCall,
  MAX_WRITE_CALLS_PER_TURN,
  type TurnStepKind,
} from '../mcp/executeToolCalls';
import {
  SANDBOX_APPLY_PATCH_TOOL_NAME,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_MCP_SERVER_ID,
  SANDBOX_REPLACE_TEXT_TOOL_NAME,
  SANDBOX_RUN_CODE_TOOL_NAME,
  SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
  SANDBOX_WRITE_FILE_TOOL_NAME,
} from '../sandbox/Sandbox';

/** Sent to the model when its reply carried a tool call as text, so that call did not run. */
export const TOOL_MARKUP_RETRY_MESSAGE =
  'That was written as text and did not run. If it is still needed, call the tool.';

/** Result text for a call whose exact action already ran or was refused in this turn. Not run. */
export const REPEATED_ACTION_RESULT =
  'This exact action already ran or was refused in this reply. Do not repeat it; tell the person what happened.';

/** What the person reads in place of a repeat the guard skipped. */
export const REPEATED_ACTION_OWNER_MESSAGE = 'Skipped, because I had already done this. Check the result above.';

/** Result text for a change past the per-turn cap. Not run; the turn ends after this batch. */
export const WRITE_CAP_BLOCKED_RESULT = `Not run: this reply already reached the limit of ${String(MAX_WRITE_CALLS_PER_TURN)} actions outside the sandbox workspace, such as sending or changing things in a connected app. Do not make more of them; tell the person what was done.`;

/** What the person reads in place of a change the write cap skipped. */
export const WRITE_CAP_OWNER_MESSAGE = `Skipped, because I had already done ${String(MAX_WRITE_CALLS_PER_TURN)} things outside the sandbox in one reply. Ask again for the rest.`;

/** Ends the turn, shown to the person, when the write cap stopped a call. */
export const WRITE_CAP_STOP_MESSAGE = `Stopped after ${String(MAX_WRITE_CALLS_PER_TURN)} actions outside the sandbox in one reply. Check what was done, then ask again if you need more.`;

/**
 * Whether a call counts toward the per-turn cap on changes. The cap is for actions that can reach
 * past the sandbox: a send, a connector write, a git push, a command on a sandbox with network.
 * Work its own server says stays in its workspace (staysInWorkspace) does not count, so a coding
 * task is not cut off part way. A read the host vouches for (a search, a page read, a map lookup)
 * never counts; a server's own read-only claim is not enough. A call held for the owner does not run now.
 */
export function countsTowardWriteCap(info: InternalToolCallInfo, input: { staysInWorkspace: boolean }): boolean {
  return info.tier === 3 && info.held_for_owner === undefined && !isHostVouchedRead(info) && !input.staysInWorkspace;
}

/**
 * Whether a call that ran changed something, so a different call made the same way may sensibly run
 * again (tests run again after a file edit, for example): any action the cap counts, and a sandbox
 * step whose effect is an edit, a commit or a push.
 */
export function changesState(info: InternalToolCallInfo, input: { countsTowardCap: boolean }): boolean {
  if (input.countsTowardCap) {
    return true;
  }
  return (
    info.mcp_server_name === SANDBOX_MCP_SERVER_ID &&
    (info.effect === 'edit' || info.effect === 'commit' || info.effect === 'push')
  );
}

const SANDBOX_FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  SANDBOX_WRITE_FILE_TOOL_NAME,
  SANDBOX_APPLY_PATCH_TOOL_NAME,
  SANDBOX_REPLACE_TEXT_TOOL_NAME,
]);

/** Whether a tool is one of the sandbox's own file tools, by its server and its tool name. */
export function isSandboxFileEditTool(input: { serverName: string; toolName: string }): boolean {
  return input.serverName === SANDBOX_MCP_SERVER_ID && SANDBOX_FILE_EDIT_TOOLS.has(input.toolName);
}

/** Ends the turn, shown to the person, when the model kept sending tool calls that were blocked before they ran. */
export function blockedCallsStopMessage(assistantName: string): string {
  return `${assistantName} kept sending a request in a form the tool cannot take, so this reply stopped. Ask again in other words.`;
}

/** Ends the turn, shown to the person, when the model's reasoning kept going in circles. */
export function repetitionStopMessage(assistantName: string): string {
  return `${assistantName} was going in circles while thinking, so this reply stopped. Ask again in smaller parts.`;
}

/** The same stop for a helper, read by the model that started it. */
export const BLOCKED_CALLS_PARENT_MESSAGE =
  'The helper kept sending a request in a form the tool cannot take, so it stopped. Do not send it the same task again. Try another way, or tell the person what could not be done.';

/** The kinds of done-work a reply can claim, each backed by a different kind of step. */
export type UnbackedClaimKind = 'clone' | 'run' | 'read' | 'workspace' | 'change';

const SANDBOX_COMMAND_TOOLS: ReadonlySet<string> = new Set([
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_RUN_CODE_TOOL_NAME,
  SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
]);

/** Connector tools that clone or download, as opposed to ones that only search or list repositories. */
const GIT_TOOL_NAME = /clone|download/i;

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
  if (isReadOnlyCall(info) && !CLOCK_AND_HOST_HELPERS.has(name) && READ_TOOL_NAME.test(name)) {
    kinds.push('read');
  }
  return kinds;
}

const ADVERB = String.raw`(?:just\s+|now\s+|already\s+|successfully\s+)?`;
/** "I cloned", "I've cloned", "I have just cloned". */
const FIRST_PERSON = String.raw`\bI(?:['’]ve|\s+have)?\s+${ADVERB}`;
/** "I've run", "I have run": "run" is a claim only as a perfect, since "I run" is present or an offer. */
const FIRST_PERSON_PERFECT = String.raw`\bI(?:['’]ve|\s+have)\s+${ADVERB}`;
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
    patterns: [
      ...claim(String.raw`executed`),
      new RegExp(`${FIRST_PERSON_PERFECT}run\\b`, 'i'),
      new RegExp(`${PASSIVE}run\\b`, 'i'),
      new RegExp(`${FIRST_PERSON}ran\\b(?!\\s+into\\b)`, 'i'),
    ],
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

/** Naming the workspace or sandbox as a place is a claim that something is there. */
const WORKSPACE_PLACES: readonly RegExp[] = [
  /\b(?:in|into|inside|to)\s+(?:your|the)\s+(?:workspace|sandbox)\b/i,
  /\byour\s+(?:workspace|sandbox)\s+(?:now\s+|already\s+)?(?:has|contains|holds)\b/i,
];
/** "The repo is checked out". */
const CHECKED_OUT_STATE = /\b(?:is|are)\s+(?:now\s+)?checked\s+out\b/i;
/** Words that make a clause an offer or a condition rather than a report. */
const NOT_YET = /\b(?:if|once|when|after|before|until|unless|would|could|can|will|shall|should|might|want)\b|['’]ll\b/i;

/** Words that, earlier in the sentence, turn a claim into a denial: "No repository was cloned". */
const NEGATION = /\b(?:no|not|nothing|never|none)\b|n['’]t\b/i;

const QUESTION_END = /\?["'”’)\]]*\s*$/;

/**
 * Whether the sentence reports the match as done. A question is never a report, and neither is a
 * match whose clause (from the last comma before it) opens as an offer or condition, so "When you
 * asked, I cloned it" still counts. A denial anywhere before the match cancels it.
 */
function affirms(pattern: RegExp, sentence: string): boolean {
  if (QUESTION_END.test(sentence)) {
    return false;
  }
  const match = pattern.exec(sentence);
  if (match === null) {
    return false;
  }
  const before = sentence.slice(0, match.index);
  const clause = before.slice(before.lastIndexOf(',') + 1);
  return !NEGATION.test(before) && !NOT_YET.test(clause);
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter(sentence => sentence.trim() !== '');
}

function claimedKinds(text: string): Set<UnbackedClaimKind> {
  const kinds = new Set<UnbackedClaimKind>();
  for (const sentence of sentencesOf(text)) {
    for (const { kind, patterns } of CLAIMS) {
      if (patterns.some(pattern => affirms(pattern, sentence))) {
        kinds.add(kind);
      }
    }
    if ([...WORKSPACE_PLACES, CHECKED_OUT_STATE].some(pattern => affirms(pattern, sentence))) {
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
