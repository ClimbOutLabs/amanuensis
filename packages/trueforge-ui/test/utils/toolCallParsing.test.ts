import { describe, expect, it } from 'vitest';

import {
  buildApprovalOptions,
  buildOutcomeText,
  formatDuration,
  getAskUserAnswerResult,
  getJsonDisplayValue,
  getToolFailureReason,
  getToolResultContent,
  parseAskUserQuestionArgs,
  parseMcpToolArgs,
  parseSandboxArgs,
  parseSandboxResult,
  parseToolResultDisposition,
  plainActionTypeLabel,
  plainStepTitle,
  toStatus,
} from '@/utils/toolCallParsing.js';

describe('toolCallParsing', () => {
  it('titles steps with plain actions, never tool names', () => {
    expect(plainStepTitle('list_inbox_threads')).toBe('Checked your inbox');
    expect(plainStepTitle('list_events')).toBe('Checked your calendar');
    expect(plainStepTitle('run_code')).toBe('Ran code');
    expect(plainStepTitle('web_search')).toBe('Searched the web');
    // A connector call is titled by its inner tool, with no server name attached.
    expect(plainStepTitle('exa__web_fetch')).toBe('Read a web page');
    // A file read names the file it read.
    expect(plainStepTitle('read_file', JSON.stringify({ path: '/home/sam/notes.md' }))).toBe(
      'Read: /home/sam/notes.md',
    );
    expect(plainStepTitle('read_file', '{}')).toBe('Read a file');
    expect(plainStepTitle('read_file', 'not json')).toBe('Read a file');
    // An unlisted tool is humanized, never shown in snake_case.
    expect(plainStepTitle('frobnicate_thing')).toBe('Frobnicate Thing');
    expect(plainStepTitle('get_weather_forecast')).toBe('Checked weather forecast');
  });

  it('labels audit rows in plain words, never with the tool id', () => {
    expect(plainActionTypeLabel('file_write')).toBe('Write files');
    expect(plainActionTypeLabel('web_search')).toBe('Searched the web');
    expect(plainActionTypeLabel('exec')).toBe('Ran a command');
  });

  it('parses ask-user args', () => {
    expect(parseAskUserQuestionArgs(JSON.stringify({ question: 'Pick one', options: ['a', 'b', 3] }))).toEqual({
      question: 'Pick one',
      options: ['a', 'b'],
    });
    expect(parseAskUserQuestionArgs('not-json')).toEqual({});
  });

  it('reads ask-user answers from string or content object', () => {
    expect(getAskUserAnswerResult('  yes  ')).toBe('yes');
    expect(getAskUserAnswerResult({ content: 'no' })).toBe('no');
    expect(
      getAskUserAnswerResult(
        JSON.stringify({
          schema_version: 'tool.response.v2',
          outcome: { disposition: 'executed_ok' },
          result: 'maybe',
        }),
      ),
    ).toBe('maybe');
    expect(getAskUserAnswerResult('')).toBeUndefined();
  });

  it('formats durations', () => {
    expect(formatDuration(500)).toBe('<1s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(15000)).toBe('15s');
    expect(formatDuration(125000)).toBe('2m 5s');
  });

  it('formats hour-long durations with an hour branch, not runaway minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(7_500_000)).toBe('2h 5m');
    expect(formatDuration(3_599_999)).toBe('59m 59s');
  });

  it('maps status types', () => {
    expect(toStatus('complete')).toBe('success');
    expect(toStatus('incomplete')).toBe('error');
    expect(toStatus('running')).toBe('running');
  });

  it('parses sandbox args and results', () => {
    expect(parseSandboxArgs(JSON.stringify({ command: 'ls', intent: 'list' }))).toMatchObject({
      command: 'ls',
      intent: 'list',
    });
    expect(parseSandboxArgs('{"command":"pnpm test","intent":"still stream')).toEqual({
      command: 'pnpm test',
      intent: 'still stream',
      argsJson: '{"command":"pnpm test","intent":"still stream',
    });
    expect(parseSandboxResult(JSON.stringify({ response: { exitCode: 0, result: 'ok' } }))).toMatchObject({
      exitCode: 0,
      resultText: 'ok',
    });
    expect(
      parseSandboxResult(
        JSON.stringify({
          schema_version: 'tool.response.v2',
          outcome: { disposition: 'executed_ok' },
          result: { response: { exitCode: 0, result: 'verified' } },
        }),
      ),
    ).toEqual({
      exitCode: 0,
      resultText: 'verified',
      resultJson: JSON.stringify({ response: { exitCode: 0, result: 'verified' } }, null, 2),
    });
    expect(parseSandboxResult('{"response":{"exitCode":0,"result":"streamed output"')).toEqual({
      exitCode: 0,
      resultText: 'streamed output',
      resultJson: '{"response":{"exitCode":0,"result":"streamed output"',
    });
    expect(parseSandboxResult('plain')).toEqual({ resultText: 'plain' });
    expect(
      parseSandboxResult(
        JSON.stringify({
          response: { exitCode: 0, result: 'ok' },
          notices: ["The skill echo couldn't be loaded, so Aman is working without it."],
        }),
      ),
    ).toMatchObject({
      exitCode: 0,
      notices: ["The skill echo couldn't be loaded, so Aman is working without it."],
    });
  });

  it('buffers structured edit arguments until complete and summarizes the patch', () => {
    expect(parseSandboxArgs('{"intent":"Update the UI","patch":"diff --git a/a', 'apply_patch')).toEqual({
      intent: 'Update the UI',
    });

    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1,2 @@',
      '-old',
      '+new',
      '+line',
    ].join('\n');
    expect(parseSandboxArgs(JSON.stringify({ intent: 'Update the UI', cwd: '/repo', patch }), 'apply_patch')).toEqual(
      expect.objectContaining({
        intent: 'Update the UI',
        summary: '1 file · +2 −1',
        argsJson: expect.stringContaining('diff --git a/a.ts b/a.ts'),
      }),
    );
  });

  it('parses mcp tool args and display names', () => {
    expect(
      parseMcpToolArgs(
        JSON.stringify({
          mcp_server: 'github',
          tool_name: 'search',
          input: { q: 'x' },
        }),
      ),
    ).toEqual({
      mcpServer: 'github',
      innerToolName: 'search',
      input: { q: 'x' },
    });
  });

  it('pretty-prints json display values', () => {
    expect(getJsonDisplayValue('{"a":1}')).toEqual({
      value: '{\n  "a": 1\n}',
      isJson: true,
    });
    expect(getJsonDisplayValue('{"a":1,"streaming":"unfinished')).toEqual({
      value: '{"a":1,"streaming":"unfinished',
      isJson: false,
    });
    expect(getJsonDisplayValue('hello')).toEqual({
      value: 'hello',
      isJson: false,
    });
  });

  it('extracts tool result content arrays', () => {
    expect(getToolResultContent({ content: [{ text: '{"ok":true}' }] })).toEqual({
      data: '{\n  "ok": true\n}',
      isJson: true,
    });
  });

  it('extracts a failure reason from remediation, then from the result content, and never for a success', () => {
    const withRemediation = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: {
        disposition: 'policy_blocked',
        remediation: { reason_code: 'x', message: 'Inspect the current workspace state.' },
      },
      result: 'ignored',
    });
    expect(getToolFailureReason(withRemediation, parseToolResultDisposition(withRemediation))).toBe(
      'Inspect the current workspace state.',
    );

    const withNestedMcpError = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_nonzero' },
      result: { error: [{ type: 'text', text: JSON.stringify({ error: 'call_tool rejected the tool_name' }) }] },
    });
    expect(getToolFailureReason(withNestedMcpError, parseToolResultDisposition(withNestedMcpError))).toBe(
      'call_tool rejected the tool_name',
    );

    const success = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: 'fine',
    });
    expect(getToolFailureReason(success, parseToolResultDisposition(success))).toBeUndefined();
    expect(getToolFailureReason(undefined, undefined)).toBeUndefined();
  });

  it('never shows a bare "Execution failed" outcome once a reason is known', () => {
    const disposition = parseToolResultDisposition(
      JSON.stringify({
        schema_version: 'tool.response.v2',
        outcome: { disposition: 'executed_nonzero' },
        result: 'irrelevant here',
      }),
    );
    expect(buildOutcomeText(disposition, undefined)).toBe('Execution failed');
    expect(buildOutcomeText(disposition, 'the tool timed out')).toBe('the tool timed out');
    expect(buildOutcomeText(undefined, 'x')).toBeUndefined();
  });

  it('shows a long failure reason in full, with no label in front of it', () => {
    const disposition = parseToolResultDisposition(
      JSON.stringify({
        schema_version: 'tool.response.v2',
        outcome: { disposition: 'executed_nonzero' },
        result: 'irrelevant here',
      }),
    );
    const apiOff =
      "The Google Calendar API isn't turned on in your Google project. Open Settings, Connectors, Google, open the Calendar API link in the Calendar section, select Enable, then try again.";
    const noPermission =
      "Google hasn't given Aman permission to read your calendar. Open Settings, Connectors, Google and connect Calendar.";
    expect(apiOff.length).toBeGreaterThan(140);
    expect(buildOutcomeText(disposition, apiOff)).toBe(apiOff);
    expect(buildOutcomeText(disposition, noPermission)).toBe(noPermission);
    expect(buildOutcomeText(disposition, apiOff)).not.toContain('Execution failed');
  });

  it('builds default approval options when none declared', () => {
    expect(buildApprovalOptions(undefined)).toEqual([
      { id: 'allow-once', label: 'Approve', hint: 'Allow this one call only.', isAllow: true },
      { id: 'deny', label: 'Deny', hint: 'Do not run this call.', isAllow: false, confirm: {} },
    ]);
  });

  it('labels declared options with the approval verbs, whatever label the server sent', () => {
    const labels = buildApprovalOptions([
      { id: 'deny', kind: 'reject-once' },
      { id: 'allow-chat', kind: 'allow-always', label: 'Allow `pnpm test` in this chat' },
      { id: 'allow-once', kind: 'allow-once' },
    ]).map(option => option.label);
    expect(labels).toEqual(['Approve', 'Approve for this chat', 'Deny']);
  });
});
