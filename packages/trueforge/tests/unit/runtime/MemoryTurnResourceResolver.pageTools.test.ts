import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { InstructionBuilder, type AgentCapability } from '@truefoundry/trueforge-core/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from 'winston';

import { MarkdownMemoryClient } from '../../../src/runtime/memory/markdownMemoryClient';
import type { MemoryConfig } from '../../../src/runtime/memory/memoryCapability';
import type { MemoryClient } from '../../../src/runtime/memory/memoryClient';
import { MemoryTurnResourceResolver } from '../../../src/runtime/MemoryTurnResourceResolver';
import { QuietMemoryClient } from '../../fixtures/memory/quietMemoryClient';

const MEMORY_CONFIG: MemoryConfig = {
  recallMaxTokens: 2048,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  pages: { maxCount: 6, maxTokens: 1500 },
};

let baseDir = '';

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'page-tools-resolver-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function markdownClient(): MarkdownMemoryClient {
  return new MarkdownMemoryClient({ baseDir, namespace: 'tenant-1', vaultScope: undefined });
}

/** A client of another backend: it has no folder of pages, so it cannot take page writes. */
function otherBackend(): MemoryClient {
  return new QuietMemoryClient();
}

async function resolveWith(input: {
  client: MemoryClient | undefined;
  recallEnabled?: boolean;
  subAgent?: boolean;
  keepsNothing?: boolean;
}) {
  const resolver = new MemoryTurnResourceResolver(
    {
      llm: () =>
        Promise.resolve({
          modelClient: {
            create: () => {
              throw new Error('unused');
            },
            createNonStream: () => Promise.reject(new Error('unused')),
          },
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      mcp: () => Promise.resolve({ url: 'http://127.0.0.1:1/unused', headers: {} }),
      mcpRequestTimeoutMs: 1000,
      mcpConnectTimeoutMs: 1000,
      logger: createLogger({ silent: true }),
    },
    undefined,
    undefined,
    {
      client: input.client,
      config: MEMORY_CONFIG,
      sessionId: 'session-1',
      previousTurnId: null,
      summarize: undefined,
      recallEnabled: input.recallEnabled,
      keepsNothing: input.keepsNothing ?? false,
    },
    { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500 },
  );
  const resolved = await resolver.resolveAgentDefinition({
    spec: AgentSpecSchema.parse({ model: { name: 'scripted/chat-model' }, instructions: 'Answer.' }),
    tenant_id: 't1',
    created_by: 'u1',
    session_id: 's1',
    ...(input.subAgent === true
      ? { agent_info: { type: 'dynamic' as const, name: 'reviewer', input: 'do the thing' } }
      : {}),
    signal: new AbortController().signal,
    tracing: resolver.createTracing(),
  });
  return resolved.extraCapabilities ?? [];
}

function pageToolNames(capabilities: readonly AgentCapability[]): string[] {
  return capabilities.flatMap(capability => capability.systemToolSets ?? []).map(toolSet => toolSet.name);
}

function instructionText(capabilities: readonly AgentCapability[]): string {
  const builder = new InstructionBuilder('root');
  for (const capability of capabilities) {
    for (const build of capability.instructionBuilders ?? []) {
      build(builder);
    }
  }
  return builder.build();
}

describe('memory page tools are offered only where they can be used', () => {
  it('offers them on a root thread with memory on and a Markdown backend, and says so in the memory text', async () => {
    const capabilities = await resolveWith({ client: markdownClient() });
    expect(pageToolNames(capabilities)).toEqual(['memory_pages']);
    const text = instructionText(capabilities);
    expect(text).toContain('remember_fact');
    expect(text).not.toContain('no memory-write tool is available to you');
  });

  it('offers none when the person turned memory off, or the run is unattended', async () => {
    const capabilities = await resolveWith({ client: markdownClient(), recallEnabled: false });
    expect(pageToolNames(capabilities)).toEqual([]);
  });

  it('offers none in a private chat, and keeps the private chat memory text', async () => {
    const capabilities = await resolveWith({ client: markdownClient(), keepsNothing: true });
    expect(pageToolNames(capabilities)).toEqual([]);
    const text = instructionText(capabilities);
    expect(text).toContain('This is an incognito chat');
    expect(text).not.toContain('remember_fact');
  });

  it('offers none to a sub-agent', async () => {
    expect(pageToolNames(await resolveWith({ client: markdownClient(), subAgent: true }))).toEqual([]);
  });

  it('offers none when the backend is not Markdown, and keeps the old memory text', async () => {
    const capabilities = await resolveWith({ client: otherBackend() });
    expect(pageToolNames(capabilities)).toEqual([]);
    const text = instructionText(capabilities);
    expect(text).toContain('no memory-write tool is available to you');
    expect(text).not.toContain('remember_fact');
  });

  it('offers none when there is no memory client', async () => {
    expect(pageToolNames(await resolveWith({ client: undefined }))).toEqual([]);
  });
});
