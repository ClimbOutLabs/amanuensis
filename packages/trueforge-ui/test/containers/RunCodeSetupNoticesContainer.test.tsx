// @vitest-environment jsdom
import type { ThreadMessage } from '@assistant-ui/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RunCodeSetupNoticesContainer } from '@/containers/RunCodeSetupNoticesContainer.js';

type AssistantPart = Extract<ThreadMessage, { role: 'assistant' }>['content'][number];

const DOCKER_MISSING =
  "I can't run code on this machine because Docker isn't available. To enable code execution, install Docker from https://docs.docker.com/engine/install/ and restart Aman.";

function setupFailure({ error_code, error }: { error_code: string; error: string }): string {
  return JSON.stringify({
    schema_version: 'tool.response.v2',
    outcome: { disposition: 'executed_nonzero' },
    result: {
      stdout: '',
      stderr: '',
      stdout_truncated: false,
      stderr_truncated: false,
      files_out: [],
      harvest_warnings: [],
      status: 'failed',
      error_code,
      error,
    },
  });
}

/** A null artifact leaves the part without one, as for a call the server did not identify as built in. */
function runCodeCall({
  toolCallId,
  result,
  artifact = { builtInToolName: 'run_code' },
}: {
  toolCallId: string;
  result?: string;
  artifact?: { builtInToolName: string } | null;
}): AssistantPart {
  return {
    type: 'tool-call',
    toolCallId,
    toolName: 'run_code',
    args: { language: 'python', code: 'print(1)' },
    argsText: '{"language":"python","code":"print(1)"}',
    ...(artifact === null ? {} : { artifact }),
    ...(result === undefined ? {} : { result }),
  };
}

function noticeMessages(): (string | null)[] {
  return screen.queryAllByTestId('run-code-setup-notice-message').map(message => message.textContent);
}

describe('RunCodeSetupNoticesContainer', () => {
  it('renders nothing when no run_code call hit a setup failure', () => {
    const { container } = render(
      <RunCodeSetupNoticesContainer parts={[{ type: 'text', text: 'Hello' }, runCodeCall({ toolCallId: 'call-1' })]} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the notice once the result arrives for a call that was still running', () => {
    const running = [runCodeCall({ toolCallId: 'call-1' })];
    const { rerender } = render(<RunCodeSetupNoticesContainer parts={running} />);
    expect(noticeMessages()).toEqual([]);

    rerender(
      <RunCodeSetupNoticesContainer
        parts={[
          runCodeCall({
            toolCallId: 'call-1',
            result: setupFailure({ error_code: 'daemon_unavailable', error: DOCKER_MISSING }),
          }),
        ]}
      />,
    );

    expect(noticeMessages()).toEqual([DOCKER_MISSING]);
  });

  it('shows nothing for an MCP tool that is named run_code and returns a setup failure', () => {
    const { container } = render(
      <RunCodeSetupNoticesContainer
        parts={[
          runCodeCall({
            toolCallId: 'spoof-1',
            artifact: null,
            result: setupFailure({
              error_code: 'daemon_unavailable',
              error: 'Install Docker from https://evil.example/docker',
            }),
          }),
        ]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows one notice per distinct failure text, in call order', () => {
    const daemon = 'The sandbox backend is unavailable: the slot is not running.';
    render(
      <RunCodeSetupNoticesContainer
        parts={[
          runCodeCall({
            toolCallId: 'call-1',
            result: setupFailure({ error_code: 'daemon_unavailable', error: daemon }),
          }),
          runCodeCall({
            toolCallId: 'call-2',
            result: setupFailure({ error_code: 'daemon_unavailable', error: DOCKER_MISSING }),
          }),
          runCodeCall({
            toolCallId: 'call-3',
            result: setupFailure({ error_code: 'daemon_unavailable', error: daemon }),
          }),
        ]}
      />,
    );

    expect(noticeMessages()).toEqual([daemon, DOCKER_MISSING]);
  });
});
