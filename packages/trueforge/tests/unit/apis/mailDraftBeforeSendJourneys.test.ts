/**
 * Walks an email from "Aman wants to send this" to the mail server, through the real server with a scripted
 * model and a stand-in mail server that keeps every call it receives. Each test reads the card the person is
 * shown and what the mail server received, never how the rule is built.
 */
import { z } from '@hono/zod-openapi';
import type { Turn, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import {
  isMailSendToolName,
  MAIL_CONNECTOR_NAME,
  MAIL_DRAFT_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import { TENANT_ID } from '../../../src/apis/sessions';
import configuration from '../../../src/config';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { registerMailConnector } from '../../../src/runtime/mailConnector';
import { approvalPrompt } from '../../../src/runtime/telegram/telegramReplies';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import {
  INERT_MAIL_ACCOUNTS,
  startInertMcpServer,
  type InertMailCall,
  type InertMcpServer,
} from '../../fixtures/inertMcpServer';
import { RUN_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;

const [HOME_ACCOUNT, WORK_ACCOUNT] = INERT_MAIL_ACCOUNTS;

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Do exactly what is asked.',
  mcp_servers: [{ name: MAIL_CONNECTOR_NAME, preload: true }],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

interface Email {
  recipients: string[];
  subject: string;
  body: string;
  account_name?: string;
}

/** A new email each time, so one test's answers never cover another's. */
function emailTo(name: string): Email {
  return {
    recipients: [`${name}@harbour.example`],
    subject: `Bread order for ${name}`,
    body: `Hi ${name}, could I order two loaves for Saturday?`,
  };
}

type Answer = { status: 'allow'; scope: 'once' | 'chat' | 'always'; from_account?: string } | { status: 'deny' };

describe('an email Aman sends for the person', () => {
  let server: ApprovalTestServer;
  let mailServer: InertMcpServer;
  const originalMailUrl = configuration.MAIL_SIDECAR_MCP_URL;

  beforeAll(async () => {
    server = await startApprovalTestServer({ mailSendList: true });
    mailServer = await startInertMcpServer({ mail: true });
    server.setFirstPartyOrigins([mailServer.origin]);
    configuration.MAIL_SIDECAR_MCP_URL = mailServer.url;
    await registerMailConnector({
      url: mailServer.url,
      mcpServerStore: new SqliteMcpServerStore(server.db()),
      tenant_id: TENANT_ID,
    });
  }, 120_000);

  afterAll(async () => {
    configuration.MAIL_SIDECAR_MCP_URL = originalMailUrl;
    await mailServer.close();
    await server.close();
  });

  beforeEach(() => {
    mailServer.resetInvocations();
  });

  /** The emails the mail server was told to send or forward, in order. */
  function sent(): InertMailCall[] {
    return mailServer.mailCalls().filter(call => isMailSendToolName(call.name));
  }

  function savedDrafts(): InertMailCall[] {
    return mailServer.mailCalls().filter(call => call.name === MAIL_DRAFT_TOOL_NAME);
  }

  async function createChat(): Promise<string> {
    const response = await server.request('/api/v1/sessions', json({ agent: { spec: AGENT_SPEC } }));
    const body: unknown = await response.json();
    if (response.status !== 201) {
      throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
    }
    return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
  }

  function json(body: unknown): RequestInit {
    return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }

  function sendTurn({ chatId, input }: { chatId: string; input: TurnInputItem[] }): Promise<Response> {
    return server.request(
      `/api/v1/sessions/${chatId}/turns`,
      json({ input, stream: true, client_timezone: 'Europe/London' }),
    );
  }

  async function runTurn({ chatId, input }: { chatId: string; input: TurnInputItem[] }): Promise<Turn> {
    const response = await sendTurn({ chatId, input });
    if (response.status !== 200) {
      throw new Error(`create turn failed (${String(response.status)}): ${await response.text()}`);
    }
    const created = (await response.text())
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length))))
      .find(event => event.type === 'turn.created');
    if (created === undefined) {
      throw new Error('the turn stream carried no turn.created event');
    }
    const saved = await server.request(`/api/v1/sessions/${chatId}/turns/${created.turn_id}`);
    return GetTurnResponseSchema.parse(await saved.json()).data;
  }

  /** Has Aman try the mail tool with this email, and returns the one card the chat then waits on. */
  async function askFor({ chatId, tool, email }: { chatId: string; tool: string; email: Email }) {
    server.model.next({ toolArguments: email });
    const turn = await runTurn({
      chatId,
      input: [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${tool} to ${email.recipients.join(', ')}` }],
    });
    if (turn.state.status !== 'done') {
      throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
    }
    const waiting = turn.state.required_actions.flatMap(action =>
      action.type === 'tool.approval_required'
        ? action.tool_calls.map(call => ({ ...call, thread_id: action.thread_id, action }))
        : [],
    );
    const [card, ...others] = waiting;
    if (card === undefined || others.length > 0) {
      throw new Error(`expected one card, found ${String(waiting.length)}`);
    }
    return card;
  }

  function answer({ card, approval }: { card: { thread_id: string; id: string }; approval: Answer }): TurnInputItem[] {
    return [{ type: 'user.tool_approval', thread_id: card.thread_id, tool_call_id: card.id, approval }];
  }

  it(
    'shows the whole email on a card first, and the mail server hears of no send until the person approves that card',
    async () => {
      const chatId = await createChat();
      const email = emailTo('dana');
      const card = await askFor({ chatId, tool: 'send_email', email });

      expect(sent()).toEqual([]);
      expect(card.tier).toBe(3);
      const shown = card.tier3_card?.outbound_text ?? '';
      expect(shown).toContain(email.recipients[0]);
      expect(shown).toContain(email.subject);
      expect(shown).toContain(email.body);
      expect(card.tier3_card?.outbound_truncated).toBe(false);
      expect(card.tier3_card?.mail_from).toBe(HOME_ACCOUNT);

      await runTurn({ chatId, input: answer({ card, approval: { status: 'allow', scope: 'once' } }) });
      expect(sent()).toEqual([{ name: 'send_email', arguments: { ...email, account_name: HOME_ACCOUNT } }]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'asks again for the next email, also to the same person, and sends only what each card showed',
    async () => {
      const chatId = await createChat();
      const first = emailTo('lin');
      const firstCard = await askFor({ chatId, tool: 'send_email', email: first });
      await runTurn({ chatId, input: answer({ card: firstCard, approval: { status: 'allow', scope: 'once' } }) });
      expect(sent()).toHaveLength(1);

      const second = { ...first, subject: 'One more thing', body: 'Could you add a rye loaf?' };
      const secondCard = await askFor({ chatId, tool: 'send_email', email: second });
      expect(secondCard.tier3_card?.outbound_text).toContain(second.body);
      expect(sent()).toHaveLength(1);

      await runTurn({ chatId, input: answer({ card: secondCard, approval: { status: 'allow', scope: 'once' } }) });
      expect(sent().map(call => call.arguments['body'])).toEqual([first.body, second.body]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'sends nothing when the person says no',
    async () => {
      const chatId = await createChat();
      const card = await askFor({ chatId, tool: 'send_email', email: emailTo('noor') });

      await runTurn({ chatId, input: answer({ card, approval: { status: 'deny' } }) });
      expect(sent()).toEqual([]);

      // The card was answered with a no, so a later yes for it has nothing to send.
      await sendTurn({ chatId, input: answer({ card, approval: { status: 'allow', scope: 'once' } }) });
      expect(sent()).toEqual([]);
    },
    TURN_TIMEOUT_MS,
  );

  it.each(['chat', 'always'] as const)(
    'offers no "Always allow", and an answer of "%s" is refused with nothing sent',
    async scope => {
      const chatId = await createChat();
      const card = await askFor({ chatId, tool: 'send_email', email: emailTo(`sam-${scope}`) });
      expect(card.can_chat_allow).toBe(false);
      expect(card.can_always_allow).toBe(false);

      const refused = await sendTurn({ chatId, input: answer({ card, approval: { status: 'allow', scope } }) });
      expect(refused.status).toBe(422);
      expect(sent()).toEqual([]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'forwarding an email asks the same way',
    async () => {
      const chatId = await createChat();
      const email = emailTo('ines');
      const card = await askFor({ chatId, tool: 'forward_email', email });
      expect(card.tier3_card?.outbound_text).toContain(email.recipients[0]);
      expect(sent()).toEqual([]);

      await runTurn({ chatId, input: answer({ card, approval: { status: 'allow', scope: 'once' } }) });
      expect(sent().map(call => call.name)).toEqual(['forward_email']);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'in Telegram the same card is a message with the whole email and the account it goes from, and nothing is sent before a tap',
    async () => {
      const chatId = await createChat();
      const email = emailTo('kai');
      const card = await askFor({ chatId, tool: 'send_email', email });

      const message = approvalPrompt(card.action, card.id);
      // Buttons only ride a message that shows everything the card shows.
      expect(message?.complete).toBe(true);
      expect(message?.approve_label).toBe('Add and send');
      for (const shown of [email.recipients[0], email.subject, email.body, HOME_ACCOUNT]) {
        expect(message?.text).toContain(shown);
      }
      expect(sent()).toEqual([]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'saving a draft asks first too, and approving it sends nothing',
    async () => {
      const chatId = await createChat();
      const email = emailTo('omar');
      const card = await askFor({ chatId, tool: MAIL_DRAFT_TOOL_NAME, email });
      expect(card.tier3_card?.outbound_text).toContain(email.body);
      expect(savedDrafts()).toEqual([]);

      await runTurn({ chatId, input: answer({ card, approval: { status: 'allow', scope: 'once' } }) });
      expect(savedDrafts()).toHaveLength(1);
      expect(sent()).toEqual([]);
    },
    TURN_TIMEOUT_MS,
  );

  describe('with more than one email account', () => {
    it(
      'names the account on the card and sends from that account when the answer picks no other',
      async () => {
        const chatId = await createChat();
        const email = { ...emailTo('pia'), account_name: WORK_ACCOUNT };
        const card = await askFor({ chatId, tool: 'send_email', email });
        expect(card.tier3_card?.mail_from).toBe(WORK_ACCOUNT);
        expect(card.tier3_card?.mail_from_choices).toEqual([...INERT_MAIL_ACCOUNTS]);

        await runTurn({ chatId, input: answer({ card, approval: { status: 'allow', scope: 'once' } }) });
        expect(sent().map(call => call.arguments['account_name'])).toEqual([WORK_ACCOUNT]);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'sends from the account the person picked on the card, once, with the email the card showed',
      async () => {
        const chatId = await createChat();
        const email = emailTo('quinn');
        // Both accounts have written to this person before, so a pick of either has no new address.
        for (const account_name of INERT_MAIL_ACCOUNTS) {
          const earlier = await askFor({ chatId, tool: 'send_email', email: { ...email, account_name } });
          await runTurn({ chatId, input: answer({ card: earlier, approval: { status: 'allow', scope: 'once' } }) });
        }
        mailServer.resetInvocations();

        const card = await askFor({ chatId, tool: 'send_email', email });
        expect(card.tier3_card?.mail_from).toBe(HOME_ACCOUNT);
        expect(sent()).toEqual([]);

        await runTurn({
          chatId,
          input: answer({ card, approval: { status: 'allow', scope: 'once', from_account: WORK_ACCOUNT } }),
        });
        expect(sent()).toEqual([{ name: 'send_email', arguments: { ...email, account_name: WORK_ACCOUNT } }]);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'sends nothing when the picked account has never written to that address, and says to ask again from that account',
      async () => {
        const chatId = await createChat();
        const card = await askFor({ chatId, tool: 'send_email', email: emailTo('rosa') });
        expect(card.tier3_card?.mail_new_recipients).toEqual(['rosa@harbour.example']);

        const refused = await sendTurn({
          chatId,
          input: answer({ card, approval: { status: 'allow', scope: 'once', from_account: WORK_ACCOUNT } }),
        });
        expect(refused.status).toBe(422);
        expect(await refused.text()).toContain('Ask Aman to send it from that account');
        expect(sent()).toEqual([]);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'sends nothing when the answer names an account that is not one of the person’s own',
      async () => {
        const chatId = await createChat();
        const card = await askFor({ chatId, tool: 'send_email', email: emailTo('tessa') });

        await sendTurn({
          chatId,
          input: answer({
            card,
            approval: { status: 'allow', scope: 'once', from_account: 'someone@elsewhere.example' },
          }),
        });
        expect(sent()).toEqual([]);
      },
      TURN_TIMEOUT_MS,
    );
  });
});
