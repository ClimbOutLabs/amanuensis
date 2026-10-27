import { describe, expect, it } from 'vitest';

import {
  recoveredToolCallIds,
  stepNoticesByCallId,
  toolStepErrored,
  toolStepUnfinished,
  type StepPart,
} from '@/utils/recoveredSteps.js';

const PLAIN_LINE = 'I could not finish one of the steps in this reply. Ask me to try again.';

function envelope(outcome: Record<string, unknown>): string {
  return JSON.stringify({ schema_version: 'tool.response.v2', outcome, result: {} });
}

const REFUSED = envelope({
  disposition: 'never_ran',
  remediation: { reason_code: 'tool_pre_dispatch_failed', message: PLAIN_LINE, suggested_action: 'contact_user' },
});
const DONE = envelope({ disposition: 'executed_ok' });
const FAILED = envelope({ disposition: 'executed_nonzero' });

function call({
  id,
  tool = 'update_space',
  args,
  argsText: givenArgsText,
  cutOff = false,
  result,
}: {
  id: string;
  tool?: string;
  args?: Record<string, unknown>;
  argsText?: string;
  cutOff?: boolean;
  result?: string;
}): StepPart {
  const argsText = givenArgsText ?? (cutOff ? '{"name":"Garden plan","body":"- [ ] Plant' : JSON.stringify(args ?? {}));
  return { type: 'tool-call', toolCallId: id, toolName: tool, argsText, ...(result === undefined ? {} : { result }) };
}

describe('recoveredToolCallIds', () => {
  it('marks a cut-off call that the same tool then finished', () => {
    const parts = [
      call({ id: 'a', cutOff: true, result: REFUSED }),
      call({ id: 'b', cutOff: true, result: REFUSED }),
      call({ id: 'c', args: { name: 'Garden plan' }, result: DONE }),
    ];
    expect([...recoveredToolCallIds(parts)].sort()).toEqual(['a', 'b']);
  });

  it('marks a failed call that a later call about the same thing finished, however the thing is named', () => {
    const parts = [
      call({ id: 'a', args: { space_name: 'Garden Plan' }, result: FAILED }),
      call({ id: 'b', args: { name: ' garden plan ', body: 'x' }, result: DONE }),
    ];
    expect(recoveredToolCallIds(parts).has('a')).toBe(true);
  });

  it('keeps a failure when the later success was about a different thing', () => {
    const parts = [
      call({ id: 'a', args: { space_name: 'Garden Plan' }, result: FAILED }),
      call({ id: 'b', args: { space_name: 'Harbour Market' }, result: DONE }),
    ];
    expect(recoveredToolCallIds(parts).size).toBe(0);
  });

  it('keeps a cut-off call when the same tool later finished a call about a different thing', () => {
    const parts = [
      call({ id: 'a', argsText: '{"space_name":"Harbour Market","body":"- [ ] Book the', result: REFUSED }),
      call({ id: 'b', args: { space_name: 'Garden plan' }, result: DONE }),
    ];
    expect(recoveredToolCallIds(parts).size).toBe(0);
  });

  it('keeps a call cut off before it finished naming its target, even when the tool later finished', () => {
    const parts = [
      call({ id: 'a', argsText: '{"space_na', result: REFUSED }),
      call({ id: 'b', args: { space_name: 'Garden plan' }, result: DONE }),
    ];
    expect(recoveredToolCallIds(parts).size).toBe(0);
  });

  it('keeps a failure whose arguments are readable but name nothing, even when the tool later finished', () => {
    const parts = [
      call({ id: 'a', args: { body: 'x' }, result: FAILED }),
      call({ id: 'b', args: { body: 'y' }, result: DONE }),
    ];
    expect(recoveredToolCallIds(parts).size).toBe(0);
  });

  it('keeps a failure when only a different tool finished, or the finish came first', () => {
    expect(
      recoveredToolCallIds([
        call({ id: 'a', cutOff: true, result: REFUSED }),
        call({ id: 'b', tool: 'create_space', args: { name: 'Garden plan' }, result: DONE }),
      ]).size,
    ).toBe(0);
    expect(
      recoveredToolCallIds([
        call({ id: 'b', args: { name: 'Garden plan' }, result: DONE }),
        call({ id: 'a', cutOff: true, result: REFUSED }),
      ]).size,
    ).toBe(0);
  });

  it('keeps a failure when the later call has not finished', () => {
    const parts = [call({ id: 'a', cutOff: true, result: REFUSED }), call({ id: 'b', args: { name: 'Garden plan' } })];
    expect(recoveredToolCallIds(parts).size).toBe(0);
  });

  it('reads calls made inside a helper thread too', () => {
    const helper: StepPart = {
      type: 'tool-call',
      toolCallId: 'helper',
      toolName: 'create_sub_agent',
      messages: [{ content: [call({ id: 'inner', args: { name: 'Garden plan' }, result: DONE })] }],
    };
    expect(recoveredToolCallIds([call({ id: 'a', cutOff: true, result: REFUSED }), helper]).has('a')).toBe(true);
  });
});

describe('stepNoticesByCallId', () => {
  it('says a refusal once, on the first call that carries it, and nothing for recovered calls', () => {
    const parts = [
      call({ id: 'a', cutOff: true, result: REFUSED }),
      call({ id: 'b', tool: 'send_draft', args: { to: 'x' }, result: REFUSED }),
      call({ id: 'c', tool: 'send_draft', args: { to: 'y' }, result: REFUSED }),
      call({ id: 'd', args: { name: 'Garden plan' }, result: DONE }),
    ];
    const notices = stepNoticesByCallId({ parts, recovered: recoveredToolCallIds(parts) });
    expect([...notices.entries()]).toEqual([['b', [PLAIN_LINE]]]);
  });

  it('files a helper thread notice under the helper call that owns it', () => {
    const helper: StepPart = {
      type: 'tool-call',
      toolCallId: 'helper',
      toolName: 'create_sub_agent',
      messages: [{ content: [call({ id: 'inner', result: REFUSED })] }],
    };
    const notices = stepNoticesByCallId({ parts: [helper], recovered: new Set() });
    expect([...notices.entries()]).toEqual([['helper', [PLAIN_LINE]]]);
  });
});

describe('step outcome', () => {
  it('counts an error result as errored, and any result but a finished one as unfinished', () => {
    const blocked = call({ id: 'a', result: envelope({ disposition: 'policy_blocked' }) });
    expect(toolStepErrored(call({ id: 'a', result: FAILED }))).toBe(true);
    expect(toolStepErrored(blocked)).toBe(false);
    expect(toolStepUnfinished(blocked)).toBe(true);
    expect(toolStepUnfinished(call({ id: 'b', result: DONE }))).toBe(false);
    expect(toolStepUnfinished({ type: 'text' })).toBe(false);
  });
});
