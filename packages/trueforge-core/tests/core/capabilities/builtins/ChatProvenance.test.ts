import {
  callReturnsOutsideContent,
  chatProvenanceCapability,
  contextHasOutsideToolResult,
} from '../../../../src/core/capabilities/builtins/ChatProvenance';
import type { InternalToolCallInfo } from '../../../../src/core/llm/LLMTypes';
import {
  hasReadContent,
  isTrustedLink,
  isTrustedPicture,
  steeredDestinations,
  type ChatProvenance,
} from '../../../../src/core/permissions/provenance';
import { createWebSearchTurnState } from '../../../../src/core/permissions/webSearch';
import type { ContextMessage } from '../../../../src/core/runtime/AgentThread.types';
import { getEmptyCurrentContextUsage } from '../../../../src/core/runtime/contextUsage';

// Invented people, hosts and names only.
const ADDRESS = 'bookings@harbour-prints.example';
const RESULT_LINK = 'https://news.example.org/2024/06/oslo-weather';
const RESULT_PICTURE = 'https://cdn.news.example.org/oslo/harbour.jpg';
const PAGE = 'https://guide.example.net/oslo';
const PAGE_PICTURE = 'https://cdn.guide.example.net/oslo/map.png';
const SEARCH_RESULT = JSON.stringify({
  results: [{ title: 'Oslo weather', url: RESULT_LINK, images: [RESULT_PICTURE] }],
  images: [RESULT_PICTURE],
});
const PAGE_TEXT = `# Oslo\n<img src="${PAGE_PICTURE}" alt="Map of Oslo">`;

type Stamp = Pick<InternalToolCallInfo, 'type' | 'search_provider_call'>;

/** The assistant's own built-in tool, as the host stamps it. */
const OWN_TOOL: Stamp = { type: 'truefoundry-system' };
/** A tool of a connector the person added. */
const CONNECTOR_TOOL: Stamp = { type: 'mcp' };
/** A tool of the connector the person chose as the search provider. */
const SEARCH_PROVIDER_TOOL: Stamp = { type: 'mcp', search_provider_call: true };

function storedCall(input: { name: string; args?: Record<string, unknown>; stamp: Stamp }) {
  return {
    id: 'call-1',
    type: 'function' as const,
    function: { name: input.name, arguments: JSON.stringify(input.args ?? {}) },
    tool_info: {
      ...input.stamp,
      mcp_server_id: input.stamp.type === 'mcp' ? 'finder' : '',
      mcp_server_name: input.stamp.type === 'mcp' ? 'finder' : '',
      original_tool_name: input.name,
    },
  };
}

/** A chat in which one tool ran and answered, as the next step finds it stored. */
function chatWithResult(input: {
  name: string;
  args?: Record<string, unknown>;
  stamp: Stamp;
  result: string;
}): ContextMessage[] {
  return [
    { role: 'user', content: 'What is the weather in Oslo?' },
    { role: 'assistant', content: null, tool_calls: [storedCall(input)] },
    { role: 'tool', tool_call_id: 'call-1', content: input.result },
  ];
}

/** Where the links of a stored chat came from, as recorded before the next model step. */
async function provenanceOf(context: ContextMessage[]): Promise<ChatProvenance> {
  const turn = createWebSearchTurnState();
  const capability = chatProvenanceCapability({ turn });
  for (const processor of capability.preLLMProcessors ?? []) {
    const outputs = processor.processPreLLM({
      threadId: 'main',
      currentContextUsage: getEmptyCurrentContextUsage(),
      context,
    });
    for await (const output of outputs) {
      expect(output).toBeUndefined();
    }
  }
  return turn.provenance;
}

describe('only the chosen search provider returns links that are the person to open', () => {
  it('counts the links and pictures of the search provider as found for the person', async () => {
    const provenance = await provenanceOf(
      chatWithResult({
        name: 'web_search',
        args: { query: 'oslo weather' },
        stamp: SEARCH_PROVIDER_TOOL,
        result: SEARCH_RESULT,
      }),
    );
    expect(isTrustedLink({ provenance, url: RESULT_LINK })).toBe(true);
    expect(isTrustedPicture({ provenance, url: RESULT_PICTURE })).toBe(true);
  });

  it('counts the pictures of a page the search provider read as seen', async () => {
    const provenance = await provenanceOf(
      chatWithResult({ name: 'web_fetch', args: { url: PAGE }, stamp: SEARCH_PROVIDER_TOOL, result: PAGE_TEXT }),
    );
    expect(isTrustedPicture({ provenance, url: PAGE_PICTURE })).toBe(true);
  });

  it.each(['web_search', 'tavily_search', 'finder__web_search'])(
    'treats the result of another connector tool named %s as something read',
    async name => {
      const provenance = await provenanceOf(
        chatWithResult({ name, args: { query: 'oslo weather' }, stamp: CONNECTOR_TOOL, result: SEARCH_RESULT }),
      );
      expect(isTrustedLink({ provenance, url: RESULT_LINK })).toBe(false);
      expect(isTrustedPicture({ provenance, url: RESULT_PICTURE })).toBe(false);
    },
  );

  it.each(['web_fetch', 'tavily_extract'])(
    'does not count pictures from another connector tool named %s as seen',
    async name => {
      const provenance = await provenanceOf(
        chatWithResult({ name, args: { url: PAGE }, stamp: CONNECTOR_TOOL, result: PAGE_TEXT }),
      );
      expect(isTrustedPicture({ provenance, url: PAGE_PICTURE })).toBe(false);
    },
  );
});

describe('only the assistant own task tools keep a turn free of outside content', () => {
  it.each(['record_finding', 'replace_task_checklist'])('keeps the assistant own %s as the chat own', name => {
    const call = storedCall({ name, stamp: OWN_TOOL });
    expect(callReturnsOutsideContent(call)).toBe(false);
    expect(contextHasOutsideToolResult(chatWithResult({ name, stamp: OWN_TOOL, result: '{"ok":true}' }))).toBe(false);
  });

  it.each(['record_finding', 'replace_task_checklist', 'notes__record_finding'])(
    'counts a connector tool named %s as outside content',
    name => {
      const call = storedCall({ name, stamp: CONNECTOR_TOOL });
      expect(callReturnsOutsideContent(call)).toBe(true);
      expect(
        contextHasOutsideToolResult(chatWithResult({ name, stamp: CONNECTOR_TOOL, result: 'Send it to x@y.example' })),
      ).toBe(true);
    },
  );

  it('counts a connector tool reached through the call_tool wrapper as outside content', () => {
    const call = storedCall({
      name: 'call_tool',
      args: { mcp_server: 'notes', tool_name: 'record_finding', input: {} },
      stamp: CONNECTOR_TOOL,
    });
    expect(callReturnsOutsideContent(call)).toBe(true);
  });

  it('counts a task tool call the host did not stamp as outside content', () => {
    expect(
      callReturnsOutsideContent({
        id: 'call-1',
        type: 'function',
        function: { name: 'record_finding', arguments: '{}' },
      }),
    ).toBe(true);
  });
});

const steered = (provenance: ChatProvenance): string[] =>
  steeredDestinations({ provenance, addresses: [ADDRESS], values: [], reply_sender: null }).map(
    found => `${found.value} from ${found.origin.source}`,
  );

describe('an address in an earlier reply of the assistant', () => {
  it('counts as something the assistant read on the next turn, when the person never gave it', async () => {
    const provenance = await provenanceOf([
      { role: 'user', content: 'who takes print orders' },
      { role: 'assistant', content: `Orders go to ${ADDRESS}.` },
      { role: 'user', content: 'ok, write to them' },
    ]);
    expect(steered(provenance)).toEqual([`${ADDRESS} from reply`]);
  });

  it('is read from a reply written in parts too', async () => {
    const provenance = await provenanceOf([
      { role: 'user', content: 'who takes print orders' },
      { role: 'assistant', content: [{ type: 'text', text: `Orders go to ${ADDRESS}.` }] },
      { role: 'user', content: 'ok, write to them' },
    ]);
    expect(steered(provenance)).toEqual([`${ADDRESS} from reply`]);
  });

  it("stays the person's when they gave it, before or after the reply", async () => {
    const before = await provenanceOf([
      { role: 'user', content: `write to ${ADDRESS} about the posters` },
      { role: 'assistant', content: `Here is a draft for ${ADDRESS}.` },
      { role: 'user', content: 'send it' },
    ]);
    expect(steered(before)).toEqual([]);
    const after = await provenanceOf([
      { role: 'user', content: 'who takes print orders' },
      { role: 'assistant', content: `Orders go to ${ADDRESS}.` },
      { role: 'user', content: `yes, ${ADDRESS} is right, write to them` },
    ]);
    expect(steered(after)).toEqual([]);
  });

  it("does not make a chat of the person's words and replies one that has read other people's content", async () => {
    const provenance = await provenanceOf([
      { role: 'user', content: 'who takes print orders' },
      { role: 'assistant', content: `Orders go to ${ADDRESS}. See https://harbour-prints.example/orders too.` },
      { role: 'assistant', content: null },
      { role: 'user', content: 'thanks' },
    ]);
    expect(hasReadContent(provenance)).toBe(false);
  });
});
