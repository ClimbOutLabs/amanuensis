import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

import { pendingApprovalFromRef, type PendingApproval } from './approvals.js';
import { outcomeOfDisposition, plainToolName, toolCallDetail, type ToolOutcome } from './words.js';

/** One event from a chat, from the live stream or from the saved event feed. Both carry the same shapes. */
export type ChatEvent = TrueForgeApi.TurnStreamingEvent | TrueForgeApi.SessionEvent;

/** One thing the chat view shows, in order. */
export type ViewBlock =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; toolCallId: string; name: string; detail: string | null; outcome: ToolOutcome | null }
  | { kind: 'note'; id: string; text: string };

interface ToolCallRecord {
  name: string;
  argumentsJson: string | undefined;
}

/**
 * Folds chat events into the blocks the terminal shows. The live stream and the
 * saved history fold through this same code, so a chat reads the same way
 * whether it is happening now or was reopened later. Events already seen are
 * ignored, so a stream that reconnects and replays a few events cannot double
 * a reply.
 */
export class ChatView {
  readonly blocks: ViewBlock[] = [];
  readonly #webAddress: string;
  readonly #seenEventIds = new Set<string>();
  readonly #toolCalls = new Map<string, ToolCallRecord>();
  readonly #toolBlocks = new Map<string, Extract<ViewBlock, { kind: 'tool' }>>();
  readonly #openAssistant = new Map<string, Extract<ViewBlock, { kind: 'assistant' }>>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  #counter = 0;

  constructor(webAddress: string) {
    this.#webAddress = webAddress;
  }

  #nextId(seed: string): string {
    this.#counter += 1;
    return `${seed}-${String(this.#counter)}`;
  }

  #note(options: { text: string; seed: string }): void {
    this.blocks.push({ kind: 'note', id: this.#nextId(options.seed), text: options.text });
  }

  #cannotShowNote(): void {
    this.#note({
      text: `Part of this chat is a picture or a file, which the terminal cannot show. Open this chat in the web app to see it: ${this.#webAddress}`,
      seed: 'cannot-show',
    });
  }

  #assistantBlock(threadId: string): Extract<ViewBlock, { kind: 'assistant' }> {
    const open = this.#openAssistant.get(threadId);
    if (open !== undefined) {
      return open;
    }
    const block: Extract<ViewBlock, { kind: 'assistant' }> = {
      kind: 'assistant',
      id: this.#nextId('assistant'),
      text: '',
      streaming: true,
    };
    this.blocks.push(block);
    this.#openAssistant.set(threadId, block);
    return block;
  }

  #closeAssistant(threadId: string): void {
    const open = this.#openAssistant.get(threadId);
    if (open !== undefined) {
      open.streaming = false;
      this.#openAssistant.delete(threadId);
    }
  }

  #toolBlock(toolCallId: string): Extract<ViewBlock, { kind: 'tool' }> {
    const existing = this.#toolBlocks.get(toolCallId);
    if (existing !== undefined) {
      return existing;
    }
    const record = this.#toolCalls.get(toolCallId);
    const block: Extract<ViewBlock, { kind: 'tool' }> = {
      kind: 'tool',
      id: this.#nextId('tool'),
      toolCallId,
      name: record === undefined ? 'An action' : plainToolName(record.name),
      detail: record === undefined ? null : toolCallDetail(record.argumentsJson),
      outcome: null,
    };
    this.blocks.push(block);
    this.#toolBlocks.set(toolCallId, block);
    return block;
  }

  #applyUserInput(input: readonly TrueForgeApi.TurnInputItem[] | undefined, eventId: string): void {
    if (input === undefined) {
      return;
    }
    let cannotShowShown = false;
    for (const [index, item] of input.entries()) {
      if (item.type !== 'user.message') {
        continue;
      }
      const content: TrueForgeApi.UserMessageContent = item.content;
      if (typeof content === 'string') {
        if (content.trim() !== '') {
          this.blocks.push({ kind: 'user', id: `${eventId}-user-${String(index)}`, text: content });
        }
        continue;
      }
      const texts: string[] = [];
      let hasFile = false;
      for (const part of content) {
        if (part.type === 'text') {
          texts.push(part.text);
        } else {
          hasFile = true;
        }
      }
      const joined = texts.join('\n').trim();
      if (joined !== '') {
        this.blocks.push({ kind: 'user', id: `${eventId}-user-${String(index)}`, text: joined });
      }
      if (hasFile && !cannotShowShown) {
        cannotShowShown = true;
        this.#cannotShowNote();
      }
    }
  }

  #applyModelMessage(event: TrueForgeApi.ModelMessageEvent): void {
    for (const toolCall of event.toolCalls ?? []) {
      this.#toolCalls.set(toolCall.id, { name: toolCall.function.name, argumentsJson: toolCall.function.arguments });
    }
    const content = event.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (part.type === 'text') {
          parts.push(part.text);
        } else if (part.type === 'refusal' && part.refusal !== undefined && part.refusal !== null) {
          parts.push(part.refusal);
        }
      }
      text = parts.join('');
    }
    if (text.trim() === '' && (event.toolCalls ?? []).length === 0) {
      return;
    }
    if (text.trim() !== '') {
      // The finished message replaces whatever the deltas streamed in.
      this.#assistantBlock(event.threadId).text = text;
    }
    this.#closeAssistant(event.threadId);
  }

  /** Adds one plain note line to the view, for an outcome the events themselves do not carry. */
  addNote(text: string): void {
    this.#note({ text, seed: 'note' });
  }

  /** The actions still waiting for the person's answer, in the order they were held. */
  pendingApprovals(): PendingApproval[] {
    return [...this.#pendingApprovals.values()];
  }

  /**
   * Records one waiting action, or fills in the card and tool name of one the
   * fold already holds. The tip read and the event fold both learn about
   * waiting actions, and neither may wipe what the other already knows.
   */
  registerPending(approval: PendingApproval): void {
    const existing = this.#pendingApprovals.get(approval.toolCallId);
    if (existing !== undefined) {
      if (existing.card === null && approval.card !== null) {
        existing.card = approval.card;
      }
      if (existing.toolName === null && approval.toolName !== null) {
        existing.toolName = approval.toolName;
      }
    } else {
      this.#pendingApprovals.set(approval.toolCallId, approval);
    }
    const block = this.#toolBlock(approval.toolCallId);
    if (block.outcome === null) {
      block.outcome = 'waiting_approval';
    }
  }

  /** Drops one waiting action, because it was answered or can no longer be answered. */
  resolvePending(toolCallId: string): void {
    this.#pendingApprovals.delete(toolCallId);
  }

  #registerApprovalRefs(threadId: string, refs: readonly TrueForgeApi.ApprovalToolCallRef[]): void {
    for (const ref of refs) {
      const record = this.#toolCalls.get(ref.id);
      this.registerPending(
        pendingApprovalFromRef({
          ref,
          threadId,
          toolName: record === undefined ? null : plainToolName(record.name),
        }),
      );
    }
  }

  /** Closes every open block, for when a stream ends without its finishing events. */
  settle(): void {
    for (const threadId of [...this.#openAssistant.keys()]) {
      this.#closeAssistant(threadId);
    }
  }

  /** Folds one event into the view. Events with an id already seen are skipped. */
  apply(event: ChatEvent): void {
    if (this.#seenEventIds.has(event.id)) {
      return;
    }
    this.#seenEventIds.add(event.id);
    switch (event.type) {
      case 'turn.created': {
        this.#applyUserInput(event.input, event.id);
        return;
      }
      case 'model.message.delta': {
        if (event.content !== undefined && event.content !== null && event.content !== '') {
          this.#assistantBlock(event.threadId).text += event.content;
        }
        return;
      }
      case 'model.message': {
        this.#applyModelMessage(event);
        return;
      }
      case 'tool.execution_started': {
        const record = this.#toolCalls.get(event.toolCallId);
        if (record === undefined) {
          this.#toolCalls.set(event.toolCallId, { name: event.toolName, argumentsJson: undefined });
        }
        this.#toolBlock(event.toolCallId);
        return;
      }
      case 'tool.approval_required': {
        this.#registerApprovalRefs(event.threadId, event.toolCalls);
        return;
      }
      case 'tool.response.v2': {
        this.#pendingApprovals.delete(event.toolCallId);
        this.#toolBlock(event.toolCallId).outcome = outcomeOfDisposition(event.disposition);
        return;
      }
      case 'tool.response': {
        const block = this.#toolBlock(event.toolCallId);
        if (block.outcome === null) {
          block.outcome = 'done';
        }
        return;
      }
      case 'turn.done': {
        for (const threadId of [...this.#openAssistant.keys()]) {
          this.#closeAssistant(threadId);
        }
        const state = event.state;
        if (state.status === 'error') {
          this.#note({ text: 'Something went wrong with that reply. Send your message again.', seed: 'turn-error' });
        }
        if (state.status === 'cancelled') {
          // Whatever part of the reply arrived stays on screen. This line says why it ends there.
          this.#note({ text: 'This reply was stopped.', seed: 'turn-stopped' });
        }
        if (state.status === 'done') {
          for (const action of state.requiredActions) {
            if (action.type === 'tool.approval_required') {
              this.#registerApprovalRefs(action.threadId, action.toolCalls);
            }
          }
        }
        return;
      }
      default: {
        return;
      }
    }
  }
}
