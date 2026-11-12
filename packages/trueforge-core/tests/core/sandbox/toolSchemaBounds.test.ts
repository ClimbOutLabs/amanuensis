/**
 * Guard: no built-in tool may emit a JSON Schema length bound above 128.
 *
 * vLLM's xgrammar crashes when compiling bounded repetitions above 128, so
 * every length limit stays in Zod .refine() (omitted from the emitted JSON
 * Schema) instead of .min()/.max(). This test collects the emitted schemas
 * from the real tool registries (LocalToolMCP subclasses via listTools()),
 * so a tool added to any registry is covered without editing this file.
 */
import { AskUserQuestion } from '../../../src/core/capabilities/builtins/AskUserQuestion';
import { CurrentDateTime } from '../../../src/core/capabilities/builtins/CurrentDateTime';
import { DocumentTools } from '../../../src/core/capabilities/builtins/DocumentTools';
import { DynamicSubAgents } from '../../../src/core/capabilities/builtins/DynamicSubAgents';
import { OpenUIInstructions } from '../../../src/core/capabilities/builtins/OpenUI';
import { taskChecklist, type TaskChecklistAccess } from '../../../src/core/capabilities/builtins/TaskChecklist';
import { isAuthRequired, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { DeferredTool } from '../../../src/core/runtime/DeferredTool';
import { TaskStateToolSet } from '../../../src/core/runtime/TaskStateToolSet';
import type { SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

const LENGTH_KEYWORDS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']);

/** Minimum tools expected across all registries; fails loudly if a registry import breaks. */
const MINIMUM_TOOL_COUNT = 15;

/** Tools that must be present; a missing one means discovery is broken, not that the tool was removed. */
const REQUIRED_TOOLS = ['exec', 'run_code', 'submit_implementation_plan', 'get_current_datetime', 'ask_user_question'];

function stubProvider(): SandboxProvider {
  return {
    type: 'local',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: sandboxId => `${sandboxId}/tool-results`,
    getGitCredentialsPath: sandboxId => `${sandboxId}/.git-credentials`,
    getFileUploadsDir: sandboxId => `${sandboxId}/uploads`,
    getSkillsDir: sandboxId => `${sandboxId}/skills`,
    getSkillDownloaderPath: sandboxId => `${sandboxId}/skill_downloader.py`,
    downloadFile: () => Promise.reject(new Error('not used')),
    uploadFile: () => Promise.resolve(),
    createCodeModeTransport: () => {
      throw new Error('not used');
    },
    createSandbox: () => Promise.resolve({ sandboxId: 'test' }),
    exec: () => Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } }),
  };
}

function stubChecklistAccess(): TaskChecklistAccess {
  return {
    getTaskChecklist: () => Promise.resolve({ revision: 0, items: [] }),
    replaceTaskChecklist: () => Promise.resolve({ revision: 1, items: [] }),
  };
}

/**
 * Instantiate every built-in tool registry and collect its tools through the
 * real listTools() interface. A tool added to any of these registries is
 * covered automatically.
 */
async function discoverBuiltInTools(): Promise<Array<{ name: string; inputSchema: unknown }>> {
  const sandbox = new Sandbox({
    provider: stubProvider(),
    // Bound repository so getTools() lists every sandbox tool, including the
    // repository-scoped ones (run_registered_command, submit_implementation_plan).
    boundRepository: { repository_id: 'test', revision: 1, workspace_cwd: '/test', commands: [] },
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });

  const registries: IToolSet[] = [
    sandbox,
    new TaskStateToolSet({ tracing: NOOP_AGENT_TRACING, bankedCount: () => 0 }),
    new DeferredTool([], { tracing: NOOP_AGENT_TRACING, logger: makeSilentLogger() }),
    new CurrentDateTime(NOOP_AGENT_TRACING),
    new AskUserQuestion(),
    new OpenUIInstructions(NOOP_AGENT_TRACING),
    new DynamicSubAgents({ tracing: NOOP_AGENT_TRACING }),
    new DocumentTools({ sandbox, tracing: NOOP_AGENT_TRACING, logger: makeSilentLogger() }),
  ];

  // TaskChecklist exposes its tool set through the capability factory.
  const checklist = taskChecklist({ access: stubChecklistAccess(), tracing: NOOP_AGENT_TRACING });
  for (const toolSet of checklist.systemToolSets ?? []) {
    registries.push(toolSet);
  }

  const tools: Array<{ name: string; inputSchema: unknown }> = [];
  for (const registry of registries) {
    const listed = await registry.listTools();
    if (isAuthRequired(listed)) {
      throw new Error(`registry ${registry.name} requires auth in test`);
    }
    for (const tool of listed.result.tools) {
      tools.push({ name: tool.name, inputSchema: tool.inputSchema });
    }
  }
  return tools;
}

function collectBoundOffenders(root: unknown): string[] {
  const limit = 128;
  const offenders: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${String(i)}]`));
      return;
    }
    if (typeof node !== 'object' || node === null) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const here = `${path}.${key}`;
      if (LENGTH_KEYWORDS.has(key) && typeof value === 'number' && value > limit) {
        offenders.push(`${here}=${String(value)}`);
      }
      if (key === 'pattern' && typeof value === 'string') {
        for (const [, min, max] of value.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
          if (Number(max || min) > limit) {
            offenders.push(`${here} repeats ${max || min}`);
          }
        }
      }
      walk(value, here);
    }
  };
  walk(root, '$');
  return offenders;
}

describe('built-in tool JSON schemas', () => {
  it('discovers tools from the real registries', async () => {
    const tools = await discoverBuiltInTools();
    const names = tools.map(t => t.name);
    expect(tools.length).toBeGreaterThanOrEqual(MINIMUM_TOOL_COUNT);
    for (const required of REQUIRED_TOOLS) {
      expect(names).toContain(required);
    }
  });

  it('emits no length bound above 128 to the model-facing JSON Schema', async () => {
    // vLLM's cached xgrammar compile asserts on bounded repetitions above 128 and takes EngineCore down.
    // Keep limits in Zod .refine() (omitted from the JSON Schema) so parse-time validation still applies.
    const tools = await discoverBuiltInTools();
    const failures: string[] = [];
    for (const { name, inputSchema } of tools) {
      const offenders = collectBoundOffenders(inputSchema);
      for (const offender of offenders) {
        failures.push(`${name}: ${offender}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

/** Required fields of an emitted JSON Schema, sorted so the comparison ignores property order. */
function requiredFieldsOf(inputSchema: unknown): string[] {
  if (typeof inputSchema !== 'object' || inputSchema === null || !('required' in inputSchema)) {
    return [];
  }
  const { required } = inputSchema;
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === 'string').sort() : [];
}

describe('tools with rewritten descriptions keep the fields the model must send', () => {
  it.each([
    ['exec', ['command', 'intent', 'purpose']],
    ['run_code', ['language']],
    ['ask_user_question', ['options', 'question']],
    ['create_sub_agent', ['input', 'name']],
  ])('%s', async (name, required) => {
    const tools = await discoverBuiltInTools();
    const tool = tools.find(candidate => candidate.name === name);
    expect(tool).toBeDefined();
    expect(requiredFieldsOf(tool?.inputSchema)).toEqual(required);
  });
});
