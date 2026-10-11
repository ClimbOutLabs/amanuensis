import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'winston';
import {
  ISOLATION_REFUSED_MARKER,
  OUTPUT_EXCEEDED_MARKER,
  runCodeArgv,
  type DriverReadiness,
  type DriverRunParams,
  type DriverRunResult,
  type DriverTermination,
  type IsolationDriver,
} from '../driver/IsolationDriver';
import { RunCodeFileNameSchema } from '../driver/RunCodeSchemas';
import { SlotClient, type SlotCallError } from './SlotClient';
import {
  SLOT_AGENT_TIMEOUT_MARGIN_MS,
  SLOT_AGENT_VERSION,
  SLOT_ATTESTATION_MAX_AGE_MS,
  SLOT_HEALTH_TIMEOUT_MS,
  SLOT_MIN_AGENT_TIMEOUT_MS,
  SLOT_PLATFORM,
  SLOT_QUEUE_POLL_MS,
  SLOT_REQUIRED_CHECKS,
  SLOT_RUNSC_VERSION,
  type SlotAttestation,
  type SlotRunCodeResponse,
  type SlotTerminationName,
} from './slotContract';

/** The one repair command shown to users for every slot problem. */
export const SLOT_FIX_COMMAND = 'aman doctor sandbox --fix';

/** A slot that refused a connection is not tried again for this long. */
const DOWN_FOR_MS = 5_000;
/** Extra wait allowed for a free slot beyond the call's own time limit. */
const QUEUE_GRACE_MS = 10_000;

/** Why a slot's attestation does not qualify, or undefined when every required check passes. */
export function attestationProblem(attestation: SlotAttestation, nowMs: number): string | undefined {
  const problems: string[] = [];
  const byName = new Map<string, SlotAttestation['checks'][number]>();
  for (const check of attestation.checks) {
    if (byName.has(check.name)) {
      problems.push(`${check.name}: reported more than once`);
    }
    byName.set(check.name, check);
  }
  for (const name of SLOT_REQUIRED_CHECKS) {
    const check = byName.get(name);
    if (check === undefined) {
      problems.push(`${name}: not reported`);
    } else if (!check.ok) {
      problems.push(`${name}: ${check.detail}`);
    }
  }
  const checkedAt = Date.parse(attestation.checked_at);
  if (Number.isNaN(checkedAt) || nowMs - checkedAt > SLOT_ATTESTATION_MAX_AGE_MS || checkedAt - nowMs > 60_000) {
    problems.push('the attestation is not current');
  }
  if (attestation.agent_version !== SLOT_AGENT_VERSION) {
    problems.push(`agent version ${attestation.agent_version} is not the expected ${SLOT_AGENT_VERSION}`);
  }
  if (attestation.facts.runsc_version !== SLOT_RUNSC_VERSION) {
    problems.push(`gVisor is "${attestation.facts.runsc_version}", expected "${SLOT_RUNSC_VERSION}"`);
  }
  if (attestation.facts.platform !== SLOT_PLATFORM) {
    problems.push(`platform is ${attestation.facts.platform}, expected ${SLOT_PLATFORM}`);
  }
  if (!attestation.ok && problems.length === 0) {
    problems.push('the agent reported a failed attestation');
  }
  return problems.length === 0 ? undefined : problems.join('; ');
}

export interface SlotDriverOptions {
  /** Unix socket path of each slot agent, in slot order. */
  socketPaths: readonly string[];
  logger: Logger;
  /** Injectable for tests. */
  now: (() => number) | undefined;
  sleepMs: ((ms: number) => Promise<void>) | undefined;
}

type SlotState = 'ok' | 'unreachable' | 'refused';

interface SlotHealth {
  index: number;
  state: SlotState;
  detail: string;
}

/**
 * `run_code` on sandbox slots. Each call is sent to a slot agent that starts a fresh gVisor guest; the
 * agent owns all isolation. The server stages nothing the guest can reach: inputs travel in the request
 * and results come back in the reply.
 */
export class SlotDriver implements IsolationDriver {
  readonly kind = 'slots' as const;

  private readonly clients: SlotClient[];
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly busy: boolean[];
  private readonly downUntil: number[];
  private readonly inFlight = new Set<AbortController>();
  private cursor = 0;
  private readonly warnedNoDisk = new Set<number>();

  constructor(options: SlotDriverOptions) {
    this.clients = options.socketPaths.map(path => new SlotClient(path));
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.sleepMs = options.sleepMs ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.busy = this.clients.map(() => false);
    this.downUntil = this.clients.map(() => 0);
  }

  async ensureReady(signal?: AbortSignal): Promise<DriverReadiness> {
    const health = await Promise.all(this.clients.map((_, index) => this.probe({ index, signal })));
    const usable = health.filter(slot => slot.state === 'ok');
    if (usable.length > 0) {
      for (const slot of health.filter(entry => entry.state !== 'ok')) {
        this.logger.warn('sandbox slot is not usable', { slot: slot.index + 1, detail: slot.detail });
      }
      return { ready: true };
    }
    const refused = health.filter(slot => slot.state === 'refused');
    if (refused.length > 0) {
      const causes = refused
        .map(slot => `Slot ${String(slot.index + 1)} failed its checks (${slot.detail})`)
        .join('. ');
      return {
        ready: false,
        error_code: 'daemon_unavailable',
        reason: 'isolation_refused',
        error: `The sandbox could not prove its safety limits, so no code was run. ${causes}. Run \`${SLOT_FIX_COMMAND}\`, then check again.`,
      };
    }
    return {
      ready: false,
      error_code: 'slots_unavailable',
      error: `The sandbox slots are not running. Run \`${SLOT_FIX_COMMAND}\`, then check again.`,
    };
  }

  provision(): Promise<void> {
    return Promise.reject(
      new Error(`Sandbox slots are prepared outside the app. Run \`${SLOT_FIX_COMMAND}\`, then check again.`),
    );
  }

  async run(params: DriverRunParams): Promise<DriverRunResult> {
    const controller = new AbortController();
    this.inFlight.add(controller);
    const onAbort = (): void => {
      controller.abort();
    };
    if (params.signal?.aborted === true) {
      onAbort();
    } else {
      params.signal?.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await this.dispatch({ params, signal: controller.signal });
    } finally {
      params.signal?.removeEventListener('abort', onAbort);
      this.inFlight.delete(controller);
    }
  }

  /** Slot calls leave nothing on the server's disk that a sandbox could reach, so a run is always gone. */
  isRunGone(): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** Agents remove leftovers of a crashed call themselves when they start. */
  reapStale(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    for (const controller of this.inFlight) {
      controller.abort();
    }
    return Promise.resolve();
  }

  private async probe(input: { index: number; signal: AbortSignal | undefined }): Promise<SlotHealth> {
    const client = this.clients[input.index];
    if (client === undefined) {
      return { index: input.index, state: 'unreachable', detail: 'no such slot' };
    }
    const result = await client.health({ signal: input.signal, timeoutMs: SLOT_HEALTH_TIMEOUT_MS });
    if (!result.ok) {
      return { index: input.index, state: 'unreachable', detail: result.error.message };
    }
    const problem = attestationProblem(result.value.attestation, this.now());
    if (
      problem === undefined &&
      result.value.attestation.facts.disk_mode === 'none' &&
      !this.warnedNoDisk.has(input.index)
    ) {
      this.warnedNoDisk.add(input.index);
      this.logger.warn('sandbox slot has no disk limit of its own', { slot: input.index + 1 });
    }
    return problem === undefined
      ? { index: input.index, state: 'ok', detail: '' }
      : { index: input.index, state: 'refused', detail: problem };
  }

  private async dispatch(input: { params: DriverRunParams; signal: AbortSignal }): Promise<DriverRunResult> {
    const { params, signal } = input;
    const filesIn = await this.readIngress(params.ingressDir);
    const request = {
      run_id: params.runId,
      argv: runCodeArgv(params.language),
      files_in: filesIn,
      timeout_ms: Math.max(SLOT_MIN_AGENT_TIMEOUT_MS, params.timeoutMs - SLOT_AGENT_TIMEOUT_MARGIN_MS),
      disk_mb: params.diskMb,
    };
    const deadline = this.now() + params.timeoutMs + QUEUE_GRACE_MS;
    let refusal: string | undefined;
    let lastError: SlotCallError | undefined;
    while (!signal.aborted) {
      const index = this.nextFreeSlot();
      if (index === undefined) {
        if (this.now() > deadline) {
          return this.failure({ terminatedBy: 'internal', message: 'every sandbox slot stayed busy for too long' });
        }
        await this.sleepMs(SLOT_QUEUE_POLL_MS);
        continue;
      }
      const client = this.clients[index];
      if (client === undefined) {
        continue;
      }
      this.busy[index] = true;
      let result;
      try {
        result = await client.runCode({ request, signal });
      } finally {
        this.busy[index] = false;
      }
      if (result.ok) {
        return this.toDriverResult({ response: result.value, params });
      }
      lastError = result.error;
      if (result.error.kind === 'aborted') {
        break;
      }
      if (result.error.kind === 'unreachable') {
        this.downUntil[index] = this.now() + DOWN_FOR_MS;
      } else if (result.error.kind === 'agent' && result.error.code === 'busy') {
        continue;
      } else if (result.error.kind === 'agent' && result.error.code === 'storage_full') {
        return this.failure({
          terminatedBy: 'internal',
          message:
            'The sandbox storage is almost full, so the code was not run. Free some disk space on this machine, then try again.',
        });
      } else if (result.error.kind === 'agent' && result.error.code === 'isolation_refused') {
        refusal = result.error.message;
        this.downUntil[index] = this.now() + DOWN_FOR_MS;
      } else {
        return this.failure({ terminatedBy: 'internal', message: result.error.message });
      }
      if (this.allDown()) {
        break;
      }
    }
    if (refusal !== undefined) {
      return this.failure({
        terminatedBy: 'internal',
        message: `${ISOLATION_REFUSED_MARKER}The sandbox could not prove its safety limits, so the code was not run (${refusal}). Run \`${SLOT_FIX_COMMAND}\`, then try again.`,
      });
    }
    if (signal.aborted) {
      return this.failure({ terminatedBy: 'killed', message: 'the call was cancelled' });
    }
    return this.failure({
      terminatedBy: 'internal',
      message: `no sandbox slot could be reached (${lastError?.message ?? 'none configured'}). Run \`${SLOT_FIX_COMMAND}\`.`,
    });
  }

  private nextFreeSlot(): number | undefined {
    const count = this.clients.length;
    const at = this.now();
    for (let step = 0; step < count; step += 1) {
      const index = (this.cursor + step) % count;
      if (!this.busy[index] && (this.downUntil[index] ?? 0) <= at) {
        this.cursor = (index + 1) % count;
        return index;
      }
    }
    return undefined;
  }

  private allDown(): boolean {
    const at = this.now();
    return this.clients.every((_, index) => (this.downUntil[index] ?? 0) > at);
  }

  private failure(input: { terminatedBy: DriverTermination; message: string }): DriverRunResult {
    return {
      exitCode: -1,
      stdout: '',
      stderr: '',
      terminatedBy: input.terminatedBy,
      internalError: input.message,
      harvestWarnings: [],
    };
  }

  private async readIngress(dir: string): Promise<{ name: string; content_base64: string }[]> {
    const names = await readdir(dir);
    const files: { name: string; content_base64: string }[] = [];
    for (const name of names) {
      const path = join(dir, name);
      const info = await lstat(path);
      if (!info.isFile()) {
        continue;
      }
      files.push({ name, content_base64: (await readFile(path)).toString('base64') });
    }
    return files;
  }

  private async toDriverResult(input: {
    response: SlotRunCodeResponse;
    params: DriverRunParams;
  }): Promise<DriverRunResult> {
    const { response, params } = input;
    const warnings = [...response.warnings];
    for (const file of response.files_out) {
      const parsedName = RunCodeFileNameSchema.safeParse(file.name);
      if (!parsedName.success) {
        warnings.push('Skipped a result file with an invalid name.');
        continue;
      }
      const target = join(file.dir === 'egress' ? params.egressDir : params.scratchDir, parsedName.data);
      try {
        await writeFile(target, Buffer.from(file.content_base64, 'base64'), { mode: 0o600, flag: 'wx' });
      } catch {
        warnings.push(`Result file "${parsedName.data}" could not be saved.`);
      }
    }
    const termination = terminationOf(response.terminated_by);
    const internalError =
      response.terminated_by === 'output_exceeded'
        ? `${OUTPUT_EXCEEDED_MARKER} the program wrote more than the transport bound`
        : response.terminated_by === 'disk_exceeded'
          ? 'disk quota exceeded during run'
          : response.internal_error === ''
            ? undefined
            : response.internal_error;
    return {
      exitCode: response.exit_code,
      stdout: response.stdout,
      stderr: response.stderr,
      terminatedBy: termination,
      internalError,
      harvestWarnings: warnings,
    };
  }
}

function terminationOf(name: SlotTerminationName): DriverTermination {
  switch (name) {
    case 'completed':
      return 'completed';
    case 'timeout':
      return 'timeout';
    case 'oom':
      return 'oom';
    case 'disk_exceeded':
      return 'disk';
    case 'output_exceeded':
    case 'killed':
      return 'killed';
    case 'internal':
      return 'internal';
  }
}
