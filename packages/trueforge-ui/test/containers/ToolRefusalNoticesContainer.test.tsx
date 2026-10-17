// @vitest-environment jsdom
import type { ThreadMessage } from '@assistant-ui/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolRefusalNoticesContainer } from '@/containers/ToolRefusalNoticesContainer.js';

type AssistantPart = Extract<ThreadMessage, { role: 'assistant' }>['content'][number];

const LINE = 'Nothing was sent: it did not say who gets it. The assistant needs to name each person.';

function result({ disposition, action, message }: { disposition: string; action: string; message: string }): string {
  return JSON.stringify({
    schema_version: 'tool.response.v2',
    outcome: { disposition, remediation: { reason_code: 'tool_policy_blocked', message, suggested_action: action } },
    result: { error: 'Auto-denied.' },
  });
}

function call({ toolCallId, result: toolResult }: { toolCallId: string; result?: string }): AssistantPart {
  return {
    type: 'tool-call',
    toolCallId,
    toolName: 'reply',
    args: {},
    argsText: '{}',
    ...(toolResult === undefined ? {} : { result: toolResult }),
  };
}

const notices = () => screen.queryAllByTestId('tool-refusal-notice').map(notice => notice.textContent);

describe('ToolRefusalNoticesContainer', () => {
  it('shows the owner line of a refused send once, even when the call is retried', () => {
    const refused = result({ disposition: 'policy_blocked', action: 'contact_user', message: LINE });
    render(
      <ToolRefusalNoticesContainer
        parts={[call({ toolCallId: 'c1', result: refused }), call({ toolCallId: 'c2', result: refused })]}
      />,
    );
    expect(notices()).toEqual([LINE]);
  });

  it('shows nothing for other results', () => {
    const { container } = render(
      <ToolRefusalNoticesContainer
        parts={[
          { type: 'text', text: 'Hello' },
          call({ toolCallId: 'c1' }),
          call({
            toolCallId: 'c2',
            result: result({ disposition: 'policy_blocked', action: 'change_strategy', message: 'Use another tool.' }),
          }),
          call({
            toolCallId: 'c3',
            result: result({ disposition: 'never_ran', action: 'contact_user', message: 'Saved for later.' }),
          }),
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
