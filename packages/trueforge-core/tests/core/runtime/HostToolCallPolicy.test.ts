import type { InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import {
  applyHostToolCallPolicy,
  type HostToolCallPolicy,
  type HostToolCallPolicyCall,
} from '../../../src/core/runtime/HostToolCallPolicy';

function webSearchToolInfo(): InternalToolCallInfo {
  return {
    type: 'mcp',
    mcp_server_id: 'web-server',
    mcp_server_name: 'web',
    original_tool_name: 'web_search',
  };
}

function callForWebSearch(): HostToolCallPolicyCall {
  return {
    functionName: 'mcp__web__web_search',
    underlyingToolName: 'web_search',
    args: { query: 'solo bakery project sale price' },
  };
}

describe('applyHostToolCallPolicy', () => {
  it('returns the tool info untouched when no policy is configured', () => {
    const toolInfo = webSearchToolInfo();
    const result = applyHostToolCallPolicy({
      call: callForWebSearch(),
      toolInfo,
      policy: undefined,
      logger: undefined,
    });
    expect(result).toBe(toolInfo);
    expect(result.pre_dispatch_failure).toBeUndefined();
  });

  it('returns the tool info untouched when the policy allows the call', () => {
    const toolInfo = webSearchToolInfo();
    const policy: HostToolCallPolicy = () => undefined;
    const result = applyHostToolCallPolicy({ call: callForWebSearch(), toolInfo, policy, logger: undefined });
    expect(result).toBe(toolInfo);
    expect(result.pre_dispatch_failure).toBeUndefined();
  });

  it('stamps a policy_blocked failure when the policy blocks, preserving the rest of the tool info', () => {
    const toolInfo = webSearchToolInfo();
    const policy: HostToolCallPolicy = () => ({ message: 'library said no' });
    const result = applyHostToolCallPolicy({ call: callForWebSearch(), toolInfo, policy, logger: undefined });
    expect(result).not.toBe(toolInfo);
    expect(result.pre_dispatch_failure).toEqual({ kind: 'policy_blocked', message: 'library said no' });
    expect(result.type).toBe('mcp');
    expect(result.original_tool_name).toBe('web_search');
    expect(result.mcp_server_name).toBe('web');
  });

  it('never overwrites a pre-existing pre-dispatch failure, even when the policy would block', () => {
    const toolInfo: InternalToolCallInfo = {
      ...webSearchToolInfo(),
      pre_dispatch_failure: { kind: 'pre_dispatch_failed', message: 'server unreachable' },
    };
    const policy: HostToolCallPolicy = () => ({ message: 'library said no' });
    const result = applyHostToolCallPolicy({ call: callForWebSearch(), toolInfo, policy, logger: undefined });
    expect(result).toBe(toolInfo);
    expect(result.pre_dispatch_failure).toEqual({
      kind: 'pre_dispatch_failed',
      message: 'server unreachable',
    });
  });

  it('fails open when the policy throws: the turn continues without a block', () => {
    const toolInfo = webSearchToolInfo();
    const policy: HostToolCallPolicy = () => {
      throw new Error('policy bug');
    };
    const result = applyHostToolCallPolicy({ call: callForWebSearch(), toolInfo, policy, logger: undefined });
    expect(result).toBe(toolInfo);
    expect(result.pre_dispatch_failure).toBeUndefined();
  });

  it('fails open loudly when the policy throws: the failure is logged', () => {
    const toolInfo = webSearchToolInfo();
    const warnings: Array<{ message: string; meta: unknown[] }> = [];
    const policy: HostToolCallPolicy = () => {
      throw new Error('policy bug');
    };
    const result = applyHostToolCallPolicy({
      call: callForWebSearch(),
      toolInfo,
      policy,
      logger: { warn: (message: string, ...meta: unknown[]) => warnings.push({ message, meta }) },
    });
    expect(result).toBe(toolInfo);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('failing open');
  });

  it('fails open loudly on a malformed block: an empty message is never stamped', () => {
    const toolInfo = webSearchToolInfo();
    const warnings: string[] = [];
    const policy: HostToolCallPolicy = () => ({ message: '' });
    const result = applyHostToolCallPolicy({
      call: callForWebSearch(),
      toolInfo,
      policy,
      logger: { warn: (message: string) => warnings.push(message) },
    });
    expect(result).toBe(toolInfo);
    expect(result.pre_dispatch_failure).toBeUndefined();
    expect(warnings.some(w => w.includes('malformed block'))).toBe(true);
  });

  it('passes the resolved underlying tool name, not just the mapped function name', () => {
    const seen: HostToolCallPolicyCall[] = [];
    const policy: HostToolCallPolicy = call => {
      seen.push(call);
      return undefined;
    };
    const toolInfo = webSearchToolInfo();
    applyHostToolCallPolicy({
      call: { functionName: 'call_tool', underlyingToolName: 'web_search', args: { query: 'x' } },
      toolInfo,
      policy,
      logger: undefined,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.underlyingToolName).toBe('web_search');
    expect(seen[0]?.functionName).toBe('call_tool');
  });
});
