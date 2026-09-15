import { describe, expect, it } from 'vitest';

import {
  getToolResultContent,
  parseToolOutputScreen,
  parseToolResultDisposition,
} from '../../src/utils/toolCallParsing.js';

const BLOCKED_RESULT = JSON.stringify({
  schema_version: 'tool.response.v2',
  outcome: {
    disposition: 'policy_blocked',
    remediation: {
      reason_code: 'private_repository_fallback',
      message: 'Use the authenticated local checkout instead.',
      suggested_action: 'change_strategy',
    },
  },
  result: { error: 'Private repository fallback blocked' },
});

describe('tool result dispositions', () => {
  it('extracts disposition and remediation separately from result content', () => {
    expect(parseToolResultDisposition(BLOCKED_RESULT)).toEqual({
      disposition: 'policy_blocked',
      label: 'Blocked by policy',
      tone: 'warning',
      remediation: 'Use the authenticated local checkout instead.',
    });
    expect(getToolResultContent(BLOCKED_RESULT)).toEqual({
      data: JSON.stringify({ error: 'Private repository fallback blocked' }, null, 2),
      isJson: true,
    });
  });

  it('does not invent a disposition for a legacy result', () => {
    expect(parseToolResultDisposition('{"ok":true}')).toBeUndefined();
  });

  it.each([
    ['denied', 'muted'],
    ['policy_blocked', 'warning'],
    ['executed_ok', 'success'],
    ['executed_nonzero', 'error'],
    ['never_ran', 'warning'],
    ['outcome_unknown', 'warning'],
  ] as const)('maps %s to the %s presentation tone', (disposition, tone) => {
    const result = JSON.stringify({ schema_version: 'tool.response.v2', outcome: { disposition }, result: null });
    expect(parseToolResultDisposition(result)?.tone).toBe(tone);
  });

  it('does not infer v2 semantics from envelope-shaped legacy content', () => {
    const legacy = JSON.stringify({ outcome: { disposition: 'denied' }, result: 'legacy payload' });
    expect(parseToolResultDisposition(legacy)).toBeUndefined();
    expect(getToolResultContent(legacy)).toEqual({
      data: JSON.stringify({ outcome: { disposition: 'denied' }, result: 'legacy payload' }, null, 2),
      isJson: true,
    });
  });

  it('keeps the raw result visible while surfacing a screen withholding', () => {
    const raw = '<html>RED-TEAM-CANARY-7Q2X9</html>';
    const screened = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: {
        disposition: 'executed_ok',
        screen: {
          status: 'flagged',
          action: 'withheld',
          reason_code: 'classifier_malicious',
          score: 0.99,
        },
      },
      result: raw,
    });

    expect(parseToolOutputScreen(screened)).toEqual({
      action: 'withheld',
      label: 'Content withheld',
      tone: 'warning',
      reason: 'Possible prompt injection detected',
    });
    expect(getToolResultContent(screened)).toEqual({ data: raw, isJson: false });
  });
});
