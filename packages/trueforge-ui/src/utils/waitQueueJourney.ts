import { formatDuration, parseMcpToolArgs } from './toolCallParsing.js';

/**
 * The wait queue: a turn's journey rendered as winding stations, Disneyland-queue
 * style. Stations light up ONLY from real events (message parts, memory-recall
 * landings) — a station never advances without a backing event, so the queue can
 * never fake progress. Pure derivation: same input always yields the same
 * snapshot, which is what makes the no-fake-progress guarantee testable.
 */

/** Stations on the queue, in journey order. */
export type WaitStationId = 'listening' | 'remembering' | 'doing' | 'writing';

/**
 * Sprite states for the turn-status panda. Wider than the station ids:
 * found-memories shows when recall lands before any part, and still-writing
 * shows when writing passes the long-wait threshold.
 */
export type TurnSpriteId = 'listening' | 'remembering' | 'found-memories' | 'doing' | 'writing' | 'still-writing';

export type WaitStationState = 'pending' | 'active' | 'done' | 'skipped';

export const WAIT_STATION_LABELS: Record<WaitStationId, string> = {
  listening: 'Listening',
  remembering: 'Remembering',
  doing: 'Doing',
  writing: 'Writing',
};

/** Elapsed wait after which the queue adds an honest "still working" note. */
export const LONG_WAIT_MS = 15_000;

/** Staged-reveal ticks stay paced: only the most recent few are shown. */
const MAX_TICKS = 2;

export type WaitQueuePartStatus = 'running' | 'complete' | 'incomplete' | 'requires-action';

export type WaitQueuePart = {
  type: string;
  statusType: WaitQueuePartStatus;
  toolName?: string | undefined;
  argsText?: string | undefined;
};

export type WaitQueueMemory = {
  /** False when the host exposes no memory-recall provider: the station is omitted. */
  available: boolean;
  /** True once this turn's recall event has landed (via the turn-context poll). */
  landed: boolean;
  items?: number | undefined;
  outcome?: string | undefined;
};

export type WaitQueueInput = {
  isRunning: boolean;
  parts: ReadonlyArray<WaitQueuePart>;
  memory: WaitQueueMemory;
};

export type WaitStation = {
  id: WaitStationId;
  label: string;
  state: WaitStationState;
};

export type WaitQueueSnapshot = {
  stations: WaitStation[];
  activeStation: WaitStationId | null;
  /**
   * True when this turn's recall landed with items and no tool or text part
   * exists yet: the found-memories sprite's moment. Goes false once the first
   * part appears, so a late recall never claims the sprite mid-turn.
   */
  recallJustLanded: boolean;
  /** The line under the queue — always tied to a real event, never invented. */
  microcopy: string;
  /** Quiet completion ticks, oldest first, capped for pacing. */
  ticks: string[];
};

const SEARCH_TOOLS = new Set(['web_search', 'search', 'google_search', 'brave_search', 'tavily_search']);
const READ_TOOLS = new Set(['read_file', 'read', 'open_file', 'cat']);
const EDIT_TOOLS = new Set(['write_file', 'apply_patch', 'replace_text', 'edit_file']);
const EXEC_TOOLS = new Set(['exec', 'sandbox_exec', 'run_command', 'shell', 'run_registered_command']);

const TOOL_LABELS: Record<string, string> = {
  web_search: 'Searching the web',
  search: 'Searching the web',
  google_search: 'Searching the web',
  brave_search: 'Searching the web',
  read_file: 'Reading',
  read: 'Reading',
  open_file: 'Reading',
  write_file: 'Editing files',
  apply_patch: 'Editing files',
  replace_text: 'Editing files',
  edit_file: 'Editing files',
  exec: 'Running a command',
  sandbox_exec: 'Running a command',
  run_command: 'Running a command',
  shell: 'Running a command',
  run_registered_command: 'Running a command',
  create_sub_agent: 'Consulting a helper',
  ask_user_question: 'Asking a question',
};

/** Microcopy stays compact no matter what the model puts in a tool name. */
const MAX_LABEL_CHARS = 64;

/**
 * `toolName` is typed as a string but arrives over the model/runtime wire, so a
 * non-string value must degrade to the generic label rather than throwing
 * inside `humanizeToolName` mid-render (which would unmount the chat).
 */
function safeToolName(part: WaitQueuePart): string {
  return typeof part.toolName === 'string' ? part.toolName : '';
}

/** Prettifies a raw tool name without inventing meaning: `list_dir` → `List dir`. */
function humanizeToolName(toolName: string): string {
  const lastSegment = toolName.split('__').pop() ?? toolName;
  const words = lastSegment.replace(/[_-]+/g, ' ').trim();
  if (!words) return 'Working';
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return titled.length > MAX_LABEL_CHARS ? `${titled.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…` : titled;
}

function toolLabel(part: WaitQueuePart): string {
  const name = safeToolName(part);
  const direct = TOOL_LABELS[name];
  if (direct !== undefined) return direct;
  if (name === 'call_tool' || name === 'list_tools' || name === 'get_tool_info') {
    const { innerToolName, mcpServer } = parseMcpToolArgs(part.argsText);
    // parseMcpToolArgs casts without runtime validation and argsText is
    // model-generated: only trust string values here, never call string
    // methods on whatever JSON happened to parse (a non-string tool_name
    // would otherwise throw mid-render and unmount the chat).
    if (typeof innerToolName === 'string' && innerToolName !== '') return `Using ${humanizeToolName(innerToolName)}`;
    if (typeof mcpServer === 'string' && mcpServer !== '') return `Using ${humanizeToolName(mcpServer)} tools`;
    return 'Using tools';
  }
  return humanizeToolName(name);
}

/** Best-effort file basename from tool args; undefined unless the args parse cleanly. */
function fileFromArgs(argsText: string | undefined): string | undefined {
  if (!argsText) return undefined;
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const path: unknown = 'path' in parsed ? parsed.path : undefined;
    if (typeof path !== 'string' || !path) return undefined;
    const base = path.split(/[\\/]/).pop() ?? '';
    return base || undefined;
  } catch {
    return undefined;
  }
}

/** One quiet staged-reveal tick for a finished tool call, e.g. `Read schema.sql`. */
function toolTick(part: WaitQueuePart): string {
  const name = safeToolName(part);
  const file = fileFromArgs(part.argsText);
  if (EDIT_TOOLS.has(name)) return file ? `Updated ${file}` : 'Updated files';
  if (READ_TOOLS.has(name)) return file ? `Read ${file}` : 'Read files';
  if (SEARCH_TOOLS.has(name)) return 'Searched the web';
  if (EXEC_TOOLS.has(name)) return 'Ran a command';
  if (name === 'create_sub_agent') return 'Consulted a helper';
  return `Finished ${humanizeToolName(name)}`;
}

/**
 * The memory tick when recall lands mid-turn. Timeout/error outcomes surface in
 * the memory context card with a retry — the queue stays calm and says nothing
 * rather than announcing a failure it cannot explain.
 */
function memoryTick(memory: WaitQueueMemory): string | undefined {
  if (!memory.landed) return undefined;
  if (memory.outcome === 'ok' || memory.outcome === undefined) {
    const items = Math.max(0, Math.floor(memory.items ?? 0));
    if (items > 0) return `Found ${String(items)} ${items === 1 ? 'memory' : 'memories'}`;
    return 'Checked memories';
  }
  if (memory.outcome === 'empty') return 'Checked memories — nothing new';
  return undefined;
}

export function deriveWaitQueue(input: WaitQueueInput): WaitQueueSnapshot {
  const { isRunning, parts, memory } = input;
  // The `indicator` pseudo-part is the queue's own mount point, not turn activity.
  const substantive = parts.filter(part => part.type !== 'indicator');
  const textParts = substantive.filter(part => part.type === 'text');
  const toolParts = substantive.filter(part => part.type === 'tool-call');

  const textStreaming = textParts.some(part => part.statusType === 'running');
  const runningTools = toolParts.filter(part => part.statusType === 'running');
  const settledTools = toolParts.filter(part => part.statusType === 'complete' || part.statusType === 'incomplete');

  const anythingHappened = substantive.length > 0 || memory.landed;

  // An approval wait is a user-action state, not model waiting: the
  // requires-action part is a real signal, so the queue names it instead of
  // falling through to model-waiting copy like "Thinking it through…".
  const awaitingApproval = substantive.some(part => part.statusType === 'requires-action');

  const listening: WaitStationState = anythingHappened ? 'done' : isRunning ? 'active' : 'pending';

  const stations: WaitStation[] = [{ id: 'listening', label: WAIT_STATION_LABELS.listening, state: listening }];
  if (memory.available) {
    stations.push({
      id: 'remembering',
      label: WAIT_STATION_LABELS.remembering,
      state: memory.landed ? 'done' : isRunning ? 'pending' : 'skipped',
    });
  }
  // A turn parked on user approval never completed its tool work: Doing stays
  // `active` until the user decides. Marking it `done` would claim completion
  // for work that never ran.
  const doing: WaitStationState = awaitingApproval
    ? 'active'
    : runningTools.length > 0
      ? 'active'
      : toolParts.length > 0
        ? 'done'
        : isRunning
          ? 'pending'
          : 'skipped';
  stations.push({ id: 'doing', label: WAIT_STATION_LABELS.doing, state: doing });
  stations.push({
    id: 'writing',
    label: WAIT_STATION_LABELS.writing,
    state: textStreaming ? 'active' : textParts.length > 0 ? 'done' : isRunning ? 'pending' : 'skipped',
  });

  // Remembering is event-sourced only: no backend signal says "recall is running",
  // so it is never `active` — claiming otherwise would be fake progress. An
  // approval wait parks the turn mid-Doing: the orb stays with the parked work.
  const activeStation: WaitStationId | null = awaitingApproval
    ? 'doing'
    : textStreaming
      ? 'writing'
      : runningTools.length > 0
        ? 'doing'
        : listening === 'active'
          ? 'listening'
          : null;

  let microcopy: string;
  if (awaitingApproval) {
    microcopy = 'Waiting for your approval…';
  } else if (textStreaming) {
    microcopy = 'Writing…';
  } else if (runningTools.length === 1) {
    const only = runningTools[0];
    microcopy = only ? `${toolLabel(only)}…` : 'Working…';
  } else if (runningTools.length > 1) {
    const first = runningTools[0];
    microcopy = first ? `${toolLabel(first)} · +${String(runningTools.length - 1)} more…` : 'Working…';
  } else if (listening === 'active') {
    microcopy = 'On it…';
  } else {
    microcopy = 'Thinking it through…';
  }

  const tickCandidates: string[] = [];
  const recallTick = memoryTick(memory);
  if (recallTick !== undefined) tickCandidates.push(recallTick);
  for (const tool of settledTools) tickCandidates.push(toolTick(tool));
  const ticks = tickCandidates.slice(-MAX_TICKS);

  // The found-memories moment: recall landed with items (same test as the
  // "Found N memories" tick) and no tool or text part exists yet. Once the
  // first part appears, the sprite belongs to doing/writing instead.
  const recallJustLanded =
    memory.landed &&
    (memory.outcome === 'ok' || memory.outcome === undefined) &&
    (memory.items ?? 0) > 0 &&
    toolParts.length === 0 &&
    textParts.length === 0;

  return { stations, activeStation, recallJustLanded, microcopy, ticks };
}

export type SpriteStateForInput = {
  activeStation: WaitStationId | null;
  recallJustLanded: boolean;
  longWait: boolean;
};

/**
 * Canonical owner of the turn-status sprite mapping. Pure: same input always
 * yields the same sprite. Doing and writing win over found-memories, so a
 * recall that lands after the first part never steals the sprite mid-turn.
 * Remembering is the fallback: it is never "active" because no signal says
 * recall is running.
 */
export function spriteStateFor({ activeStation, recallJustLanded, longWait }: SpriteStateForInput): TurnSpriteId {
  if (activeStation === 'doing') return 'doing';
  if (activeStation === 'writing') return longWait ? 'still-writing' : 'writing';
  if (activeStation === 'listening') return 'listening';
  if (recallJustLanded) return 'found-memories';
  return 'remembering';
}

export type LongWaitNoteInput = {
  elapsedMs: number;
  activeStation: WaitStationId | null;
  microcopy: string;
};

/**
 * The long-queue show: elapsed time plus an honest explainer naming the actual
 * current activity. Never invents a reason for the slowness, never blames.
 */
export function buildLongWaitNote({ elapsedMs, activeStation, microcopy }: LongWaitNoteInput): string {
  const elapsed = formatDuration(elapsedMs);
  if (activeStation === 'listening') {
    return `Still waiting for the first response — ${elapsed} so far.`;
  }
  const activity = microcopy.replace(/…$/, '').trim();
  const lowered = activity.charAt(0).toLowerCase() + activity.slice(1);
  return `Still ${lowered} — ${elapsed} so far.`;
}

export type LongWaitAnnouncementInput = {
  activeStation: WaitStationId | null;
  microcopy: string;
};

/**
 * Stable across timer ticks (no elapsed number): announced exactly once, when
 * the long-wait show begins, instead of every second.
 */
export function buildLongWaitAnnouncement({ activeStation, microcopy }: LongWaitAnnouncementInput): string {
  if (activeStation === 'listening') {
    return 'Still waiting for the first response — this is taking longer than usual.';
  }
  const activity = microcopy.replace(/…$/, '').trim();
  const lowered = activity.charAt(0).toLowerCase() + activity.slice(1);
  return `Still ${lowered} — this is taking longer than usual.`;
}
