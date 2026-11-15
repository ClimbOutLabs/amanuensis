import { DEFAULT_ON_SOURCE_CONNECTOR_NAMES } from '@truefoundry/trueforge-core/core/connectors/chatConnectorChoice';

import type {
  HelpConnectorState,
  HelpHealthCheck,
  HelpHealthItem,
  HelpHostReport,
  HelpState,
  HostReportFile,
} from '../schemas/help';
import type { HostReportRead } from './hostReport';

/**
 * The result of each live probe. The probes do the I/O (see healthProbes.ts); this module only turns
 * their results into plain lines, so the wording and the ordering live in one place.
 */
export type ModelProbe =
  { kind: 'no_default' } | { kind: 'misconfigured' } | { kind: 'no_answer' } | { kind: 'answered' };

/** Why a connector did not answer: it wants a fresh sign-in, it did not answer, or its saved settings are unreadable. */
export type ConnectorProblem = 'needs_sign_in' | 'no_answer' | 'unreadable';

export interface ConnectorProbe {
  /** The connector's name. Never a token or URL. */
  name: string;
  /** Null when the connector answered with its tools. */
  problem: ConnectorProblem | null;
}

export type SchedulerProbe = 'running' | 'stopped' | 'elsewhere';

/** The built-in Google login: answered, needs connecting again, did not answer, or no Gmail or Calendar grant. */
export type GoogleLoginProbe = 'answered' | 'needs_reconnect' | 'no_answer' | 'not_set_up';

/** The version this server runs. `buildRef` is null for a build nothing stamped. */
export interface AppBuild {
  version: string;
  buildRef: string | null;
}

export interface HelpProbeResults {
  model: ModelProbe;
  /** Whether the person's name is saved in Personalization, the setup step the first-run list shows. */
  profileNamed: boolean;
  app: AppBuild;
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

const HOST_REPORT_STALE_DAYS = 7;

/** What every line carries whatever its result: which check it is, and where in Settings its fix lives. */
type ItemBase = Pick<HelpHealthItem, 'id' | 'name' | 'settings_section'>;

function modelItem(model: ModelProbe): HelpHealthItem {
  const base: ItemBase = { id: MODEL_ITEM_ID, name: 'Your model', settings_section: 'models' };
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
  const base: ItemBase = { id: CONNECTORS_ITEM_ID, name: 'Connectors', settings_section: 'connectors' };
  if (connectors.length === 0) {
    return { ...base, status: 'not_set_up', message: 'No connectors are set up yet.', next_step: null };
  }
  const failed = connectors.filter(connector => connector.problem !== null).map(connector => connector.name);
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
  const base: ItemBase = { id: SANDBOX_ITEM_ID, name: 'Sandbox', settings_section: 'sandbox' };
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
  const base: ItemBase = { id: SCHEDULES_ITEM_ID, name: 'Schedules', settings_section: null };
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
 * Email and calendar, whichever card serves them: the Email and Calendar connectors or the built-in Google
 * login. Either one answering is enough. Google is named only when a Google login already exists and needs
 * signing in again, because that is the one fix that happens on the Google card.
 */
type MailCalendarProbe = 'answered' | 'google_needs_reconnect' | 'no_answer' | 'not_set_up';

function mailCalendarProbe({
  connectors,
  google,
}: {
  connectors: ConnectorProbe[];
  google: GoogleLoginProbe;
}): MailCalendarProbe {
  const configured = connectors.filter(connector => DEFAULT_ON_SOURCE_CONNECTOR_NAMES.includes(connector.name));
  if (google === 'answered' || configured.some(connector => connector.problem === null)) {
    return 'answered';
  }
  if (google === 'needs_reconnect') {
    return 'google_needs_reconnect';
  }
  if (configured.length > 0 || google === 'no_answer') {
    return 'no_answer';
  }
  return 'not_set_up';
}

function mailCalendarItem(probe: MailCalendarProbe): HelpHealthItem {
  const base: ItemBase = { id: MAIL_CALENDAR_ITEM_ID, name: 'Email and calendar', settings_section: 'connectors' };
  switch (probe) {
    case 'answered':
      return { ...base, status: 'pass', message: 'Email and calendar answered.', next_step: null };
    case 'google_needs_reconnect':
      return {
        ...base,
        status: 'fail',
        message: 'Your Google login needs you to sign in again.',
        next_step: 'Open Settings, Connectors, choose Google and sign in again.',
      };
    case 'no_answer':
      return {
        ...base,
        status: 'fail',
        message: 'Email and calendar did not answer.',
        next_step: 'Open Settings, Connectors and check the cards for your email and your calendar.',
      };
    case 'not_set_up':
      return {
        ...base,
        status: 'not_set_up',
        message: 'Email and calendar are not set up yet.',
        next_step: 'Open Settings, Connectors and connect your email and your calendar there.',
      };
  }
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
      settings_section: null,
    }));
}

/** One plain sentence per connector problem, so the guide can say what went wrong without a token or URL. */
function connectorLastError(problem: ConnectorProblem | null): string | null {
  switch (problem) {
    case null:
      return null;
    case 'needs_sign_in':
      return 'It needs you to sign in to it again.';
    case 'no_answer':
      return 'It did not answer.';
    case 'unreadable':
      return 'Its saved settings could not be read.';
  }
}

/** The name of the Google card in Settings, Connectors. */
const GOOGLE_CONNECTOR_NAME = 'Google';

/**
 * The built-in Google login is one connector among the others the guide reads, listed only once a login
 * exists. A person who never connected Google sees no Google entry at all.
 */
function googleLoginAsConnector(google: GoogleLoginProbe): ConnectorProbe | null {
  switch (google) {
    case 'not_set_up':
      return null;
    case 'answered':
      return { name: GOOGLE_CONNECTOR_NAME, problem: null };
    case 'needs_reconnect':
      return { name: GOOGLE_CONNECTOR_NAME, problem: 'needs_sign_in' };
    case 'no_answer':
      return { name: GOOGLE_CONNECTOR_NAME, problem: 'no_answer' };
  }
}

/**
 * The state the guide reads to say what to do next. Setup steps follow the first-run list on Home:
 * a model is chosen, and the person's name is saved.
 */
function helpState(results: HelpProbeResults): HelpState {
  const google = googleLoginAsConnector(results.google);
  const connectors: HelpConnectorState[] = [...results.connectors, ...(google === null ? [] : [google])].map(
    connector => ({
      name: connector.name,
      connected: connector.problem === null,
      last_error: connectorLastError(connector.problem),
    }),
  );
  return {
    setup_steps: [
      { id: 'model', done: results.model.kind !== 'no_default' },
      { id: 'about_you', done: results.profileNamed },
    ],
    connectors,
    sandbox_ready: results.sandboxReady,
    app_version: results.app.version,
    build_ref: results.app.buildRef,
  };
}

/** Builds the help check from the probe results. Model comes first, so a missing model is the first thing shown. */
export function buildHelpHealthCheck({ results, now }: { results: HelpProbeResults; now: Date }): HelpHealthCheck {
  const mailCalendar = mailCalendarProbe({ connectors: results.connectors, google: results.google });
  return {
    checked_at: now.toISOString(),
    model_ready: results.model.kind === 'answered',
    items: [
      modelItem(results.model),
      connectorsItem(results.connectors),
      sandboxItem(results.sandboxReady),
      schedulesItem(results.scheduler),
      mailCalendarItem(mailCalendar),
      ...hostReportItems(results.hostReport),
    ],
    host_report: hostReportSection(results.hostReport),
    state: helpState(results),
  };
}
