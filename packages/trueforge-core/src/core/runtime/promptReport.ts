import { createLogger } from 'winston';
import type { AgentCapability } from '../capabilities/AgentCapability';
import type { ILLM, LLMCreateParamsStreaming } from '../llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../llm/LLMTypes';
import { getEmptyUsage } from '../llm/LLMTypes';
import { estimateTokensForString } from '../llm/usage';
import type { Sandbox } from '../sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../tracing/NoopAgentTracing';
import type { AgentDefinition } from './AgentDefinition';
import { AgentThread } from './AgentThread';

export interface PromptReportRow {
  /** A section path such as `agent-capabilities/plain-speech`, or a tool name. */
  name: string;
  tokens: number;
}

export interface PromptReport {
  /** System prompt sections in the order sent. Nested rows have a `/` in their name. */
  sections: PromptReportRow[];
  /** Tool definitions in the order sent. */
  tools: PromptReportRow[];
  /** Top-level sections plus tools. Nested rows are already counted inside their parent. */
  totalTokens: number;
}

export interface PromptReportInput {
  definition: Omit<AgentDefinition, 'modelClient'>;
  capabilities?: readonly AgentCapability[] | undefined;
  sandbox?: Sandbox | undefined;
  /** Whether the server has a sandbox at all. See ITurnResourceResolver.serverSandboxAvailable. */
  serverSandboxAvailable?: boolean | undefined;
  /** The person's message the turn answers; it decides which tool bundles the request carries. */
  message: string;
}

// The instruction builder puts each tag on its own line, and escaped content opens with `<tag><![CDATA[`
// and closes with `]]></tag>`. Tags inside the sentences of static prompt text are not structure.
const STRUCTURE_PATTERN =
  /^<(?<close>\/)?(?<tag>[a-z][a-z0-9-]*)>$|^<(?<cdataOpen>[a-z][a-z0-9-]*)><!\[CDATA\[$|^\]\]><\/(?<cdataClose>[a-z][a-z0-9-]*)>$/gm;

/** Splits the rendered system prompt at its nested sections. Escaped (CDATA) content is never read as structure. */
function sectionRows(system: string): PromptReportRow[] {
  const rows: (PromptReportRow & { start: number })[] = [];
  const open: { name: string; path: string; start: number }[] = [];
  let cdataSection: string | undefined;
  for (const match of system.matchAll(STRUCTURE_PATTERN)) {
    const { close, tag, cdataOpen, cdataClose } = match.groups ?? {};
    const end = match.index + match[0].length;
    if (cdataSection !== undefined) {
      if (cdataClose !== cdataSection) {
        continue;
      }
      cdataSection = undefined;
      closeSection(cdataClose, end);
      continue;
    }
    if (cdataOpen !== undefined) {
      cdataSection = cdataOpen;
      openSection(cdataOpen, match.index);
      continue;
    }
    if (tag === undefined) {
      continue;
    }
    if (close === undefined) {
      openSection(tag, match.index);
    } else {
      closeSection(tag, end);
    }
  }
  // Rows are pushed as sections close; sort them so each parent comes before its children.
  return rows.sort((a, b) => a.start - b.start).map(({ name, tokens }) => ({ name, tokens }));

  function openSection(name: string, start: number): void {
    const parent = open[open.length - 1];
    const path = parent === undefined ? '' : [parent.path, name].filter(part => part !== '').join('/');
    open.push({ name, path, start });
  }

  function closeSection(name: string | undefined, end: number): void {
    const current = open.pop();
    if (current === undefined || current.name !== name) {
      throw new Error(`System prompt tag ${name ?? ''} closes without an opening tag`);
    }
    // The root `system-prompt` element is the only one left at depth zero.
    if (open.length === 0) {
      return;
    }
    rows.push({
      name: current.path,
      tokens: Math.round(estimateTokensForString(system.slice(current.start, end))),
      start: current.start,
    });
  }
}

async function* answerStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  // Yield after a microtask so the stream is asynchronous, as a provider's is.
  await Promise.resolve();
  yield {
    id: 'prompt-report',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'prompt-report',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: 'ok' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

/**
 * Runs one user message through a real AgentThread built from the configuration and reads back the
 * system prompt and tool list of the request it sends. Sizes use the repo's chars / 4 estimator.
 */
export async function measurePromptRequest(input: PromptReportInput): Promise<PromptReport> {
  let request: LLMCreateParamsStreaming | undefined;
  const modelClient: ILLM = {
    create: params => {
      request = params;
      return answerStream();
    },
    createNonStream: () => Promise.reject(new Error('The prompt report never requests a completion.')),
  };
  const thread = new AgentThread({
    definition: { ...input.definition, modelClient },
    threadId: 'prompt-report',
    title: 'Prompt report',
    sandbox: input.sandbox,
    serverSandboxAvailable: input.serverSandboxAvailable,
    capabilities: input.capabilities ?? [],
    context: [{ role: 'user', content: input.message }],
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: createLogger({ silent: true }),
  });
  // Events are not needed; draining the turn is what makes the thread send its request.
  const events: unknown[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  if (request === undefined) {
    throw new Error('Prompt report: the thread sent no model request.');
  }

  const systemMessage = request.messages.find(message => message.role === 'system');
  const system = typeof systemMessage?.content === 'string' ? systemMessage.content : '';
  const sections = sectionRows(system);
  const tools = (request.tools ?? []).map(tool => ({
    name: tool.type === 'function' ? tool.function.name : tool.type,
    tokens: Math.round(estimateTokensForString(JSON.stringify(tool))),
  }));
  const topLevelTokens = sections.filter(row => !row.name.includes('/')).reduce((sum, row) => sum + row.tokens, 0);
  const toolTokens = tools.reduce((sum, row) => sum + row.tokens, 0);
  return { sections, tools, totalTokens: topLevelTokens + toolTokens };
}
