import type {
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
} from '../../../../src/core/capabilities/AgentContextProcessor';
import { chatProvenanceCapability } from '../../../../src/core/capabilities/builtins/ChatProvenance';
import { hasReadContent, steeredDestinations, type ChatProvenance } from '../../../../src/core/permissions/provenance';
import { createWebSearchTurnState } from '../../../../src/core/permissions/webSearch';
import type { ContextMessage } from '../../../../src/core/runtime/AgentThread.types';

// Invented people and hosts only.
const ADDRESS = 'bookings@harbour-prints.example';

async function drain(outputs: AsyncIterable<AgentContextProcessorOutput>): Promise<void> {
  for await (const _ of outputs) {
    // The recorder adds nothing.
  }
}

/** One turn as the host runs it: a fresh record, filled from the chat so far before the model step. */
async function recorded(context: ContextMessage[]): Promise<ChatProvenance> {
  const turn = createWebSearchTurnState();
  const execution: Readonly<AgentThreadExecutionContext> = {
    threadId: 'main',
    currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
    context,
  };
  for (const processor of chatProvenanceCapability({ turn }).preLLMProcessors ?? []) {
    await drain(processor.processPreLLM(execution));
  }
  return turn.provenance;
}

const steered = (provenance: ChatProvenance): string[] =>
  steeredDestinations({ provenance, addresses: [ADDRESS], values: [], reply_sender: null }).map(
    found => `${found.value} from ${found.origin.source}`,
  );

describe('an address in an earlier reply of the assistant', () => {
  it('counts as something the assistant read on the next turn, when the person never gave it', async () => {
    const provenance = await recorded([
      { role: 'user', content: 'who takes print orders' },
      { role: 'assistant', content: `Orders go to ${ADDRESS}.` },
      { role: 'user', content: 'ok, write to them' },
    ]);
    expect(steered(provenance)).toEqual([`${ADDRESS} from reply`]);
  });

  it('is read from a reply written in parts too', async () => {
    const provenance = await recorded([
      { role: 'user', content: 'who takes print orders' },
      { role: 'assistant', content: [{ type: 'text', text: `Orders go to ${ADDRESS}.` }] },
      { role: 'user', content: 'ok, write to them' },
    ]);
    expect(steered(provenance)).toEqual([`${ADDRESS} from reply`]);
  });

  it("stays the person's when they gave it, before or after the reply", async () => {
    const before = await recorded([
      { role: 'user', content: `write to ${ADDRESS} about the posters` },
      { role: 'assistant', content: `Here is a draft for ${ADDRESS}.` },
      { role: 'user', content: 'send it' },
    ]);
    expect(steered(before)).toEqual([]);
    const after = await recorded([
      { role: 'user', content: 'who takes print orders' },
      { role: 'assistant', content: `Orders go to ${ADDRESS}.` },
      { role: 'user', content: `yes, ${ADDRESS} is right, write to them` },
    ]);
    expect(steered(after)).toEqual([]);
  });

  it("does not make a chat of the person's words and replies one that has read other people's content", async () => {
    const provenance = await recorded([
      { role: 'user', content: 'who takes print orders' },
      { role: 'assistant', content: `Orders go to ${ADDRESS}. See https://harbour-prints.example/orders too.` },
      { role: 'assistant', content: null },
      { role: 'user', content: 'thanks' },
    ]);
    expect(hasReadContent(provenance)).toBe(false);
  });
});
