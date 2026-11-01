// The installer's progress stream (installer/install.sh --events): one
// JSON line per moment, written by installer/lib/ui.sh. The wizard reads
// a run only through these lines, never through the terminal text. A
// step's result pairs with its start by position, not by name: the words
// of a result can differ from the words of its start.

export type StepResult = 'done' | 'skipped' | 'failed';

export type InstallerEvent =
  | { type: 'phase_start'; name: string; index: number | null; total: number | null; elapsedSeconds: number }
  | { type: 'step_start'; name: string; phase: string | null; elapsedSeconds: number }
  | { type: 'step_result'; name: string; result: StepResult; phase: string | null; elapsedSeconds: number }
  | { type: 'warning'; text: string; next: string | null; elapsedSeconds: number }
  | { type: 'admin_prompt'; text: string; elapsedSeconds: number }
  | {
      type: 'final_result';
      result: 'success' | 'failed';
      step: string | null;
      phase: string | null;
      verdictKind: string | null;
      verdict: string | null;
      elapsedSeconds: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function elapsedOf(record: Record<string, unknown>): number {
  return numberOrNull(record['elapsed_seconds']) ?? 0;
}

// One line of the stream, read defensively: a line that is not a known
// event in the shape ui.sh writes is not an event, and the reader moves
// on. The stream is a copy of the run, never its record, so a lost line
// must not stop the wizard.
export function parseEventLine(line: string): InstallerEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const type = text(parsed['type']);
  const elapsedSeconds = elapsedOf(parsed);
  switch (type) {
    case 'phase_start': {
      const name = text(parsed['name']);
      if (name === null) return null;
      return { type, name, index: numberOrNull(parsed['index']), total: numberOrNull(parsed['total']), elapsedSeconds };
    }
    case 'step_start': {
      const name = text(parsed['name']);
      if (name === null) return null;
      return { type, name, phase: text(parsed['phase']), elapsedSeconds };
    }
    case 'step_result': {
      const name = text(parsed['name']);
      const result = text(parsed['result']);
      if (name === null || (result !== 'done' && result !== 'skipped' && result !== 'failed')) return null;
      return { type, name, result, phase: text(parsed['phase']), elapsedSeconds };
    }
    case 'warning': {
      const warningText = text(parsed['text']);
      if (warningText === null) return null;
      return { type, text: warningText, next: text(parsed['next']), elapsedSeconds };
    }
    case 'admin_prompt': {
      const promptText = text(parsed['text']);
      if (promptText === null) return null;
      return { type, text: promptText, elapsedSeconds };
    }
    case 'final_result': {
      const result = text(parsed['result']);
      if (result !== 'success' && result !== 'failed') return null;
      return {
        type,
        result,
        step: text(parsed['step']),
        phase: text(parsed['phase']),
        verdictKind: text(parsed['verdict_kind']),
        verdict: text(parsed['verdict']),
        elapsedSeconds,
      };
    }
    default:
      return null;
  }
}

export interface ProgressStep {
  // The words of the step's start, or of its result when the run gave a
  // result with no start before it (the preflight's checks report that
  // way: a result is the whole report of a quick check).
  startName: string;
  resultName: string | null;
  result: StepResult | null;
}

export interface ProgressPhase {
  name: string;
  index: number | null;
  total: number | null;
  steps: ProgressStep[];
}

export interface ProgressWarning {
  text: string;
  next: string | null;
}

export interface ProgressState {
  phases: ProgressPhase[];
  warnings: ProgressWarning[];
  // The latest admin prompt that no later step has answered yet: the
  // screen shows it so the person knows why their computer is asking.
  adminPrompt: string | null;
  final: { result: 'success' | 'failed'; step: string | null; phase: string | null; verdictKind: string | null; verdict: string | null } | null;
  elapsedSeconds: number;
}

export function emptyProgress(): ProgressState {
  return { phases: [], warnings: [], adminPrompt: null, final: null, elapsedSeconds: 0 };
}

function phaseFor(state: ProgressState, name: string | null): ProgressPhase | null {
  if (name === null) {
    return state.phases[state.phases.length - 1] ?? null;
  }
  const found = state.phases.find(phase => phase.name === name);
  return found ?? state.phases[state.phases.length - 1] ?? null;
}

// Folds one event into the progress the Installing screen shows. The one
// fold serves the live run and a run a new setup page attaches to, since
// both read the same stream from its first line.
export function foldEvent(state: ProgressState, event: InstallerEvent): ProgressState {
  const next: ProgressState = {
    phases: state.phases.map(phase => ({ ...phase, steps: phase.steps.map(step => ({ ...step })) })),
    warnings: [...state.warnings],
    adminPrompt: state.adminPrompt,
    final: state.final,
    elapsedSeconds: Math.max(state.elapsedSeconds, event.elapsedSeconds),
  };
  switch (event.type) {
    case 'phase_start': {
      const existing = next.phases.find(phase => phase.name === event.name);
      if (existing === undefined) {
        next.phases.push({ name: event.name, index: event.index, total: event.total, steps: [] });
      }
      next.adminPrompt = null;
      break;
    }
    case 'step_start': {
      const phase = phaseFor(next, event.phase);
      if (phase !== null) {
        phase.steps.push({ startName: event.name, resultName: null, result: null });
      }
      break;
    }
    case 'step_result': {
      const phase = phaseFor(next, event.phase);
      if (phase !== null) {
        const open = [...phase.steps].reverse().find(step => step.result === null);
        if (open !== undefined) {
          open.resultName = event.name;
          open.result = event.result;
        } else {
          phase.steps.push({ startName: event.name, resultName: event.name, result: event.result });
        }
      }
      next.adminPrompt = null;
      break;
    }
    case 'warning': {
      next.warnings.push({ text: event.text, next: event.next });
      break;
    }
    case 'admin_prompt': {
      next.adminPrompt = event.text;
      break;
    }
    case 'final_result': {
      next.final = {
        result: event.result,
        step: event.step,
        phase: event.phase,
        verdictKind: event.verdictKind,
        verdict: event.verdict,
      };
      next.adminPrompt = null;
      break;
    }
  }
  return next;
}

export function progressFromEvents(events: readonly InstallerEvent[]): ProgressState {
  let state = emptyProgress();
  for (const event of events) {
    state = foldEvent(state, event);
  }
  return state;
}

export function parseEvents(text: string): InstallerEvent[] {
  const events: InstallerEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const event = parseEventLine(line);
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}
