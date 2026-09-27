import { describe, expect, it } from 'vitest';

import type { AppBugReportBundle, BugReportBundle } from '@/components/BugReportContext.js';
import {
  buildHandoffTitle,
  buildIssuePrefillUrl,
  MAX_HANDOFF_URL_CHARS,
  summarizeBundleForIssue,
} from '@/utils/bugReportHandoff.js';

const BASE_URL = 'https://github.com/acme/repo/issues/new?template=bug_report.yml';

describe('buildHandoffTitle', () => {
  it('prefixes the first description line with [Bug]', () => {
    expect(buildHandoffTitle('Search broke\nSecond line')).toBe('[Bug] Search broke');
  });

  it('falls back to a generic title for an empty description', () => {
    expect(buildHandoffTitle('   ')).toBe('[Bug] Report from the app');
  });

  it('truncates long titles instead of overflowing the issue title', () => {
    const title = buildHandoffTitle('x'.repeat(200));
    expect(title.length).toBeLessThanOrEqual('[Bug] '.length + 80);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('buildIssuePrefillUrl', () => {
  it('pre-fills the template fields as query parameters', () => {
    const url = new URL(
      buildIssuePrefillUrl({
        baseIssueUrl: BASE_URL,
        title: '[Bug] Search broke',
        fields: { whatHappened: 'I searched and nothing came back.', version: '0.1.4' },
      }),
    );
    expect(url.searchParams.get('title')).toBe('[Bug] Search broke');
    expect(url.searchParams.get('what-happened')).toBe('I searched and nothing came back.');
    expect(url.searchParams.get('version')).toBe('0.1.4');
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
  });

  it('leaves empty fields out of the URL', () => {
    const url = new URL(buildIssuePrefillUrl({ baseIssueUrl: BASE_URL, title: '[Bug] x', fields: {} }));
    expect(url.searchParams.has('what-happened')).toBe(false);
    expect(url.searchParams.has('logs')).toBe(false);
  });

  it('adds the template when the configured base URL omits it', () => {
    const url = new URL(
      buildIssuePrefillUrl({
        baseIssueUrl: 'https://github.com/acme/repo/issues/new',
        title: '[Bug] x',
        fields: {},
      }),
    );
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
  });

  it('bounds the description prefill so a long report cannot blow up the URL', () => {
    const url = new URL(
      buildIssuePrefillUrl({
        baseIssueUrl: BASE_URL,
        title: '[Bug] x',
        fields: { whatHappened: 'x'.repeat(8000) },
      }),
    );
    const whatHappened = url.searchParams.get('what-happened') ?? '';
    expect(whatHappened.length).toBeLessThanOrEqual(2000);
    expect(whatHappened.endsWith('… (truncated — the full bundle is in the downloaded .json)')).toBe(true);
  });

  it('keeps the final URL under the deliberate ceiling even for adversarial unicode', () => {
    // Astral chars encode to 12 chars each: a raw-char cap alone would still overflow.
    const url = buildIssuePrefillUrl({
      baseIssueUrl: BASE_URL,
      title: '[Bug] x',
      fields: {
        whatHappened: '😀'.repeat(8000),
        logs: '💥'.repeat(4000),
        environment: 'z'.repeat(5000),
      },
    });
    expect(url.length).toBeLessThanOrEqual(MAX_HANDOFF_URL_CHARS);
    const parsed = new URL(url);
    // The bundle summary (logs) survives; the reporter's free text is shed first.
    expect(parsed.searchParams.get('logs')).toContain('💥');
  });

  it('keeps a realistic worst-case handoff URL under the ceiling', () => {
    const bundle = sessionBundle();
    bundle.summary = Array.from({ length: 500 }, (_, i) => `Turn ${String(i)}: ${'x'.repeat(200)}`);
    const fields = summarizeBundleForIssue(bundle);
    const url = buildIssuePrefillUrl({
      baseIssueUrl: BASE_URL,
      title: buildHandoffTitle('y'.repeat(8000)),
      fields: { ...fields, whatHappened: 'z'.repeat(8000) },
    });
    expect(url.length).toBeLessThanOrEqual(MAX_HANDOFF_URL_CHARS);
  });
});

function sessionBundle(): BugReportBundle {
  return {
    schema_version: 1,
    generated_at: '2026-09-05T00:00:00.000Z',
    build: { version: '0.1.4' },
    session: {
      id: 's1',
      agent_name: null,
      model: 'local',
      created_at: '2026-09-05T00:00:00.000Z',
      connectors: ['parallel-web'],
      skills: [],
      sandbox_enabled: true,
    },
    user_description: '',
    summary: ['Turn 1: user wrote 30 chars. No tools ran. Turn finished after 2 s.'],
    trace: [
      {
        turn_id: 't1',
        events: [
          { type: 'turn.created', at_ms: 0 },
          { type: 'tool.response.v2', tool_name: 'exec', outcome: 'executed_nonzero', exit_code: 1 },
        ],
      },
    ],
    recent_errors: [{ event_type: 'tool.response.v2', code: 'E1', message: 'Something failed', turn_id: 't1' }],
    config_flags: { sandbox_enabled: false, skill_enabled: false, settings_enabled: true },
    redaction: { stripped_fields: [], notes: 'structure only' },
  };
}

describe('summarizeBundleForIssue', () => {
  it('summarizes a session bundle with counts, errors, and environment facts', () => {
    const fields = summarizeBundleForIssue(sessionBundle());
    expect(fields.version).toBe('0.1.4');
    expect(fields.logs).toContain('1 turn');
    expect(fields.logs).toContain('2 events');
    expect(fields.logs).toContain('Something failed');
    expect(fields.environment).toContain('parallel-web');
    // The issue fields never carry the reporter's description; the caller passes it separately.
    expect(fields.whatHappened).toBeUndefined();
  });

  it('summarizes an app bundle without any session data', () => {
    const bundle: AppBugReportBundle = {
      schema_version: 1,
      generated_at: '2026-09-05T00:00:00.000Z',
      build: { version: '0.1.4' },
      user_description: 'It broke',
      config_flags: { sandbox_enabled: true, skill_enabled: false, settings_enabled: true },
      redaction: { stripped_fields: ['session.id and all session metadata (no session is attached)'], notes: 'n' },
    };
    const fields = summarizeBundleForIssue(bundle);
    expect(fields.logs).toContain('No session attached');
    expect(fields.environment).toContain('sandbox on');
    expect(fields.logs?.length).toBeLessThanOrEqual(4000);
  });

  it('bounds the logs field so the handoff URL stays small', () => {
    const bundle = sessionBundle();
    bundle.summary = Array.from({ length: 500 }, (_, i) => `Turn ${String(i)}: ${'x'.repeat(200)}`);
    const fields = summarizeBundleForIssue(bundle);
    expect(fields.logs?.length).toBeLessThanOrEqual(4000);
    expect(fields.logs).toContain('truncated');
  });
});
