/**
 * What a person sees while the slots are set up: phases with a counter, one line per finished part, a progress line
 * for the long ones, and a closing block. The setup itself (`slots.ts`) only reports events; this decides how they look.
 */
import { formatElapsed, tildify, type Ui, type UiStep } from '../lib/ui.js';
import { diskRoot, SLOT_COUNT, type SlotsCheck, type SlotsMode, type SlotsResult, type SlotsStage } from './slots.js';

const STAGES_BY_MODE: Record<SlotsMode, readonly SlotsStage[]> = {
  up: ['docker', 'image', 'profile', 'disks', 'start', 'attest'],
  check: ['docker', 'image', 'profile', 'disks', 'attest'],
  build: ['docker', 'image'],
};

const TITLES: Record<SlotsStage, string> = {
  docker: 'Checking Docker',
  image: 'Building the slot image',
  profile: 'Safety profile',
  disks: 'Slot disks',
  start: 'Starting slots',
  attest: 'Safety checks',
};

const MIN_SHOWN_SECONDS = 5;

export interface ReporterOptions {
  ui: Ui;
  mode: SlotsMode;
  /** Inside another front end's phases: no title, phase headers or closing block, and no lines about Docker itself. */
  embedded: boolean;
  logFile: string | undefined;
  instance: string;
  commandName: string;
  home: string | undefined;
  now: () => number;
}

/** The sentence of a failure without the tool output it ends with. */
function headlineOf({ error, detail }: { error: string; detail: string | undefined }): string {
  return detail !== undefined && error.endsWith(`: ${detail}`)
    ? error.slice(0, error.length - detail.length - 2)
    : error;
}

export class SlotsReporter {
  private readonly stages: readonly SlotsStage[];
  private readonly startedAt: number;
  private stage: SlotsStage | undefined;
  private stageHadOutput = false;
  private step: UiStep | undefined;
  private stepText = '';

  constructor(private readonly options: ReporterOptions) {
    this.stages = STAGES_BY_MODE[options.mode];
    this.startedAt = options.now();
  }

  start(): void {
    if (!this.options.embedded) {
      this.options.ui.title(
        this.options.mode === 'check' ? 'Checking the sandbox slots' : 'Setting up the sandbox slots',
      );
    }
  }

  onStage(stage: SlotsStage): void {
    this.step?.stop();
    this.step = undefined;
    this.closeStage();
    this.stage = stage;
    this.stageHadOutput = false;
    if (!this.options.embedded) {
      const title = stage === 'image' && this.options.mode === 'check' ? 'Checking the slot image' : TITLES[stage];
      this.options.ui.phase({ text: title, n: this.stages.indexOf(stage) + 1, total: this.stages.length });
    }
    if (stage === 'image' && this.options.mode !== 'check') {
      this.beginStep('Building the slot image');
    } else if (stage === 'start') {
      this.beginStep('Starting the slots');
    }
  }

  onCheck(check: SlotsCheck): void {
    const { ui, embedded } = this.options;
    if (embedded && (check.step === 'docker' || check.step === 'compose' || check.status === 'info')) {
      return;
    }
    this.stageHadOutput = true;
    if (this.step !== undefined && (check.step === 'build' || check.step === 'start')) {
      const text = check.step === 'build' ? 'Built the slot image' : check.message;
      this.step.end({ status: 'ok', text });
      this.step = undefined;
      return;
    }
    const resume = this.step !== undefined;
    this.step?.stop();
    this.step = undefined;
    if (check.status === 'ok') {
      ui.ok({ text: check.message });
    } else {
      ui.skip(check.message);
    }
    if (resume) {
      this.beginStep(this.stepText);
    }
  }

  /** Shows the question for the disk step before it is asked. */
  explain(question: string): void {
    this.step?.stop();
    this.step = undefined;
    this.stageHadOutput = true;
    this.options.ui.line(question);
  }

  /** Prints the closing block (or the failure) and says whether the run succeeded. */
  finish({ result, imageSizeMb }: { result: SlotsResult; imageSizeMb?: number | undefined }): void {
    const { ui, embedded, mode } = this.options;
    this.step?.stop();
    this.step = undefined;
    if (result.ok) {
      this.closeStage();
    }
    const total = this.elapsed();
    if (!result.ok) {
      ui.stderr().fail({
        text: headlineOf(result),
        next: result.fix,
        details: result.detail,
      });
      if (!embedded) {
        const at = this.stage === undefined ? 1 : this.stages.indexOf(this.stage) + 1;
        ui.stderr().summary({
          status: 'fail',
          verdict: `Stopped at step ${String(at)} of ${String(this.stages.length)}.`,
        });
        ui.stderr().line(
          `Nothing else was changed. Fix the item above, then run ${this.options.commandName} --fix again.`,
        );
        ui.stderr().summaryEnd(total);
      }
      return;
    }
    for (const warning of result.warnings) {
      ui.warn({ text: warning });
    }
    if (embedded) {
      return;
    }
    const verdict =
      mode === 'check'
        ? 'Ready. The sandbox slots are healthy.'
        : mode === 'build'
          ? 'The slot image is built.'
          : `Ready. ${String(SLOT_COUNT)} sandbox slots are running.`;
    ui.summary({ status: 'ok', verdict });
    if (imageSizeMb !== undefined) {
      ui.row({ label: 'Image', value: `${(imageSizeMb / 1024).toFixed(1)} GB` });
    }
    if (result.disk.mode === 'hard' && result.disk.bytes !== undefined) {
      const gb = Math.round(result.disk.bytes / 2 ** 30);
      ui.row({
        label: 'Disks',
        value: `${String(SLOT_COUNT)} of ${String(gb)} GB under ${diskRoot(this.options.instance)}`,
      });
    }
    if (this.options.logFile !== undefined) {
      ui.row({ label: 'Log', value: tildify({ path: this.options.logFile, home: this.options.home }) });
    }
    ui.summaryEnd(total);
  }

  private beginStep(text: string): void {
    this.stepText = text;
    this.step = this.options.ui.step({ text, logFile: this.options.logFile });
  }

  /** A part with nothing to do on this computer still gets its line, so the counter never seems to skip. */
  private closeStage(): void {
    if (this.stage !== undefined && !this.stageHadOutput && !this.options.embedded) {
      if (this.stage === 'profile' || this.stage === 'disks') {
        this.options.ui.skip('Not needed on this computer');
      }
    }
  }

  private elapsed(): string | undefined {
    const seconds = Math.floor((this.options.now() - this.startedAt) / 1000);
    return seconds >= MIN_SHOWN_SECONDS ? formatElapsed(seconds) : undefined;
  }
}
