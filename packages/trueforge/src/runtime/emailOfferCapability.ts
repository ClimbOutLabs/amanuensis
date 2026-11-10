/**
 * Offering to connect email from a chat, at the moment of need. When a mail task arrives and no
 * email route is connected, the chat offers the connection on a question card instead of ending
 * at a pointer to Settings. The chat holds no secret and connects nothing itself: a yes points the
 * person to the Email form in Settings, Connectors, the one place an app password is ever typed
 * (the settled rule from the email connector), and when they come back the original task runs
 * without being asked twice. Only a no given as the answer to that card is recorded, and a
 * recorded no holds in every chat. A no in the person's own words is honoured for the moment and
 * leaves no record, so the offer can come again at a later need. Either way, the only words after
 * a no are the one line that leaves Settings as the way back.
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
  EMAIL_CONNECTION_STATUS_TOOL_NAME,
  EMAIL_OFFER_DECLINE_ANNOTATIONS,
  EMAIL_OFFER_READ_ANNOTATIONS,
  EMAIL_OFFER_SERVER_ID,
  EmailConnectionStatusSchema,
  RECORD_EMAIL_OFFER_DECLINE_TOOL_NAME,
  RecordEmailOfferDeclineSchema,
} from '@truefoundry/trueforge-core/core/email/offerToolContract';
import type { GoogleConnectionStore, GoogleOwner } from '@truefoundry/trueforge-core/core/google/connection';
import { grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';

/** The remembered no, kept as an instance setting: one owner per instance, so one flag is the whole record. */
export const EMAIL_OFFER_DECLINED_SETTING_KEY = 'email_offer_declined';

/** The whole reply after a no: one line, and it leaves Settings as the person's way back. */
export const EMAIL_OFFER_DECLINE_LINE =
  'No problem. You can connect it any time in Settings, then Connectors, from the Email card.';

/**
 * The offer card's exact words. The instruction below asks with them, and the recorded-no check
 * recognises the card by them, so the two can never drift apart.
 */
export const EMAIL_OFFER_QUESTION = 'Would you like to connect your email so I can do that?';
export const EMAIL_OFFER_CONNECT_OPTION = 'Connect my email';
export const EMAIL_OFFER_DECLINE_OPTION = 'Not now';

export interface EmailOfferDeps {
  /** True exactly while a mail account is saved: the Email connector is registered only then. */
  mailConnectorRegistered: () => Promise<boolean>;
  /** The saved Google login store; undefined on an instance with no Google wiring. */
  googleConnections: GoogleConnectionStore | undefined;
  owner: GoogleOwner;
  settings: Pick<IGlobalSettingsStore, 'getSetting' | 'setSetting'>;
  tracing: AgentTracing;
}

export interface EmailConnectionState {
  connected: boolean;
  /** Which route connects email; null when none does. */
  via: 'email_account' | 'google' | null;
  /** Whether the person has already turned the offer down, in any chat. */
  declined: boolean;
}

/**
 * The one read behind both the mount decision and the status tool: a saved mail account connects
 * email, and so does a Google login that may read Gmail. A login that needs reconnecting does not
 * count, because mail through it is paused.
 */
export async function readEmailConnectionState(deps: EmailOfferDeps): Promise<EmailConnectionState> {
  const declined = (await deps.settings.getSetting({ key: EMAIL_OFFER_DECLINED_SETTING_KEY }))?.value === 'true';
  if (await deps.mailConnectorRegistered()) {
    return { connected: true, via: 'email_account', declined };
  }
  if (deps.googleConnections !== undefined) {
    const record = await deps.googleConnections.get(deps.owner);
    if (
      record !== null &&
      record.status === 'connected' &&
      grantedFeatures(record.granted_scopes).includes('gmail_read')
    ) {
      return { connected: true, via: 'google', declined };
    }
  }
  return { connected: false, via: null, declined };
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

/**
 * Whether the exchange this turn continues from is the offer's own question card answered with
 * its decline choice. The proof is read from the recorded thread context, which only the host
 * writes: the last tool result in it must answer a client-side question call whose question and
 * choices are the offer card's own, its answer must be the decline choice itself, and nothing the
 * person or the model said may follow that result, so an answer left over from an older exchange
 * can never stand in for this turn's.
 */
function offerDeclineAnsweredOnCard(context: readonly ContextMessage[]): boolean {
  let resultIndex = -1;
  for (let i = context.length - 1; i >= 0; i -= 1) {
    const message = context[i];
    if (message !== undefined && 'role' in message && message.role === 'tool') {
      resultIndex = i;
      break;
    }
  }
  if (resultIndex < 0) {
    return false;
  }
  const result = context[resultIndex];
  if (result === undefined || !('role' in result) || result.role !== 'tool') {
    return false;
  }
  for (let i = resultIndex + 1; i < context.length; i += 1) {
    const message = context[i];
    if (message !== undefined && 'role' in message && !isInternalSystemMessage(message)) {
      return false;
    }
  }
  let call: { name: string; arguments: string; isClientSide: boolean } | undefined;
  for (let i = resultIndex - 1; i >= 0 && call === undefined; i -= 1) {
    const message = context[i];
    if (message === undefined || !('role' in message) || message.role !== 'assistant') {
      continue;
    }
    const found = (message.tool_calls ?? []).find(candidate => candidate.id === result.tool_call_id);
    if (found !== undefined) {
      call = {
        name: found.function.name,
        arguments: found.function.arguments,
        isClientSide: found.tool_info.is_client_side === true,
      };
    }
  }
  if (call === undefined || !call.isClientSide || !call.name.endsWith(ASK_USER_QUESTION_TOOL_NAME)) {
    return false;
  }
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return false;
  }
  if (!isRecord(args) || args['question'] !== EMAIL_OFFER_QUESTION) {
    return false;
  }
  const options = args['options'];
  if (!Array.isArray(options) || !options.includes(EMAIL_OFFER_DECLINE_OPTION)) {
    return false;
  }
  const answer = toolAnswerText(result.content);
  return answer?.trim() === EMAIL_OFFER_DECLINE_OPTION;
}

// Derived from the exported capability type rather than naming the processor interface directly:
// it is not part of trueforge-core's public entry point.
type PreLLMProcessor = NonNullable<AgentCapability['preLLMProcessors']>[number];

/** A processor pass that adds nothing to the context. */
const NOTHING_TO_ADD: AsyncIterable<AgentContextProcessorOutput> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
};

/**
 * The offer card's answer as this thread has seen it, latched from the recorded context before
 * the model can act on the answer: these processors run ahead of every model call in the turn,
 * and the tool that remembers a no runs only after one. The decline tool records only when this
 * latch is set, so words in a chat, the person's or anyone else's, can never plant a remembered
 * no: only the person's own pick on the offer card can.
 */
class OfferCardAnswer implements PreLLMProcessor {
  #declinedOnCard = false;

  get declinedOnCard(): boolean {
    return this.#declinedOnCard;
  }

  processPreLLM(execution: Readonly<AgentThreadExecutionContext>): AsyncIterable<AgentContextProcessorOutput> {
    if (!this.#declinedOnCard && offerDeclineAnsweredOnCard(execution.context)) {
      this.#declinedOnCard = true;
    }
    return NOTHING_TO_ADD;
  }
}

const CONNECTED_NEXT = 'Email is connected. Do the mail task the person asked for.';

const DECLINED_NEXT =
  'The person already turned down the offer to connect email. Do not offer again, in this chat or any other. Do what you can without email, and leave Settings as their way back.';

const NOT_CONNECTED_NEXT =
  'Email is not connected. Offer the connection on the question card before saying the task cannot be done.';

const DECLINE_REMEMBERED_NEXT =
  'The no was remembered. Reply with the reply_line and nothing more on the subject, then carry on without email. Never offer to connect email again, in this chat or any other.';

const DECLINE_NOT_REMEMBERED_NEXT =
  'The no was not remembered, because it did not come from the offer card. Do not say it was remembered, and do not offer again in this chat. Reply with the reply_line and nothing more on the subject, then carry on without email.';

/** The offer's two tools: one read of the connection state, and the one write that remembers a no. */
export class EmailOfferToolSet extends LocalToolMCP {
  readonly name = EMAIL_OFFER_SERVER_ID;
  readonly displayName = 'Email connection offer';
  readonly #deps: EmailOfferDeps;
  readonly #cardAnswer: OfferCardAnswer;
  readonly #tools: ToolDefinition[];

  constructor(deps: EmailOfferDeps, cardAnswer: OfferCardAnswer) {
    super({ tracing: deps.tracing });
    this.#deps = deps;
    this.#cardAnswer = cardAnswer;
    this.#tools = [
      defineTool({
        name: EMAIL_CONNECTION_STATUS_TOOL_NAME,
        description:
          'Read whether email is connected on this Aman: whether a mail account is saved, whether Google mail is connected, and whether the person has already turned down the offer to connect email. Call it before offering, and again after the person finishes connecting in Settings, to confirm email is on before doing the mail task they asked for.',
        schema: EmailConnectionStatusSchema,
        annotations: EMAIL_OFFER_READ_ANNOTATIONS,
        handler: () => this.#status(),
      }),
      defineTool({
        name: RECORD_EMAIL_OFFER_DECLINE_TOOL_NAME,
        description:
          'Use it when the person says no to connecting email, whether they picked "Not now" on the offer card or said no in their own words. A no picked on the card is remembered, so Aman never offers it again in any chat. A no in their own words is honoured for now and not remembered. The result says which of the two happened; send the line it returns and nothing more on the subject, then carry on without email.',
        schema: RecordEmailOfferDeclineSchema,
        annotations: EMAIL_OFFER_DECLINE_ANNOTATIONS,
        handler: () => this.#decline(),
      }),
    ];
  }

  protected getTools(): ToolDefinition[] {
    return this.#tools;
  }

  async #status() {
    const state = await readEmailConnectionState(this.#deps);
    return jsonResult({
      ...state,
      next_step: state.connected ? CONNECTED_NEXT : state.declined ? DECLINED_NEXT : NOT_CONNECTED_NEXT,
    });
  }

  async #decline() {
    if (!this.#cardAnswer.declinedOnCard) {
      return jsonResult({
        recorded: false,
        reply_line: EMAIL_OFFER_DECLINE_LINE,
        next_step: DECLINE_NOT_REMEMBERED_NEXT,
      });
    }
    await this.#deps.settings.setSetting({ key: EMAIL_OFFER_DECLINED_SETTING_KEY, value: 'true' });
    return jsonResult({
      recorded: true,
      reply_line: EMAIL_OFFER_DECLINE_LINE,
      next_step: DECLINE_REMEMBERED_NEXT,
    });
  }
}

const EMAIL_OFFER_INSTRUCTION_SECTION = 'email_connection_offer';

export const EMAIL_OFFER_INSTRUCTION = `Connecting email at the moment of need: this Aman has no email connected, and the person has not turned down the offer. When the person asks for anything that needs email (reading, searching, drafting or sending mail), do not say it cannot be done and stop. Offer first, once, through ask_user_question: the question "${EMAIL_OFFER_QUESTION}" and the two options "${EMAIL_OFFER_CONNECT_OPTION}" and "${EMAIL_OFFER_DECLINE_OPTION}". Offer only when the message really needs email.

If they pick "${EMAIL_OFFER_CONNECT_OPTION}", or say yes in their own words: tell them, in plain words, to open Settings, then Connectors, and connect from the Email card there. For Gmail, the Google card on the same page connects mail too, and its own steps lead that way. The Settings forms are the only place an app password ever goes: never ask for one in this chat, and never use one pasted here. Then stop and wait. When they come back and say it is done, call email_connection_status. Once it says email is connected, do the thing they originally asked for in this chat, without making them ask again.

If they pick "${EMAIL_OFFER_DECLINE_OPTION}", or say no in their own words: call record_email_offer_decline, then reply with exactly the line it returns and nothing more on the subject. The call says whether the no was remembered. Only a no picked on the card is remembered: after a remembered no, never offer again, in this chat or any other. A no in their own words is not remembered: do not offer again in this chat, and never say it was remembered. Carry on with whatever can be done without email, such as working from text they paste or details they give you.`;

function buildEmailOfferInstruction(builder: InstructionBuilder): void {
  builder.addSection(EMAIL_OFFER_INSTRUCTION_SECTION, EMAIL_OFFER_INSTRUCTION);
}

/**
 * The offer for one turn. It mounts only while it can still be acted on: no email connected, and
 * no remembered no. Once either changes, there is nothing to offer, so nothing mounts and no
 * other chat can be chased with it.
 */
export async function emailOfferCapability(deps: EmailOfferDeps): Promise<AgentCapability | undefined> {
  const state = await readEmailConnectionState(deps);
  if (state.connected || state.declined) {
    return undefined;
  }
  const cardAnswer = new OfferCardAnswer();
  return {
    systemToolSets: [new EmailOfferToolSet(deps, cardAnswer)],
    preLLMProcessors: [cardAnswer],
    instructionBuilders: [buildEmailOfferInstruction],
  };
}
