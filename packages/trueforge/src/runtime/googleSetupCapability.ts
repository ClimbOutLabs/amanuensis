/**
 * Leading a person through connecting Google, from chat. The chat holds no secret and starts no sign-in:
 * it reads the saved login's state, says the one next step in plain words, and sends the person to the
 * Google page in Settings, Connectors for every step that touches the client file, the secret, the client
 * check, or the consent itself. That page is where the secret is entered, the check runs, and consent
 * starts; nothing here loosens any of that.
 */
import type { AgentCapability, AgentTracing, InstructionBuilder } from '@truefoundry/trueforge-core/core';
import { defineTool, LocalToolMCP, toolResultResponse, type ToolDefinition } from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionStore, GoogleOwner } from '@truefoundry/trueforge-core/core/google/connection';
import { GOOGLE_FEATURES, googleFeatureLabel, grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';
import {
  GOOGLE_SETUP_READ_ANNOTATIONS,
  GOOGLE_SETUP_SERVER_ID,
  GOOGLE_SETUP_STATUS_TOOL_NAME,
  GoogleSetupStatusSchema,
} from '@truefoundry/trueforge-core/core/google/setupToolContract';

function jsonResult(value: unknown) {
  return toolResultResponse({ text: JSON.stringify(value) });
}

const NOT_CONNECTED_NEXT =
  'Not connected. Lead the person through the setup steps one at a time, starting with the Google Cloud project. The client file and the secret go into the form in Settings, then Connectors, then Google, never into this chat.';

const NEEDS_RECONNECT_NEXT =
  'The sign-in expired, so mail and calendar are paused. Ask the person to open Settings, then Connectors, then Google, and choose Reconnect. If this keeps happening about once a week, their Google project is still in Testing; the same page says how to publish it.';

interface GoogleSetupToolSetOptions {
  connections: GoogleConnectionStore;
  owner: GoogleOwner;
  tracing: AgentTracing;
}

/** The one read the guided setup makes: the state of the saved Google login, in the panel's own shape. */
export class GoogleSetupToolSet extends LocalToolMCP {
  readonly name = GOOGLE_SETUP_SERVER_ID;
  readonly displayName = 'Google setup';
  readonly #options: GoogleSetupToolSetOptions;
  readonly #tools: ToolDefinition[];

  constructor(options: GoogleSetupToolSetOptions) {
    super({ tracing: options.tracing });
    this.#options = options;
    this.#tools = [
      defineTool({
        name: GOOGLE_SETUP_STATUS_TOOL_NAME,
        description:
          'Read the state of the Google connection: whether it is connected, which of mail and calendar it may use, and the one next step. Call it before leading the setup, and again after the person finishes on the Settings page, to confirm what Google granted.',
        schema: GoogleSetupStatusSchema,
        annotations: GOOGLE_SETUP_READ_ANNOTATIONS,
        handler: () => this.#status(),
      }),
    ];
  }

  protected getTools(): ToolDefinition[] {
    return this.#tools;
  }

  async #status() {
    const record = await this.#options.connections.get(this.#options.owner);
    const granted = record === null ? [] : grantedFeatures(record.granted_scopes);
    const features = GOOGLE_FEATURES.map(feature => ({
      feature,
      label: googleFeatureLabel(feature),
      granted: granted.includes(feature),
    }));
    if (record === null) {
      return jsonResult({
        state: 'not_connected',
        account_email: null,
        features,
        has_saved_client: false,
        next_step: NOT_CONNECTED_NEXT,
      });
    }
    if (record.status === 'needs_reconnect') {
      return jsonResult({
        state: record.status,
        account_email: record.account_email,
        features,
        has_saved_client: true,
        next_step: NEEDS_RECONNECT_NEXT,
      });
    }
    const missing = features.filter(item => !item.granted).map(item => item.label);
    const account = record.account_email ?? 'your Google account';
    return jsonResult({
      state: record.status,
      account_email: record.account_email,
      features,
      has_saved_client: true,
      next_step:
        missing.length === 0
          ? `Connected as ${account}, with everything allowed. There is nothing left to set up.`
          : `Connected as ${account}. Still off: ${missing.join('; ')}. If the person wants one of these, it is turned on from Settings, then Connectors, then Google.`,
    });
  }
}

const GOOGLE_SETUP_INSTRUCTION_SECTION = 'google_setup';

export const GOOGLE_SETUP_INSTRUCTION = `Connecting Google: when the person asks to connect Google, or wants mail or calendar that is not connected yet, offer to lead the setup and call google_setup_status first. Then lead one step at a time, in this order, waiting for the person to say each step is done before giving the next:
1. Make a Google Cloud project at https://console.cloud.google.com/projectcreate (an existing project is fine).
2. Turn on the Gmail API at https://console.cloud.google.com/apis/library/gmail.googleapis.com and the Google Calendar API at https://console.cloud.google.com/apis/library/calendar-json.googleapis.com (click Enable on each page). Only the ones for what the person picked need turning on.
3. Set up the consent screen at https://console.cloud.google.com/apis/credentials/consent : choose External, an app name, and their email address.
4. Before they connect, tell them this, in these words or close to them: a personal Google app starts in Testing, and in Testing Google ends the sign-in after 7 days, so the connection would stop working about a week later with nothing looking wrong. To keep it connected, on the Audience page (https://console.cloud.google.com/auth/audience) choose Publish app before connecting. Google then shows a screen saying it has not verified this app; that is expected for a personal app, and it is safe to pass by choosing Advanced, then continue, because the app is theirs and only they use it. If they would rather stay in Testing, they add themselves as a test user on the same Audience page, and they will need to reconnect about once a week.
5. Create the sign-in client at https://console.cloud.google.com/apis/credentials , of the kind the Google page in Settings names (Desktop app, or Web application with the exact return address that page shows). Then download the client file.
6. The client file and the secret go only into the form in Settings, then Connectors, then Google. Never ask for the secret or the file in this chat, and never use one pasted here: say it cannot be used from chat and point to the form.
7. On that page, run Check my client. Every problem it names is the next step to fix. Do not move on to Connect until the check finds no problems.
8. On the same page, tick what the person picked and choose Connect Google: reading mail; saving drafts and sending, which still asks before every send; reading the calendar; adding events, which still asks before each one. Mail connects first; calendar is added straight after in the same sitting, from the same page. If Google sends them to a page that will not load, that page is expected: tell them, before they go, to copy the whole address from the browser address bar and paste it into the box on the Settings page.
After they finish, call google_setup_status again and confirm the connection is on for what they picked. Disconnect is on the same Settings page and removes the saved login for good.`;

function buildGoogleSetupInstruction(builder: InstructionBuilder): void {
  builder.addSection(GOOGLE_SETUP_INSTRUCTION_SECTION, GOOGLE_SETUP_INSTRUCTION);
}

interface GoogleSetupCapabilityOptions {
  connections: GoogleConnectionStore;
  owner: GoogleOwner;
  tracing: AgentTracing;
}

/**
 * The guided setup for one turn. The walkthrough mounts only where its steps can still be acted on:
 * with no login, or an expired one, the Cloud steps are still ahead of the person, so the guidance
 * rides with the read. Once the login is connected, those steps are done and cannot be done again
 * from chat; what is still off is turned on from the Settings page, which the read's next step names,
 * so the read mounts alone and the walkthrough does not ride on every turn of a connected instance.
 * A login connected with everything allowed mounts nothing: there is nothing left to lead.
 * Reading the login here is the same read the Google tools make.
 */
export async function googleSetupCapability(
  options: GoogleSetupCapabilityOptions,
): Promise<AgentCapability | undefined> {
  const record = await options.connections.get(options.owner);
  if (record?.status === 'connected') {
    const granted = grantedFeatures(record.granted_scopes);
    if (GOOGLE_FEATURES.every(feature => granted.includes(feature))) {
      return undefined;
    }
    return { systemToolSets: [new GoogleSetupToolSet(options)] };
  }
  return {
    systemToolSets: [new GoogleSetupToolSet(options)],
    instructionBuilders: [buildGoogleSetupInstruction],
  };
}
