/**
 * Defense in depth for RC1: even if a spec carrying skills somehow reaches the
 * turn layer with the sandbox disabled (validateAgentSpec 422s it at admit
 * time), resolveSandbox must not create a sandbox for it — no sandbox, no
 * <skills> prompt section, no silent skill advertising.
 */
import { AgentSpecSchema, type AgentSpec } from '../../src/agent-session/schemas/agentSpec';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import type { Sandbox } from '../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger, makeStubPublicSandbox } from '../core/harnessMocks';

function makeResolver(sandboxProvider: jest.Mock) {
  return new TurnResourceResolver({
    llm: () => Promise.reject(new Error('no llm in this test')),
    mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    sandboxProvider,
  });
}

function makeSpec(sandboxEnabled: boolean): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: 'test-provider/test-model' },
    instructions: 'test',
    skills: [{ name: 'demo' }],
    config: { sandbox: { enabled: sandboxEnabled } },
  });
}

function resolveInput(spec: AgentSpec) {
  return {
    spec,
    existing: undefined,
    previousTurn: undefined,
    tenant_id: 'tenant-1',
    created_by: 'user-1',
    session_id: 'session-1',
    turn_id: 'turn-1',
    signal: new AbortController().signal,
    tracing: NOOP_AGENT_TRACING,
  };
}

describe('TurnResourceResolver.resolveSandbox with skills', () => {
  it('returns undefined and never calls the sandbox factory when the sandbox is disabled, even with skills', async () => {
    const sandboxProvider = jest.fn((_input: unknown): Promise<Sandbox> => {
      throw new Error('sandbox factory must not be called');
    });
    const resolver = makeResolver(sandboxProvider);

    const sandbox = await resolver.resolveSandbox(resolveInput(makeSpec(false)));

    expect(sandbox).toBeUndefined();
    expect(sandboxProvider).not.toHaveBeenCalled();
    await resolver.close();
  });

  it('still creates a sandbox when the sandbox is enabled with skills', async () => {
    const fakeSandbox = makeStubPublicSandbox();
    const sandboxProvider = jest.fn().mockResolvedValue(fakeSandbox);
    const resolver = makeResolver(sandboxProvider);

    const sandbox = await resolver.resolveSandbox(resolveInput(makeSpec(true)));

    expect(sandbox).toBe(fakeSandbox);
    expect(sandboxProvider).toHaveBeenCalledTimes(1);
    await resolver.close();
  });
});
