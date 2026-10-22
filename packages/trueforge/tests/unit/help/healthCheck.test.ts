import { buildHelpHealthCheck, type HelpProbeResults } from '../../../src/help/healthCheck';
import type { HostReportRead } from '../../../src/help/hostReport';
import type { HostReportFile } from '../../../src/schemas/help';

const NOW = new Date('2026-10-21T09:00:00Z');

const HEALTHY_MODEL: HelpProbeResults['model'] = { kind: 'answered' };

const REPORT: HostReportFile = {
  schema_version: 1,
  command: 'doctor',
  checked_at: '2026-10-20T08:30:00Z',
  overall: 'fail',
  checks: [
    { id: 'docker', name: 'Docker', status: 'pass', message: 'Docker is running.', next_step: null },
    {
      id: 'disk_space',
      name: 'Disk space',
      status: 'warn',
      message: 'Disk space is getting low.',
      next_step: 'Free up some space on your computer.',
    },
    {
      id: 'ports',
      name: 'Ports',
      status: 'fail',
      message: 'Port 8791 is in use by another program.',
      next_step: 'Stop the other program, then run aman doctor again.',
    },
  ],
};

function results(overrides: Partial<HelpProbeResults> = {}): HelpProbeResults {
  return {
    model: HEALTHY_MODEL,
    connectors: [{ name: 'linear', ok: true }],
    google: 'not_set_up',
    sandboxReady: true,
    scheduler: 'running',
    hostReport: { state: 'ok', report: REPORT },
    ...overrides,
  };
}

function build(overrides: Partial<HelpProbeResults> = {}) {
  return buildHelpHealthCheck({ results: results(overrides), now: NOW });
}

function item(check: ReturnType<typeof build>, id: string) {
  const found = check.items.find(candidate => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no help item ${id}`);
  }
  return found;
}

describe('buildHelpHealthCheck', () => {
  it('puts the model first and shows it as the first red item when no model is connected', () => {
    const check = build({ model: { kind: 'no_default' } });

    expect(check.items[0]).toEqual({
      id: 'model',
      name: 'Your model',
      status: 'fail',
      message: 'No model is connected.',
      next_step: 'Add one in Settings, Models. Token Factory is one option.',
    });
    expect(check.model_ready).toBe(false);
  });

  it('shows an unreachable model as a failed first item with one next step', () => {
    const check = build({ model: { kind: 'no_answer' } });

    expect(check.items[0]).toMatchObject({ id: 'model', status: 'fail', message: 'The model did not answer in time.' });
    expect(check.items[0]?.next_step).toBe('Check the model key in Settings, Models. Then press Check again.');
    expect(check.model_ready).toBe(false);
  });

  it('marks a misconfigured default model as not ready', () => {
    const check = build({ model: { kind: 'misconfigured' } });

    expect(item(check, 'model')).toMatchObject({ status: 'fail', next_step: 'Check the model in Settings, Models.' });
    expect(check.model_ready).toBe(false);
  });

  it('is all green when every check passes, and reports the model as ready', () => {
    const check = build({ hostReport: { state: 'ok', report: { ...REPORT, checks: REPORT.checks.slice(0, 1) } } });

    expect(check.model_ready).toBe(true);
    expect(check.items.every(candidate => candidate.status === 'pass' || candidate.status === 'not_set_up')).toBe(true);
    expect(check.items.map(candidate => candidate.id)).toEqual([
      'model',
      'connectors',
      'sandbox',
      'schedules',
      'mail_calendar',
    ]);
  });

  it('lists connectors that did not answer by name only, and asks the person to check them', () => {
    const check = build({
      connectors: [
        { name: 'linear', ok: true },
        { name: 'notion', ok: false },
      ],
    });

    expect(item(check, 'connectors')).toEqual({
      id: 'connectors',
      name: 'Connectors',
      status: 'fail',
      message: 'These connectors did not answer: notion.',
      next_step: 'Open Settings, Connectors and check each one.',
    });
  });

  it('says no connectors are set up without calling it a fault', () => {
    expect(item(build({ connectors: [] }), 'connectors')).toMatchObject({
      status: 'not_set_up',
      message: 'No connectors are set up yet.',
    });
  });

  it('warns when the sandbox is not ready and gives the Settings path', () => {
    expect(item(build({ sandboxReady: false }), 'sandbox')).toEqual({
      id: 'sandbox',
      name: 'Sandbox',
      status: 'warn',
      message: 'The sandbox is not ready.',
      next_step: 'Check Settings, Sandbox.',
    });
  });

  it('fails when schedules have stopped and says it is not set up when they run elsewhere', () => {
    expect(item(build({ scheduler: 'stopped' }), 'schedules')).toMatchObject({ status: 'fail' });
    expect(item(build({ scheduler: 'elsewhere' }), 'schedules')).toMatchObject({ status: 'not_set_up' });
  });

  it('reports mail and calendar as not set up only when no Google login or mail connector is configured', () => {
    expect(item(build(), 'mail_calendar')).toMatchObject({
      status: 'not_set_up',
      message: 'Email and calendar are not set up yet.',
    });
  });

  it('reports mail and calendar OK when a configured mail or calendar connector answers', () => {
    const check = build({ connectors: [{ name: 'Email', ok: true }] });

    expect(item(check, 'mail_calendar')).toMatchObject({ status: 'pass', message: 'Email and calendar answered.' });
  });

  it('reports mail and calendar OK when the built-in Google login answers, with no connector', () => {
    expect(item(build({ google: 'answered' }), 'mail_calendar')).toMatchObject({ status: 'pass' });
  });

  it('reports mail and calendar as failed, not as not set up, when a configured connector does not answer', () => {
    const check = build({ connectors: [{ name: 'Calendar', ok: false }] });

    expect(item(check, 'mail_calendar')).toMatchObject({
      status: 'fail',
      message: 'Email and calendar did not answer.',
    });
  });

  it('asks for a new sign-in when the Google login needs connecting again', () => {
    expect(item(build({ google: 'needs_reconnect' }), 'mail_calendar')).toMatchObject({
      status: 'fail',
      message: 'Google needs to be connected again.',
    });
  });

  it('shows the model test answering as OK in the first item', () => {
    expect(build().items[0]).toMatchObject({ id: 'model', status: 'pass', message: 'The model answered.' });
  });

  it('maps failed and warned host report checks into the same list, and leaves passes out', () => {
    const check = build();

    expect(check.items.map(candidate => candidate.id)).toContain('host_disk_space');
    expect(check.items.map(candidate => candidate.id)).toContain('host_ports');
    expect(check.items.map(candidate => candidate.id)).not.toContain('host_docker');
    expect(item(check, 'host_ports')).toMatchObject({ status: 'fail', name: 'Ports' });
  });

  it('shows the last full check time and no message when the report is fresh', () => {
    expect(build().host_report).toEqual({
      state: 'ok',
      checked_at: '2026-10-20T08:30:00Z',
      message: null,
      next_step: null,
    });
  });

  it('says no full check has been run yet when the report is missing', () => {
    const missing: HostReportRead = { state: 'missing' };

    expect(build({ hostReport: missing }).host_report).toEqual({
      state: 'missing',
      checked_at: null,
      message:
        'A deeper check has not been run yet. To run one, open a terminal on the computer running Aman and type: aman doctor',
      next_step: null,
    });
  });

  it('treats an unreadable report as missing and says so', () => {
    const section = build({ hostReport: { state: 'invalid' } }).host_report;

    expect(section.state).toBe('invalid');
    expect(section.message).toBe(
      'The last full check could not be read, so it is treated as missing. A deeper check has not been run yet. To run one, open a terminal on the computer running Aman and type: aman doctor',
    );
  });

  it('says a stale report is more than seven days old and suggests running aman doctor again', () => {
    const section = build({ hostReport: { state: 'stale', report: REPORT } }).host_report;

    expect(section.state).toBe('stale');
    expect(section.checked_at).toBe('2026-10-20T08:30:00Z');
    expect(section.message).toBe(
      'The last full check is more than 7 days old. A deeper check has not been run yet. To run one, open a terminal on the computer running Aman and type: aman doctor',
    );
  });
});
