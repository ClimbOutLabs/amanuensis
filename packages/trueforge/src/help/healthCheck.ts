import type { HelpHealthCheck, HelpHealthItem, HelpHostReport } from '../schemas/help';
import type { HostReportRead } from './hostReport';

/**
 * The result of each live probe. The probes do the I/O (see healthProbes.ts); this module only turns
 * their results into plain lines, so the wording and the ordering live in one place.
 */
export type ModelProbe =
  { kind: 'no_default' } | { kind: 'misconfigured' } | { kind: 'no_answer' } | { kind: 'answered' };

export interface ConnectorProbe {
  /** The connector's name. Never a token or URL. */
  name: string;
  ok: boolean;
}

export type SchedulerProbe = 'running' | 'stopped' | 'elsewhere';

export interface HelpProbeResults {
  model: ModelProbe;
  connectors: ConnectorProbe[];
  sandboxReady: boolean;
  scheduler: SchedulerProbe;
  hostReport: HostReportRead;
}

const MODEL_ITEM_ID = 'model';
const CONNECTORS_ITEM_ID = 'connectors';
const SANDBOX_ITEM_ID = 'sandbox';
const SCHEDULES_ITEM_ID = 'schedules';
const MAIL_CALENDAR_ITEM_ID = 'mail_calendar';

const HOST_REPORT_OLD_MESSAGE = 'The last full check is more than 7 days old.';
const RUN_DOCTOR_NEXT_STEP = 'Run aman doctor on your computer.';

function modelItem(model: ModelProbe): HelpHealthItem {
  const base = { id: MODEL_ITEM_ID, name: 'Your model' };
  switch (model.kind) {
    case 'answered':
      return { ...base, status: 'pass', message: 'The model answered.', next_step: null };
    case 'no_default':
      return {
        ...base,
        status: 'fail',
        message: 'No model is connected.',
        next_step: 'Add one in Settings, Models. Token Factory is one option.',
      };
    case 'misconfigured':
      return {
        ...base,
        status: 'fail',
        message: 'The default model is not set up correctly.',
        next_step: 'Check the model in Settings, Models.',
      };
    case 'no_answer':
      return {
        ...base,
        status: 'fail',
        message: 'The model did not answer in time.',
        next_step: 'Check the model key in Settings, Models. Then press Check again.',
      };
  }
}

function connectorsItem(connectors: ConnectorProbe[]): HelpHealthItem {
  const base = { id: CONNECTORS_ITEM_ID, name: 'Connectors' };
  if (connectors.length === 0) {
    return { ...base, status: 'not_set_up', message: 'No connectors are set up yet.', next_step: null };
  }
  const failed = connectors.filter(connector => !connector.ok).map(connector => connector.name);
  if (failed.length === 0) {
    const message =
      connectors.length === 1 ? 'The connector answered.' : `All ${String(connectors.length)} connectors answered.`;
    return { ...base, status: 'pass', message, next_step: null };
  }
  return {
    ...base,
    status: 'fail',
    message: `These connectors did not answer: ${failed.join(', ')}.`,
    next_step: 'Open Settings, Connectors and check each one.',
  };
}

function sandboxItem(sandboxReady: boolean): HelpHealthItem {
  const base = { id: SANDBOX_ITEM_ID, name: 'Sandbox' };
  if (sandboxReady) {
    return { ...base, status: 'pass', message: 'The sandbox is ready.', next_step: null };
  }
  return {
    ...base,
    status: 'warn',
    message: 'The sandbox is not ready.',
    next_step: 'Check Settings, Sandbox.',
  };
}

function schedulesItem(scheduler: SchedulerProbe): HelpHealthItem {
  const base = { id: SCHEDULES_ITEM_ID, name: 'Schedules' };
  switch (scheduler) {
    case 'running':
      return { ...base, status: 'pass', message: 'Schedules are running.', next_step: null };
    case 'stopped':
      return {
        ...base,
        status: 'fail',
        message: 'Schedules have stopped.',
        next_step: 'Restart Aman. If that does not help, run aman doctor on your computer.',
      };
    case 'elsewhere':
      return {
        ...base,
        status: 'not_set_up',
        message: 'Schedules run in a separate service, which this check cannot see.',
        next_step: null,
      };
  }
}

/** Mail and calendar have no service address in this build, so they are never checked, only reported as not set up. */
function mailCalendarItem(): HelpHealthItem {
  return {
    id: MAIL_CALENDAR_ITEM_ID,
    name: 'Email and calendar',
    status: 'not_set_up',
    message: 'Email and calendar services are not set up on this server.',
    next_step: null,
  };
}

function hostReportSection(hostReport: HostReportRead): HelpHostReport {
  switch (hostReport.state) {
    case 'ok':
      return {
        state: 'ok',
        checked_at: hostReport.report.checked_at,
        message: null,
        next_step: null,
      };
    case 'stale':
      return {
        state: 'stale',
        checked_at: hostReport.report.checked_at,
        message: `${HOST_REPORT_OLD_MESSAGE} Run aman doctor on your computer again.`,
        next_step: null,
      };
    case 'missing':
      return {
        state: 'missing',
        checked_at: null,
        message: `No full check has been run yet. ${RUN_DOCTOR_NEXT_STEP}`,
        next_step: null,
      };
    case 'invalid':
      return {
        state: 'invalid',
        checked_at: null,
        message: `The last full check could not be read, so it is treated as missing. ${RUN_DOCTOR_NEXT_STEP}`,
        next_step: null,
      };
  }
}

/** Failed and warned lines from the installer's report, in the same list as the live checks. */
function hostReportItems(hostReport: HostReportRead): HelpHealthItem[] {
  if (hostReport.state !== 'ok' && hostReport.state !== 'stale') {
    return [];
  }
  return hostReport.report.checks
    .filter(check => check.status === 'fail' || check.status === 'warn')
    .map(check => ({
      id: `host_${check.id}`,
      name: check.name,
      status: check.status,
      message: check.message,
      next_step: check.next_step,
    }));
}

/** Builds the help check from the probe results. Model comes first, so a missing model is the first thing shown. */
export function buildHelpHealthCheck({ results, now }: { results: HelpProbeResults; now: Date }): HelpHealthCheck {
  return {
    checked_at: now.toISOString(),
    model_ready: results.model.kind === 'answered',
    items: [
      modelItem(results.model),
      connectorsItem(results.connectors),
      sandboxItem(results.sandboxReady),
      schedulesItem(results.scheduler),
      mailCalendarItem(),
      ...hostReportItems(results.hostReport),
    ],
    host_report: hostReportSection(results.hostReport),
  };
}
