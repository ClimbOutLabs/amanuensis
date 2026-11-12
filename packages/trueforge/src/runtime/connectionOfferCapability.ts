/**
 * Offering to connect a connector from a chat, at the moment of need. When a task arrives that
 * needs a connector that is not connected, the chat offers the connection on a question card
 * instead of ending at a pointer to Settings. The chat holds no secret and connects nothing itself:
 * a yes points the person to that connector's card in Settings, Connectors, the one place a
 * password is ever typed, and when they come back the original task runs without being asked
 * twice. Only a no given as the answer to that connector's own card is recorded, and a recorded no
 * holds in every chat. A no in the person's own words is honoured for the moment and leaves no
 * record, so the offer can come again at a later need. Either way, the only words after a no are
 * the one line that leaves Settings as the way back. Which connectors can be offered is the
 * registry's call.
 */
import type {
  AgentCapability,
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
  AgentTracing,
  ContextMessage,
  InstructionBuilder,
} from '@truefoundry/trueforge-core/core';
import {
  defineTool,
  isInternalSystemMessage,
  LocalToolMCP,
  toolResultResponse,
  type ToolDefinition,
} from '@truefoundry/trueforge-core/core';
import { ASK_USER_QUESTION_TOOL_NAME } from '@truefoundry/trueforge-core/core/capabilities/builtins/AskUserQuestion';
import {
  CONNECTION_OFFER_DECLINE_ANNOTATIONS,
  CONNECTION_OFFER_READ_ANNOTATIONS,
  CONNECTION_OFFER_SERVER_ID,
  CONNECTION_OFFER_STATUS_TOOL_NAME,
  connectionOfferInputSchema,
  RECORD_CONNECTION_OFFER_DECLINE_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/connectors/connectionOfferContract';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import {
  connectionOfferDeclinedSettingKey,
  type ConnectionOfferHost,
  type OfferableConnector,
} from './connectionOfferRegistry';

export interface ConnectionOfferDeps {
  /** The connectors that may be offered: the registry in a real turn. */
  connectors: readonly [OfferableConnector, ...OfferableConnector[]];
  host: ConnectionOfferHost;
  settings: Pick<IGlobalSettingsStore, 'getSetting' | 'setSetting'>;
  tracing: AgentTracing;
}

export interface ConnectionOfferState {
  connected: boolean;
  /** Which route connects it; null when none does. */
  via: string | null;
  /** Whether the person has already turned the offer down, in any chat. */
  declined: boolean;
}

/** The one read behind both the mount decision and the status tool. */
export async function readConnectionOfferState(input: {
  connector: OfferableConnector;
  deps: Pick<ConnectionOfferDeps, 'host' | 'settings'>;
}): Promise<ConnectionOfferState> {
  const key = connectionOfferDeclinedSettingKey(input.connector.id);
  const declined = (await input.deps.settings.getSetting({ key }))?.value === 'true';
  const via = await input.connector.connectedVia(input.deps.host);
  return { connected: via !== null, via, declined };
}

function jsonResult(value: unknown) {
  return toolResultResponse({ text: JSON.stringify(value) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The answer a tool result carries, unwrapped from the host's tool-response envelope when it
 * wears one. Anything else the result holds is not an answer.
 */
function toolAnswerText(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (typeof parsed === 'string') {
    return parsed;
  }
  if (isRecord(parsed)) {
    const result = parsed['result'];
    return typeof result === 'string' ? result : undefined;
  }
  return undefined;
}

interface QuestionCall {
  id: string;
  question: string;
  options: readonly unknown[];
}

/** A question card the host recorded: a client-side ask_user_question call and the words it asked. */
function questionCallsOf(message: ContextMessage): QuestionCall[] {
  if (!('role' in message) || message.role !== 'assistant') {
    return [];
  }
  const calls: QuestionCall[] = [];
  for (const call of message.tool_calls ?? []) {
    if (call.tool_info.is_client_side !== true || !call.function.name.endsWith(ASK_USER_QUESTION_TOOL_NAME)) {
      continue;
    }
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      continue;
    }
    if (isRecord(args) && typeof args['question'] === 'string') {
      const options = args['options'];
      calls.push({ id: call.id, question: args['question'], options: Array.isArray(options) ? options : [] });
    }
  }
  return calls;
}

function isOfferCard(input: { call: QuestionCall; connector: OfferableConnector }): boolean {
  return input.call.question === input.connector.question && input.call.options.includes(input.connector.declineOption);
}

/**
 * The connector whose own offer card the exchange this turn continues from answered with its
 * decline choice, if any. The proof is read from the recorded thread context, which only the host
 * writes: the last tool result in it must answer a client-side question call whose question and
 * choices are that connector's card, its answer must be that card's decline choice itself, and
 * nothing the person or the model said may follow that result, so an answer left over from an
 * older exchange can never stand in for this turn's.
 */
function connectorDeclinedOnCard(input: {
  context: readonly ContextMessage[];
  connectors: readonly OfferableConnector[];
}): OfferableConnector | undefined {
  const { context } = input;
  let resultIndex = -1;
  for (let i = context.length - 1; i >= 0; i -= 1) {
    const message = context[i];
    if (message !== undefined && 'role' in message && message.role === 'tool') {
      resultIndex = i;
      break;
    }
  }
  const result = context[resultIndex];
  if (result === undefined || !('role' in result) || result.role !== 'tool') {
    return undefined;
  }
  for (let i = resultIndex + 1; i < context.length; i += 1) {
    const message = context[i];
    if (message !== undefined && 'role' in message && !isInternalSystemMessage(message)) {
      return undefined;
    }
  }
  let call: QuestionCall | undefined;
  for (let i = resultIndex - 1; i >= 0 && call === undefined; i -= 1) {
    const message = context[i];
    if (message !== undefined) {
      call = questionCallsOf(message).find(candidate => candidate.id === result.tool_call_id);
    }
  }
  if (call === undefined) {
    return undefined;
  }
  const answer = toolAnswerText(result.content)?.trim();
  const asked = call;
  return input.connectors.find(
    connector => isOfferCard({ call: asked, connector }) && answer === connector.declineOption,
  );
}

// Derived from the exported capability type rather than naming the processor interface directly:
// it is not part of trueforge-core's public entry point.
type PreLLMProcessor = NonNullable<AgentCapability['preLLMProcessors']>[number];

/** A processor pass that adds nothing to the context. */
const NOTHING_TO_ADD: AsyncIterable<AgentContextProcessorOutput> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
};

/**
 * What this thread has seen of the offer cards, latched per connector from the recorded context
 * before the model can act on it: these processors run ahead of every model call in the turn, and
 * the tools run only after one. The decline tool records only when that connector's latch is set,
 * so words in a chat, the person's or anyone else's, can never plant a remembered no: only the
 * person's own pick on that connector's card can. The status read also says when this chat has
 * already shown a connector's card, so a second card is never the model's guess.
 */
class OfferCardAnswers implements PreLLMProcessor {
  readonly #connectors: readonly OfferableConnector[];
  readonly #declinedOnCard = new Set<string>();
  readonly #offeredInChat = new Set<string>();

  constructor(connectors: readonly OfferableConnector[]) {
    this.#connectors = connectors;
  }

  declinedOnCard(connectorId: string): boolean {
    return this.#declinedOnCard.has(connectorId);
  }

  offeredInChat(connectorId: string): boolean {
    return this.#offeredInChat.has(connectorId);
  }

  processPreLLM(execution: Readonly<AgentThreadExecutionContext>): AsyncIterable<AgentContextProcessorOutput> {
    const declined = connectorDeclinedOnCard({ context: execution.context, connectors: this.#connectors });
    if (declined !== undefined) {
      this.#declinedOnCard.add(declined.id);
    }
    for (const message of execution.context) {
      for (const call of questionCallsOf(message)) {
        for (const connector of this.#connectors) {
          if (isOfferCard({ call, connector })) {
            this.#offeredInChat.add(connector.id);
          }
        }
      }
    }
    return NOTHING_TO_ADD;
  }
}

const CONNECTED_NEXT = 'It is connected. Do the task the person asked for.';

const DECLINED_NEXT =
  'The person already turned down this offer. Do not offer again, in this chat or any other. Do what you can without it, and leave Settings as their way back.';

const ALREADY_OFFERED_NEXT =
  'This chat already showed its offer card. Do not show it again. If they said yes, they still need to finish in Settings; otherwise do what you can without it.';

const NOT_CONNECTED_NEXT =
  'It is not connected. Offer the connection on its question card before saying the task cannot be done.';

const DECLINE_REMEMBERED_NEXT =
  'The no was remembered. Reply with the reply_line and nothing more on the subject, then carry on without it. Never offer it again, in this chat or any other.';

const DECLINE_NOT_REMEMBERED_NEXT =
  'The no was not remembered, because it did not come from its offer card. Do not say it was remembered, and do not offer again in this chat. Reply with the reply_line and nothing more on the subject, then carry on without it.';

/** The offer's two tools: one read of a connector's state, and the one write that remembers a no. */
class ConnectionOfferToolSet extends LocalToolMCP {
  readonly name = CONNECTION_OFFER_SERVER_ID;
  readonly displayName = 'Connection offer';
  readonly #deps: ConnectionOfferDeps;
  readonly #cardAnswers: OfferCardAnswers;
  readonly #tools: ToolDefinition[];

  constructor(input: { deps: ConnectionOfferDeps; cardAnswers: OfferCardAnswers }) {
    super({ tracing: input.deps.tracing });
    this.#deps = input.deps;
    this.#cardAnswers = input.cardAnswers;
    const [first, ...others] = input.deps.connectors;
    const ids: [string, ...string[]] = [first.id, ...others.map(connector => connector.id)];
    const schema = connectionOfferInputSchema(ids);
    const invalidInput = () => `That connector cannot be offered here. Call again with one of: ${ids.join(', ')}.`;
    this.#tools = [
      defineTool({
        name: CONNECTION_OFFER_STATUS_TOOL_NAME,
        description:
          'Read whether a connector is connected, and whether the person already turned down its offer. Call it before offering, and again after they finish connecting in Settings, before doing the task they asked for.',
        schema,
        invalidInput,
        annotations: CONNECTION_OFFER_READ_ANNOTATIONS,
        handler: input => this.#status(input.connector),
      }),
      defineTool({
        name: RECORD_CONNECTION_OFFER_DECLINE_TOOL_NAME,
        description:
          'Use it when the person says no to connecting a connector, on its offer card or in their own words. Only a no picked on the card is remembered. Send the line it returns and nothing more on the subject.',
        schema,
        invalidInput,
        annotations: CONNECTION_OFFER_DECLINE_ANNOTATIONS,
        handler: input => this.#decline(input.connector),
      }),
    ];
  }

  protected getTools(): ToolDefinition[] {
    return this.#tools;
  }

  #connector(connectorId: string): OfferableConnector {
    const connector = this.#deps.connectors.find(candidate => candidate.id === connectorId);
    if (connector === undefined) {
      throw new Error(`No connector named ${connectorId} can be offered. Call again with a connector this chat lists.`);
    }
    return connector;
  }

  async #status(connectorId: string) {
    const connector = this.#connector(connectorId);
    const state = await readConnectionOfferState({ connector, deps: this.#deps });
    const offeredInChat = this.#cardAnswers.offeredInChat(connector.id);
    return jsonResult({
      connector: connector.id,
      ...state,
      offered_in_this_chat: offeredInChat,
      next_step: state.connected
        ? CONNECTED_NEXT
        : state.declined
          ? DECLINED_NEXT
          : offeredInChat
            ? ALREADY_OFFERED_NEXT
            : NOT_CONNECTED_NEXT,
    });
  }

  async #decline(connectorId: string) {
    const connector = this.#connector(connectorId);
    if (!this.#cardAnswers.declinedOnCard(connector.id)) {
      return jsonResult({
        connector: connector.id,
        recorded: false,
        reply_line: connector.replyLine,
        next_step: DECLINE_NOT_REMEMBERED_NEXT,
      });
    }
    await this.#deps.settings.setSetting({ key: connectionOfferDeclinedSettingKey(connector.id), value: 'true' });
    return jsonResult({
      connector: connector.id,
      recorded: true,
      reply_line: connector.replyLine,
      next_step: DECLINE_REMEMBERED_NEXT,
    });
  }
}

const CONNECTION_OFFER_INSTRUCTION_SECTION = 'connection_offer';

/** One short instruction naming only the connectors this turn can offer, each with its own card. */
export function connectionOfferInstruction(offered: readonly OfferableConnector[]): string {
  const entries = offered.map(
    connector =>
      `- ${connector.id}: needed for ${connector.neededFor}. Card: question "${connector.question}", options "${connector.connectOption}" and "${connector.declineOption}". Connected in Settings, then Connectors, from ${connector.settingsCard}.`,
  );
  return `Connecting at the moment of need. Not connected, and the offer not turned down:
${entries.join('\n')}
When the person asks for something that really needs one, do not say it cannot be done and stop. Offer first, once, through ask_user_question with exactly that card.

On a yes (its first option or their own words): tell them in plain words to open Settings, then Connectors, and connect from the card named above. The Settings forms are the only place a password ever goes: never ask for one in this chat, and never use one pasted here. Then wait. When they say it is done, call ${CONNECTION_OFFER_STATUS_TOOL_NAME}; once it says connected, do what they first asked, without making them ask again.

On a no (its second option or their own words): call ${RECORD_CONNECTION_OFFER_DECLINE_TOOL_NAME}, then reply with exactly the line it returns and nothing more on the subject. Only a no picked on the card is remembered: after it, never offer that connector again. A no in their own words is not remembered: do not offer again in this chat, and never say it was remembered. Carry on with what can be done without it, such as text they paste.`;
}

/**
 * The offer for one turn. It mounts only while it can still be acted on: some registry connector
 * not connected and not turned down. When every one is connected or declined, there is nothing to
 * offer, so nothing mounts and no other chat can be chased with it.
 */
export async function connectionOfferCapability(deps: ConnectionOfferDeps): Promise<AgentCapability | undefined> {
  const offered: OfferableConnector[] = [];
  for (const connector of deps.connectors) {
    const state = await readConnectionOfferState({ connector, deps });
    if (!state.connected && !state.declined) {
      offered.push(connector);
    }
  }
  if (offered.length === 0) {
    return undefined;
  }
  const cardAnswers = new OfferCardAnswers(deps.connectors);
  const instruction = connectionOfferInstruction(offered);
  return {
    systemToolSets: [new ConnectionOfferToolSet({ deps, cardAnswers })],
    preLLMProcessors: [cardAnswers],
    instructionBuilders: [
      (builder: InstructionBuilder) => builder.addSection(CONNECTION_OFFER_INSTRUCTION_SECTION, instruction),
    ],
  };
}
