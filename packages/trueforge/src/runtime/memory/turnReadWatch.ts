import {
  EventType,
  personTypedText,
  turnReadOutsideText,
  type ContextMessage,
  type ToolCallResult,
} from '@truefoundry/trueforge-core/core';
import { MEMORY_PAGES_SERVER_ID } from '@truefoundry/trueforge-core/core/memory/pagesToolContract';
import { z } from 'zod';

import { FactMarkerSchema } from './memoryNotes';

const ReadReceiptSchema = z.object({
  schema_version: z.literal(EventType.TOOL_RESPONSE_V2),
  outcome: z.object({
    disposition: z.literal('executed_ok'),
    screen: z.object({ action: z.literal('admitted') }).optional(),
  }),
  result: z.string(),
});

/** Why the page tools must not write this turn. */
export type TurnReadReason = 'read_outside_text' | 'memory_holds_outside_text';

/**
 * Remembers, for one turn, whether outside text has reached the model, so the page tools can refuse. Two things
 * count: text read before the call being made now (told the context before every model step, so a call is
 * judged on what the model had seen when it wrote it), and a memory block that holds recalled text which is not
 * the person's own words. Once either is true it stays true, even if a later summary drops the evidence. Until
 * the first look at the context, the turn counts as read.
 */
export class TurnReadWatch {
  #seen = false;
  #read = true;
  #blockHoldsOutside = false;
  #personText = '';

  readonly #results = new Map<string, string>();
  readonly #visible = new Map<string, string>();

  observeResults(results: ToolCallResult[]): void {
    for (const result of results) {
      const id = result.message.tool_call_id;
      const info = result.toolCallInfo;
      if (
        this.#results.size >= 40 ||
        result.rawContent.length > 32_000 ||
        result.failure ||
        result.disposition !== 'executed_ok' ||
        info?.type !== 'mcp' ||
        info.effect !== 'inspect' ||
        info.mcp_server_id === MEMORY_PAGES_SERVER_ID ||
        info.mcp_server_name === MEMORY_PAGES_SERVER_ID ||
        !FactMarkerSchema.shape.receipt.safeParse(id).success
      ) {
        continue;
      }
      this.#results.set(id, result.rawContent);
    }
  }

  /** The same whole line must have reached the model and have come from the successful provider read. */
  sourceForUpdate(input: { text: string; subject: string }): string | undefined {
    const words = input.text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    const subject = input.subject
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    if (
      subject.length === 0 ||
      !words.some((_, start) => subject.every((word, offset) => words[start + offset] === word))
    ) {
      return undefined;
    }
    for (const [id, text] of this.#visible) {
      if (text.split(/\r?\n/).some(line => line.trim() === input.text)) {
        return id;
      }
    }
    return undefined;
  }

  observe(context: readonly ContextMessage[]): void {
    this.#visible.clear();
    for (const message of context) {
      if (!('role' in message) || message.role !== 'tool') {
        continue;
      }
      const raw = this.#results.get(message.tool_call_id);
      if (raw === undefined || message.content.length > 200_000) {
        continue;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(message.content);
      } catch {
        continue;
      }
      const receipt = ReadReceiptSchema.safeParse(decoded);
      if (receipt.success && receipt.data.result === raw) {
        this.#visible.set(message.tool_call_id, raw);
      }
    }
    const read = turnReadOutsideText(context);
    this.#read = this.#seen ? this.#read || read : read;
    this.#seen = true;
    this.#personText = personTypedText(context);
  }

  /** What the person typed in the message this turn answers; empty until the first look at the context. */
  get personText(): string {
    return this.#personText;
  }

  noteBlock({ holdsOutsideText }: { holdsOutsideText: boolean }): void {
    this.#blockHoldsOutside ||= holdsOutsideText;
  }

  /** Why writing is off, or undefined when the turn holds only the person's own words. */
  get reason(): TurnReadReason | undefined {
    if (this.#read) {
      return 'read_outside_text';
    }
    return this.#blockHoldsOutside ? 'memory_holds_outside_text' : undefined;
  }
}
