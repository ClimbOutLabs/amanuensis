import { CALDAV_SERVER_NAME } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import { MAIL_CONNECTOR_NAME } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';

import type { HelpHealthCheck, HelpHealthItem, HelpHostReport, HostReportFile } from '../schemas/help';
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

/** The built-in Google login: answered, needs connecting again, did not answer, or no Gmail or Calendar grant. */
export type GoogleLoginProbe = 'answered' | 'needs_reconnect' | 'no_answer' | 'not_set_up';

export interface HelpProbeResults {
  model: ModelProbe;
  connectors: ConnectorProbe[];
  google: GoogleLoginProbe;
  sandboxReady: boolean;
  scheduler: SchedulerProbe;
  hostReport: HostReportRead;
}

const MODEL_ITEM_ID = 'model';
const CONNECTORS_ITEM_ID = 'connectors';
const SANDBOX_ITEM_ID = 'sandbox';
const SCHEDULES_ITEM_ID = 'schedules';
const MAIL_CALENDAR_ITEM_ID = 'mail_calendar';

/** The custom MCP connectors that serve email and calendar, by the names they are registered under. */
const MAIL_CALENDAR_CONNECTOR_NAMES: readonly string[] = [MAIL_CONNECTOR_NAME, CALDAV_SERVER_NAME];

const HOST_REPORT_STALE_DAYS = 7;

function modelItem(model: ModelProbe): HelpHealthItem {
  const base = { id: MODEL_ITEM_ID, name: 'Your model' };
  switch (model.kind) {
    case 'answered':
      return { ...base, status: 'pass', message: 'The model answered.', next_step: null };
    case 'no_default':
      // The help panel shows the next step itself, with a link to Settings.
      return { ...base, status: 'fail', message: 'No model is connected.', next_step: null };
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
        next_step: 'Restart Aman. If that does not help, ask Iris in this chat.',
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

/**
 * Email and calendar work through the built-in Google login or the custom connectors. Either one answering
 * is enough. "Not set up" only when neither is configured.
 */
function mailCalendarItem({
  connectors,
  google,
}: {
  connectors: ConnectorProbe[];
  google: GoogleLoginProbe;
}): HelpHealthItem {
  const base = { id: MAIL_CALENDAR_ITEM_ID, name: 'Email and calendar' };
  const configured = connectors.filter(connector => MAIL_CALENDAR_CONNECTOR_NAMES.includes(connector.name));
  if (google === 'answered' || configured.some(connector => connector.ok)) {
    return { ...base, status: 'pass', message: 'Email and calendar answered.', next_step: null };
  }
  if (google === 'needs_reconnect') {
    return {
      ...base,
      status: 'fail',
      message: 'Google needs to be connected again.',
      next_step: 'Open Settings, Connectors, choose Google and sign in again.',
    };
  }
  if (configured.length > 0 || google === 'no_answer') {
    return {
      ...base,
      status: 'fail',
      message: 'Email and calendar did not answer.',
      next_step: 'Open Settings, Connectors and check Google, Email and Calendar.',
    };
  }
  return {
    ...base,
    status: 'not_set_up',
    message: 'Email and calendar are not set up yet.',
    next_step: 'Open Settings, Connectors and choose Google to connect them.',
  };
}

/** The saved report's result in plain words. Its failed and warned checks are listed as items. */
function hostReportResult(report: HostReportFile): string {
  const issues = report.checks.filter(check => check.status === 'fail' || check.status === 'warn').length;
  if (issues === 0) {
    return 'all good';
  }
  return issues === 1 ? '1 thing needs attention' : `${String(issues)} things need attention`;
}

/** Shows the saved full check's date and result. With no readable saved report it says nothing. */
function hostReportSection(hostReport: HostReportRead): HelpHostReport {
  switch (hostReport.state) {
    case 'ok':
      return {
        state: 'ok',
        checked_at: hostReport.report.checked_at,
        message: hostReportResult(hostReport.report),
        next_step: null,
      };
    case 'stale':
      return {
        state: 'stale',
        checked_at: hostReport.report.checked_at,
        message: hostReportResult(hostReport.report),
        next_step: `It is more than ${String(HOST_REPORT_STALE_DAYS)} days old.`,
      };
    case 'missing':
    case 'invalid':
      return { state: hostReport.state, checked_at: null, message: null, next_step: null };
  }
}

/**
 * Failed and warned lines from the installer's report, in the same list as the live checks. The
 * installer's own fix steps are commands, so they are left out; the help panel shows no commands.
 */
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
      next_step: null,
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
      mailCalendarItem({ connectors: results.connectors, google: results.google }),
      ...hostReportItems(results.hostReport),
    ],
    host_report: hostReportSection(results.hostReport),
  };
}
