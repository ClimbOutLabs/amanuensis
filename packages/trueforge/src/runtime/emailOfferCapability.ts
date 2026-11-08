/**
 * Offering to connect email from a chat, at the moment of need. When a mail task arrives and no
 * email route is connected, the chat offers the connection on a question card instead of ending
 * at a pointer to Settings. The chat holds no secret and connects nothing itself: a yes sends the
 * person to the Email form in Settings, Connectors, the one place an app password is ever typed
 * (the settled rule from the email connector), and when they come back the original task runs
 * without being asked twice. A no is recorded once and holds in every chat; the only words after
 * it are the one line that leaves Settings as the way back.
 */
import type { AgentCapability, AgentTracing, InstructionBuilder } from '@truefoundry/trueforge-core/core';
import { defineTool, LocalToolMCP, toolResultResponse, type ToolDefinition } from '@truefoundry/trueforge-core/core';
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
export const EMAIL_OFFER_DECLINE_LINE = 'No problem. You can connect it any time in Settings, under Email';

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

const CONNECTED_NEXT = 'Email is connected. Do the mail task the person asked for.';

const DECLINED_NEXT =
  'The person already turned down the offer to connect email. Do not offer again, in this chat or any other. Do what you can without email, and leave Settings as their way back.';

const NOT_CONNECTED_NEXT =
  'Email is not connected. Offer the connection on the question card before saying the task cannot be done.';

/** The offer's two tools: one read of the connection state, and the one write that remembers a no. */
export class EmailOfferToolSet extends LocalToolMCP {
  readonly name = EMAIL_OFFER_SERVER_ID;
  readonly displayName = 'Email connection offer';
  readonly #deps: EmailOfferDeps;
  readonly #tools: ToolDefinition[];

  constructor(deps: EmailOfferDeps) {
    super({ tracing: deps.tracing });
    this.#deps = deps;
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
          'Record that the person said no to connecting email, so Aman never offers it again in any chat. Call it only with the answer the person just gave to the offer, never on a guess. It returns the one line to reply with; send that line and nothing more on the subject, then carry on without email.',
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
    await this.#deps.settings.setSetting({ key: EMAIL_OFFER_DECLINED_SETTING_KEY, value: 'true' });
    return jsonResult({ recorded: true, reply_line: EMAIL_OFFER_DECLINE_LINE });
  }
}

const EMAIL_OFFER_INSTRUCTION_SECTION = 'email_connection_offer';

export const EMAIL_OFFER_INSTRUCTION = `Connecting email at the moment of need: this Aman has no email connected, and the person has not turned down the offer. When the person asks for anything that needs email (reading, searching, drafting or sending mail), do not say it cannot be done and stop. Offer first, once, through ask_user_question: the question "Would you like to connect your email so I can do that?" and the two options "Connect my email" and "Not now". Offer only when the message really needs email.

If they pick "Connect my email", or say yes in their own words: tell them, in plain words, to open Settings, then Connectors, and connect from the Email card there. For Gmail, the Google card on the same page connects mail too, and its own steps lead that way. The Settings forms are the only place an app password ever goes: never ask for one in this chat, and never use one pasted here. Then stop and wait. When they come back and say it is done, call email_connection_status. Once it says email is connected, do the thing they originally asked for in this chat, without making them ask again.

If they pick "Not now", or say no in their own words: call record_email_offer_decline, then reply with exactly the line it returns and nothing more on the subject. Carry on with whatever can be done without email, such as working from text they paste or details they give you. Never offer again after that call, in this chat or any other.`;

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
  return {
    systemToolSets: [new EmailOfferToolSet(deps)],
    instructionBuilders: [buildEmailOfferInstruction],
  };
}
