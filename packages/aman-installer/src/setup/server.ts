import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Host } from '../host/host.ts';
import { PASSWORD_MISSING_LINE } from '../messages.ts';
import type { StateStore, StateSummary } from '../state/state.ts';
import { registryValue } from '../state/state.ts';
import {
  calendarSectionGiven,
  cloudVmFromHardwareText,
  emailSectionGiven,
  EMPTY_SECRETS,
  installArgs,
  passwordProblem,
  planAdminArgs,
  secretsFromJson,
  stdinLines,
  answersFromJson,
  tokenFactorySectionGiven,
  type SetupAnswers,
  type SetupSecrets,
} from './answers.ts';
import { checkRows, type CheckRow, type ChecksResult } from './checks.ts';
import { readEventsFile, type EngineRunner } from './engine.ts';
import { progressFromEvents, type ProgressState } from './events.ts';
import { parsePlan, type ParsedPlan, type PlanRow } from './plan.ts';
import { setupPageHtml } from './page.ts';
import {
  pidAlive,
  readLockHolder,
  readRunRecord,
  runDirFor,
  writeRunRecord,
  type RunRecord,
} from './runs.ts';

// The wizard's server: one page and a small set of calls, on this
// computer only (127.0.0.1), behind a one-time token the page carries.
// The server is the only keeper of a run's secrets, and only until the
// run has read them: they are passed to the installer on its stdin at
// the moment the run starts, and the server's copies are dropped in the
// same moment. They are never written to a file, a log, an address or
// the run record.

export interface SetupDeps {
  host: Host;
  store: StateStore;
  engine: EngineRunner;
  stateHome: string;
  // Where the computer's hardware names live (/sys/class/dmi/id on a
  // real machine); read for the cloud check the Options screen needs.
  dmiDir: string;
  tempRoot: string;
  nowSeconds: () => number;
  // True when Docker answers as the doctor asks it to.
  dockerCheck: () => Promise<boolean>;
  openBrowser: (url: string) => Promise<boolean>;
  print: (line: string) => void;
}

export type SetupMode = 'fresh' | 'already' | 'locked' | 'attach';

export interface SetupHandle {
  url: string;
  mode: SetupMode;
  // Resolves when the page's Close ends the server (or it is closed
  // directly in a test).
  closed: Promise<void>;
  close: () => void;
}

interface PlanEntry {
  answers: SetupAnswers;
  secrets: SetupSecrets;
  adminArgs: string[];
  plan: ParsedPlan;
}

interface ChecksCache {
  result: ChecksResult;
  shapeKey: string;
}

const EVENTS_FD = 3;
const BODY_CAP = 256 * 1024;
const LOG_TAIL = 64 * 1024;

const RUNNING_LINE = 'An install is already running. Wait for it to finish, then open setup again.';

function shapeKeyOf(rows: readonly CheckRow[]): string {
  return rows.map(row => row.name).join('\n');
}

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function adminRowsOf(plan: ParsedPlan): PlanRow[] {
  return plan.rows.filter(row => row.state === 'admin');
}

// Whether a recorded run has ended: the installer writes exactly one
// final_result, last, as it exits, so a stream holding one is a run
// that is over even when its pid has not been reaped yet. A live pid
// with no final line is a run still in flight, and that is what the
// start gate refuses to start over.
function runFinished(record: RunRecord): boolean {
  return readEventsFile(record.eventsFile).some(event => event.type === 'final_result');
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (given === null) {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString('utf8');
    if (body.length > BODY_CAP) {
      throw new Error('body too large');
    }
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonBody(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // A body that is not a JSON object is read as no fields at all; the
    // handlers answer for the fields they need.
  }
  return {};
}

export class SetupSession {
  readonly deps: SetupDeps;
  mode: SetupMode = 'fresh';
  cloudVm = false;
  publicUrl: string | null = null;
  private checksCache: ChecksCache | null = null;
  private plans = new Map<string, PlanEntry>();
  private currentRun: RunRecord | null = null;
  private failureClass: { dockerDown: boolean } | null = null;
  // The plan a failed run's screen last showed for its Try again: the
  // admin rows it listed and the consent flags they map to. A retry may
  // spend exactly that consent, never a plan nobody has seen.
  private retryPreview: { plan: ParsedPlan; adminArgs: string[] } | null = null;
  private starting = false;

  constructor(deps: SetupDeps) {
    this.deps = deps;
  }

  runDir(): string {
    return runDirFor(this.deps.stateHome, this.deps.tempRoot);
  }

  // The run folder is the wizard's own scratch; the engine opens its
  // events and log files inside it, so it must be there first.
  private async ensureRunDir(): Promise<string> {
    const dir = this.runDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  // The mode decision, from the run record, the lock and the summary,
  // in that order: a live run of this wizard is attached to; an install
  // already in place is reported, never touched; a live lock that is
  // not this wizard's is reported, never removed.
  async decideMode(): Promise<SetupMode> {
    this.cloudVm = await this.readCloudVm();
    const record = await readRunRecord(this.runDir());
    if (record !== null && pidAlive(record.pid)) {
      this.currentRun = record;
      this.mode = 'attach';
      return this.mode;
    }
    const summary = await this.deps.store.readSummary().catch(() => null);
    if (summary !== null && (summary.release !== null || summary.instances.length > 0)) {
      this.mode = 'already';
      this.publicUrl = publicUrlOf(summary);
      return this.mode;
    }
    if (record !== null) {
      // A run of this wizard that is no longer running: the computer
      // may have restarted mid-install, or the run ended and its ending
      // is in its stream. Either way the run is the wizard's to show:
      // its progress reads as done or stopped, and Try again picks up
      // where it stopped, because the installer skips finished steps.
      this.currentRun = record;
      this.mode = 'attach';
      return this.mode;
    }
    const holder = await readLockHolder(this.deps.stateHome, this.deps.nowSeconds());
    if (holder.live) {
      this.mode = 'locked';
      return this.mode;
    }
    this.mode = 'fresh';
    return this.mode;
  }

  private async readCloudVm(): Promise<boolean> {
    const files = ['sys_vendor', 'product_name', 'board_vendor', 'chassis_asset_tag', 'product_uuid'];
    let text = '';
    for (const file of files) {
      text += await readFile(join(this.deps.dmiDir, file), 'utf8').catch(() => '');
    }
    return cloudVmFromHardwareText(text);
  }

  stateForPage(): Record<string, unknown> {
    return { mode: this.mode, cloudVm: this.cloudVm, publicUrl: this.publicUrl };
  }

  // Why this server may not take a call, or null when it may. The mode
  // is decided when the server opens and it binds every call after
  // that: a machine already set up and a machine with someone else's
  // install running are answered by their screens alone. A run this
  // wizard is attached to can be watched; while it lives nothing may
  // start, and once it has stopped only its own Try again and Start
  // Docker may run, never a new install flow. The page shows the
  // matching screen; this is the server keeping the same promise for
  // any caller holding the address.
  workRefusal(kind: 'flow' | 'resume'): string | null {
    switch (this.mode) {
      case 'fresh':
        return null;
      case 'already':
        return 'Aman is already set up on this computer. Opening setup changes nothing here.';
      case 'locked':
        return RUNNING_LINE;
      case 'attach': {
        if (kind === 'flow') {
          return RUNNING_LINE;
        }
        return this.currentRun !== null && pidAlive(this.currentRun.pid) ? RUNNING_LINE : null;
      }
    }
  }

  // One preflight dry run, answered as the checks screen's rows. With an
  // id, this is the Check-again of one row: the preflight runs whole
  // (the installer has no smaller check to run), and when the shape of
  // the result is unchanged only the asked-for row is refreshed, as the
  // screen promises; when the shape changed, the whole fresh list is
  // the answer.
  async runChecks(recheckId: string | null): Promise<ChecksResult> {
    const eventsFile = join(await this.ensureRunDir(), 'checks-events.jsonl');
    const args = ['--dry-run', '--verbose', '--events', String(EVENTS_FD)];
    const outcome = await this.deps.engine.dryRun(args, eventsFile);
    const final = outcome.events.find(event => event.type === 'final_result');
    const fresh = checkRows({
      events: outcome.events,
      runFailed: outcome.exitCode !== 0,
      hostKind: this.deps.host.kind,
      finalVerdict: final?.type === 'final_result' ? final.verdict : null,
    });
    if (recheckId === null || this.checksCache === null) {
      this.checksCache = { result: fresh, shapeKey: shapeKeyOf(fresh.rows) };
      return fresh;
    }
    if (shapeKeyOf(fresh.rows) !== this.checksCache.shapeKey) {
      this.checksCache = { result: fresh, shapeKey: shapeKeyOf(fresh.rows) };
      return fresh;
    }
    const index = this.checksCache.result.rows.findIndex(row => row.id === recheckId);
    const freshRow = index >= 0 ? fresh.rows[index] : undefined;
    if (index < 0 || freshRow === undefined) {
      return this.checksCache.result;
    }
    const rows = this.checksCache.result.rows.map((row, i) => (i === index ? { ...freshRow, id: row.id } : row));
    const merged: ChecksResult = {
      rows,
      blocked: rows.some(row => row.state === 'block'),
      dockerInstallOffered: fresh.dockerInstallOffered,
    };
    this.checksCache = { result: merged, shapeKey: shapeKeyOf(rows) };
    return merged;
  }

  checksBlocked(): boolean {
    return this.checksCache === null || this.checksCache.result.blocked;
  }

  // One plan dry run: the installer's printed plan for a set of answers,
  // and the consent flags of the steps it marks as needing admin. A dry
  // run reads no stdin, so the secrets shape its flags (a Token Factory
  // step stands only when a key is given) and nothing more.
  private async dryRunPlan(
    answers: SetupAnswers,
    secrets: SetupSecrets,
  ): Promise<{ plan: ParsedPlan; adminArgs: string[] } | { error: string }> {
    const eventsFile = join(await this.ensureRunDir(), 'plan-events.jsonl');
    const args = installArgs({
      answers,
      secrets,
      cloudVm: this.cloudVm,
      eventsFd: EVENTS_FD,
      dryRun: true,
      withPassword: false,
    });
    const outcome = await this.deps.engine.dryRun(args, eventsFile);
    if (outcome.exitCode !== 0) {
      const lines = outcome.stderr
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '');
      return { error: lines.slice(-3).join(' ') || 'The plan could not be made. Run aman doctor and follow what it says.' };
    }
    const plan = parsePlan(outcome.stdout);
    const adminArgs = planAdminArgs(plan.rows.filter(row => row.state === 'admin').map(row => row.text));
    return { plan, adminArgs };
  }

  // The plan of the Review screen: a dry run with the person's answers.
  // Nothing is written but the wizard's own scratch. The plan is kept
  // (with the secrets, in memory only) under a fresh id, and Install
  // answers to that id alone. Only the newest plan is ever kept: making
  // a plan drops the one before it, so a plan left uninstalled does not
  // hold its secrets in the server.
  async makePlan(answers: SetupAnswers, secrets: SetupSecrets): Promise<{ planId: string; plan: ParsedPlan } | { error: string }> {
    const withPassword = await this.instanceMissing();
    if (withPassword) {
      const problem = passwordProblem(secrets.password);
      if (problem !== '') {
        return { error: problem };
      }
    }
    const made = await this.dryRunPlan(answers, secrets);
    if ('error' in made) {
      return made;
    }
    const planId = randomUUID();
    this.plans.clear();
    this.plans.set(planId, { answers, secrets, adminArgs: made.adminArgs, plan: made.plan });
    return { planId, plan: made.plan };
  }

  private async instanceMissing(): Promise<boolean> {
    const summary = await this.deps.store.readSummary().catch(() => null);
    return summary === null || summary.instances.length === 0;
  }

  // Starts the run a reviewed plan promised. The secrets move onto the
  // installer's stdin here and the server's copies are dropped in the
  // same moment, whatever happens next.
  async startPlannedRun(planId: string): Promise<{ started: true } | { error: string }> {
    const entry = this.plans.get(planId);
    if (entry === undefined) {
      return { error: 'That plan is no longer here. Go back and review the plan again.' };
    }
    this.plans.clear();
    const withPassword = await this.instanceMissing();
    return this.startRun(entry.answers, entry.secrets, entry.adminArgs, withPassword);
  }

  // Try again after a failure: the installer skips the steps it already
  // did, so the same answers start the same run over. The run record
  // kept the answers but never a secret, so the failure screen asks for
  // every secret the recorded answers name, the password and each
  // Advanced section alike, and the retry carries exactly the sections
  // the first run carried. Its admin steps are re-read from a fresh dry
  // run's plan, and the retry may spend only the consent the failure
  // screen last showed (see progress): a plan whose admin steps differ
  // from the shown ones is sent back to be looked at first.
  async retryRun(secrets: SetupSecrets): Promise<{ started: true } | { error: string }> {
    const record = this.currentRun;
    if (record === null) {
      return { error: 'There is no earlier run to try again. Start setup again.' };
    }
    if (pidAlive(record.pid) && !runFinished(record)) {
      // The run has not stopped; there is nothing to try again yet.
      return { error: RUNNING_LINE };
    }
    this.plans.clear();
    if (record.needsPassword) {
      if (secrets.password === '') {
        return { error: PASSWORD_MISSING_LINE };
      }
      const problem = passwordProblem(secrets.password);
      if (problem !== '') {
        return { error: problem };
      }
    }
    if (record.secretsNeeded.tokenFactoryKey && secrets.tokenFactoryKey === '') {
      return { error: 'Type the Token Factory key again first. It is never kept, so setup needs it to try again.' };
    }
    if (record.secretsNeeded.calendarPassword && secrets.calendarPassword === '') {
      return { error: 'Type the calendar app password again first. It is never kept, so setup needs it to try again.' };
    }
    if (record.secretsNeeded.emailPassword && secrets.emailPassword === '') {
      return { error: 'Type the email app password again first. It is never kept, so setup needs it to try again.' };
    }
    const made = await this.dryRunPlan(record.answers, secrets);
    if ('error' in made) {
      return { error: made.error };
    }
    if (made.adminArgs.length > 0 && (this.retryPreview === null || !sameArgs(made.adminArgs, this.retryPreview.adminArgs))) {
      return {
        error: 'The steps that change this computer are listed on this screen. Look at them, then choose Try again.',
      };
    }
    return this.startRun(record.answers, secrets, made.adminArgs, record.needsPassword);
  }

  // The one road every run starts down. A start is claimed in memory
  // first, so two calls in the same moment cannot both pass, and then
  // proven against the disk at the moment of starting: the run record
  // and the installer's lock are re-read, not remembered from when this
  // server opened, so a run that is live, this wizard's own from an
  // earlier page or anyone else's, is never started over, whichever
  // page or stale second server asked.
  private async startRun(
    answers: SetupAnswers,
    secrets: SetupSecrets,
    adminArgs: readonly string[],
    withPassword: boolean,
  ): Promise<{ started: true } | { error: string }> {
    if (this.starting) {
      return { error: RUNNING_LINE };
    }
    this.starting = true;
    try {
      return await this.startClaimedRun(answers, secrets, adminArgs, withPassword);
    } finally {
      this.starting = false;
    }
  }

  private async startClaimedRun(
    answers: SetupAnswers,
    secrets: SetupSecrets,
    adminArgs: readonly string[],
    withPassword: boolean,
  ): Promise<{ started: true } | { error: string }> {
    const dir = await this.ensureRunDir();
    const recorded = await readRunRecord(dir);
    if (recorded !== null && pidAlive(recorded.pid) && !runFinished(recorded)) {
      return { error: RUNNING_LINE };
    }
    const holder = await readLockHolder(this.deps.stateHome, this.deps.nowSeconds());
    if (holder.live && (recorded === null || holder.pid !== recorded.pid)) {
      return { error: RUNNING_LINE };
    }
    const eventsFile = join(dir, 'events.jsonl');
    const logFile = join(dir, 'run.log');
    const args = [
      ...installArgs({ answers, secrets, cloudVm: this.cloudVm, eventsFd: EVENTS_FD, dryRun: false, withPassword }),
      ...adminArgs,
    ];
    let pid: number;
    try {
      const started = await this.deps.engine.startInstall({
        args,
        stdinLines: stdinLines({ answers, secrets, withPassword }),
        eventsFile,
        logFile,
      });
      pid = started.pid;
    } catch {
      return { error: 'The installer could not be started. Run aman doctor and follow what it says.' };
    }
    const record: RunRecord = {
      pid,
      startedAtSeconds: this.deps.nowSeconds(),
      eventsFile,
      logFile,
      answers,
      needsPassword: withPassword,
      secretsNeeded: {
        emailPassword: emailSectionGiven(answers),
        calendarPassword: calendarSectionGiven(answers),
        tokenFactoryKey: tokenFactorySectionGiven(answers),
      },
    };
    await writeRunRecord(dir, record).catch(() => undefined);
    this.currentRun = record;
    this.failureClass = null;
    this.retryPreview = null;
    return { started: true };
  }

  async startDocker(): Promise<{ started: boolean }> {
    try {
      await this.deps.engine.startDocker({ logFile: join(await this.ensureRunDir(), 'docker.log') });
      this.failureClass = null;
      return { started: true };
    } catch {
      return { started: false };
    }
  }

  // The Installing, Done and failure screens all read the run the same
  // way: its event stream folded, its log's tail, and its ending.
  async progress(): Promise<Record<string, unknown>> {
    const record = this.currentRun;
    if (record === null) {
      return { status: 'none', progress: progressFromEvents([]), log: '' };
    }
    const events = readEventsFile(record.eventsFile);
    const progress: ProgressState = progressFromEvents(events);
    const log = await readFile(record.logFile, 'utf8')
      .then(text => (text.length > LOG_TAIL ? text.slice(-LOG_TAIL) : text))
      .catch(() => '');
    const alive = pidAlive(record.pid);
    const final = progress.final;
    let status: 'running' | 'succeeded' | 'failed';
    if (final?.result === 'success') {
      status = 'succeeded';
    } else if (final?.result === 'failed' || !alive) {
      status = 'failed';
    } else {
      status = 'running';
    }
    const answer: Record<string, unknown> = { status, progress, log };
    if (status === 'succeeded') {
      answer['done'] = await this.doneInfo(record, progress);
    }
    if (status === 'failed') {
      answer['failedStep'] = final?.step ?? lastOpenStep(progress);
      answer['needsPassword'] = record.needsPassword;
      answer['needsEmailPassword'] = record.secretsNeeded.emailPassword;
      answer['needsCalendarPassword'] = record.secretsNeeded.calendarPassword;
      answer['needsTokenFactoryKey'] = record.secretsNeeded.tokenFactoryKey;
      answer['startDockerAvailable'] = true;
      // The failure screen is the retry's review: it shows the admin
      // steps of a fresh plan for the recorded answers, and what it
      // shows here is the consent a Try again may spend. The dry run
      // reads no stdin, so it is made with no secrets; the admin steps
      // do not turn on secret values.
      const preview = await this.dryRunPlan(record.answers, EMPTY_SECRETS);
      if ('error' in preview) {
        this.retryPreview = null;
        answer['retryAdminRows'] = [];
      } else {
        this.retryPreview = preview;
        answer['retryAdminRows'] = adminRowsOf(preview.plan);
      }
      if (this.failureClass === null) {
        const stepText = `${final?.step ?? ''} ${final?.phase ?? ''}`;
        const dockerDown = /docker/i.test(stepText) || !(await this.deps.dockerCheck().catch(() => true));
        this.failureClass = { dockerDown };
      }
      answer['dockerDown'] = this.failureClass.dockerDown;
    }
    return answer;
  }

  private async doneInfo(record: RunRecord, progress: ProgressState): Promise<Record<string, unknown>> {
    try {
      this.deps.store.refreshCache();
    } catch {
      // A store that cannot drop its cache still reads what it has.
    }
    const summary = await this.deps.store.readSummary().catch(() => null);
    let publicUrl: string | null = null;
    let phoneUrl: string | null = null;
    if (summary !== null) {
      const instance = summary.instances.find(entry => entry.name === 'main') ?? summary.instances[0];
      if (instance !== undefined) {
        publicUrl = registryValue(instance.entries, 'public_url');
        if (record.answers.reach === 'network') {
          phoneUrl = phoneUrlOf(instance.entries);
        }
      }
    }
    const qr = phoneUrl !== null ? await this.deps.engine.qrText(phoneUrl).catch(() => null) : null;
    return {
      publicUrl,
      phoneUrl,
      qr,
      backups: record.answers.backups,
      warning: progress.final?.verdictKind === 'warn',
      verdict: progress.final?.verdict ?? null,
    };
  }
}

function publicUrlOf(summary: StateSummary): string | null {
  const instance = summary.instances.find(entry => entry.name === 'main') ?? summary.instances[0];
  return instance !== undefined ? registryValue(instance.entries, 'public_url') : null;
}

// The address a phone on the home network opens: the first of the
// instance's origins in the installer's own display order (this
// computer's network addresses first, then its names, and only then
// the ones that work on this computer alone), skipping the ones only
// this computer can open.
function originRank(origin: string): number {
  let host = '';
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return 3;
  }
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    return 4;
  }
  if (host.endsWith('.ts.net')) {
    return 1;
  }
  if (host.endsWith('.local')) {
    return 2;
  }
  if (/^[0-9.]+$/.test(host)) {
    return 0;
  }
  return 3;
}

function phoneUrlOf(entries: Parameters<typeof registryValue>[0]): string | null {
  const origins = registryValue(entries, 'origins');
  if (origins === null) {
    return null;
  }
  const list = origins
    .split(',')
    .map(origin => origin.trim())
    .filter(origin => origin !== '');
  const ordered = list
    .map((origin, index) => ({ origin, index, rank: originRank(origin) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const phone = ordered.find(entry => entry.rank < 4);
  return phone !== undefined ? phone.origin : null;
}

function lastOpenStep(progress: ProgressState): string | null {
  for (const phase of [...progress.phases].reverse()) {
    for (const step of [...phase.steps].reverse()) {
      if (step.result === 'failed') {
        return step.resultName ?? step.startName;
      }
      if (step.result === null) {
        return step.startName;
      }
    }
  }
  return null;
}

export function createSetupServer(session: SetupSession, token: string): { server: Server; closed: Promise<void> } {
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve;
  });
  const server = createServer((request, response) => {
    void handleRequest(session, token, request, response, () => {
      server.close(() => {
        resolveClosed();
      });
    }).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
      }
      response.end('{"error":"The setup page hit a problem. Close it and run aman setup again."}');
    });
  });
  server.on('close', () => {
    resolveClosed();
  });
  return { server, closed };
}

async function handleRequest(
  session: SetupSession,
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
  quit: () => void,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (!tokenMatches(url.searchParams.get('t'), token)) {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end('{"error":"This setup page does not know that address. Open the address aman setup gave you."}');
    return;
  }
  const send = (status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(setupPageHtml());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/state') {
    send(200, session.stateForPage());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/progress') {
    send(200, await session.progress());
    return;
  }
  if (request.method !== 'POST') {
    send(404, { error: 'That address is not part of setup.' });
    return;
  }
  const body = jsonBody(await readBody(request));
  // The mode gates: 'flow' calls drive a new install (checks, plan,
  // install), 'resume' calls pick a stopped run back up (Try again,
  // Start Docker). The server refuses what its mode forbids, whatever
  // the page showed.
  const refuse = (kind: 'flow' | 'resume'): boolean => {
    const refusal = session.workRefusal(kind);
    if (refusal !== null) {
      send(400, { error: refusal });
      return true;
    }
    return false;
  };
  switch (url.pathname) {
    case '/api/checks': {
      if (refuse('flow')) return;
      send(200, await session.runChecks(null));
      return;
    }
    case '/api/checks/recheck': {
      if (refuse('flow')) return;
      const id = typeof body['id'] === 'string' ? body['id'] : null;
      send(200, await session.runChecks(id));
      return;
    }
    case '/api/plan': {
      if (refuse('flow')) return;
      const answers = answersFromJson(body['answers']);
      if (answers === null) {
        send(400, { error: 'Those answers could not be read. Go back and fill the screens in again.' });
        return;
      }
      if (session.checksBlocked()) {
        send(400, { error: 'The checks still have a problem standing. Fix it on the checks screen first.' });
        return;
      }
      const made = await session.makePlan(answers, secretsFromJson(body['secrets']));
      if ('error' in made) {
        send(400, { error: made.error });
        return;
      }
      send(200, { planId: made.planId, rows: made.plan.rows, downloads: made.plan.downloads, totalMb: made.plan.totalMb });
      return;
    }
    case '/api/install': {
      if (refuse('flow')) return;
      const planId = typeof body['planId'] === 'string' ? body['planId'] : '';
      const started = await session.startPlannedRun(planId);
      if ('error' in started) {
        send(400, { error: started.error });
        return;
      }
      send(200, { started: true });
      return;
    }
    case '/api/retry': {
      if (refuse('resume')) return;
      const started = await session.retryRun(secretsFromJson(body));
      if ('error' in started) {
        send(400, { error: started.error });
        return;
      }
      send(200, { started: true });
      return;
    }
    case '/api/start-docker': {
      if (refuse('resume')) return;
      send(200, await session.startDocker());
      return;
    }
    case '/api/quit': {
      send(200, { ok: true });
      setImmediate(quit);
      return;
    }
    default: {
      send(404, { error: 'That address is not part of setup.' });
    }
  }
}
