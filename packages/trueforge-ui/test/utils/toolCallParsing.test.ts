import { describe, expect, it } from 'vitest';

import {
  buildApprovalOptions,
  buildOutcomeText,
  formatDuration,
  getAskUserAnswerResult,
  getJsonDisplayValue,
  getToolFailureReason,
  getToolResultContent,
  mcpDisplayName,
  parseAskUserQuestionArgs,
  parseMcpToolArgs,
  parseSandboxArgs,
  parseSandboxResult,
  parseToolResultDisposition,
  toStatus,
} from '@/utils/toolCallParsing.js';

describe('toolCallParsing', () => {
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
    expect(mcpDisplayName('call_tool', 'github', 'search')).toBe('call_tool: search (github)');
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
    expect(buildOutcomeText(disposition, 'the tool timed out')).toBe('Execution failed: the tool timed out');
    expect(buildOutcomeText(undefined, 'x')).toBeUndefined();
  });

  it('builds default approval options when none declared', () => {
    expect(buildApprovalOptions(undefined)).toEqual([
      { id: 'allow-once', label: 'Allow once', isAllow: true },
      { id: 'deny', label: 'Deny', isAllow: false, confirm: {} },
    ]);
  });
});
