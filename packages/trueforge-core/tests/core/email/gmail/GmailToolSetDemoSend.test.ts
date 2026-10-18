import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import { DEMO_SEND_REFUSAL } from '../../../../src/core/permissions/sendAllowlist';
import { message, plainDraft } from './fixtures';
import { approvedContext, build, json, route, text, threadRoute, type Route } from './harness';

const COMPOSE = ['gmail_read', 'gmail_compose'] as const;
const DEMO_LIST = ['maya@demo.example', 'friend@demo.example'];

const draftRoute = (mail: GmailMessage): Route => route('/drafts/d1', { id: 'd1', message: mail });
const sendRoute: Route = url =>
  url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ id: 'sent-1', threadId: 't9' }) : undefined;

const sentCount = (urls: string[]) => urls.filter(entry => entry.includes('/drafts/send')).length;

const REPLY = plainDraft({
  id: 'm',
  threadId: 't9',
  to: 'stranger@outside.example',
  subject: 'Re: Lease',
  body: 'Thursday works.',
  extraHeaders: [
    { name: 'In-Reply-To', value: '<orig@example.com>' },
    { name: 'References', value: '<orig@example.com>' },
  ],
});

/** The message the reply answers, so the reply's threading holds and only the list can refuse it. */
const ANSWERED = message({
  id: 'orig',
  threadId: 't9',
  from: 'stranger@outside.example',
  subject: 'Lease',
  extraHeaders: [{ name: 'Message-ID', value: '<orig@example.com>' }],
});

/** The drafts a model can make for each way of sending, each with one address outside the list. */
const STRAY_DRAFTS: { name: string; mail: GmailMessage; routes?: Route[] }[] = [
  { name: 'send', mail: plainDraft({ id: 'm', to: 'stranger@outside.example', body: 'Hi' }) },
  { name: 'reply', mail: REPLY, routes: [threadRoute({ id: 't9', messages: [ANSWERED, REPLY] })] },
  {
    name: 'reply-all with an extra Cc',
    mail: plainDraft({
      id: 'm',
      to: 'maya@demo.example',
      cc: 'friend@demo.example, stranger@outside.example',
      body: 'Hi',
    }),
  },
  {
    name: 'forward with an extra To',
    mail: plainDraft({
      id: 'm',
      to: 'maya@demo.example, stranger@outside.example',
      subject: 'Fwd: Lease',
      body: '---------- Forwarded message ----------\nThursday works.',
    }),
  },
  {
    name: 'a hidden copy',
    mail: plainDraft({ id: 'm', to: 'maya@demo.example', bcc: 'stranger@outside.example', body: 'Hi' }),
  },
];

describe('demo send allowlist on send_draft', () => {
  describe.each(STRAY_DRAFTS)('$name', ({ mail, routes = [] }) => {
    it('is refused before any card is shown', async () => {
      const { tools, google } = await build({
        features: [...COMPOSE],
        routes: [draftRoute(mail), sendRoute, ...routes],
        demoSendAllowlist: DEMO_LIST,
      });
      const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      expect(info.is_approval_required).not.toBe(true);
      expect(info.tier3_card).toBeFalsy();
      expect(info.tier).toBe(3);
      expect(JSON.stringify(info)).toContain(DEMO_SEND_REFUSAL);
      expect(sentCount(google.urls)).toBe(0);
    });

    it('is refused again at send time even when the send was approved', async () => {
      const { tools, google, sentinel } = await build({
        features: [...COMPOSE],
        routes: [draftRoute(mail), sendRoute, ...routes],
        demoSendAllowlist: null,
      });
      const call = { name: 'send_draft', arguments: { draft_id: 'd1' } };
      const info = await tools.toolCallInfo(call);
      expect(info.is_approval_required).toBe(true);
      sentinel.services.demoSendAllowlist = DEMO_LIST;
      const response = await tools.callTool(call, undefined, approvedContext(info));
      expect(text(response)).toContain(DEMO_SEND_REFUSAL);
      expect(sentCount(google.urls)).toBe(0);
    });
  });

  it('sends a draft whose every recipient is on the list', async () => {
    const mail = plainDraft({
      id: 'm',
      to: 'Maya <maya@demo.example>',
      cc: 'friend@demo.example',
      bcc: 'maya@demo.example',
      body: 'Hi',
    });
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [draftRoute(mail), sendRoute],
      demoSendAllowlist: DEMO_LIST,
    });
    const call = { name: 'send_draft', arguments: { draft_id: 'd1' } };
    const info = await tools.toolCallInfo(call);
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    const response = await tools.callTool(call, undefined, approvedContext(info));
    expect(JSON.parse(text(response))).toMatchObject({ status: 'sent' });
    expect(sentCount(google.urls)).toBe(1);
  });

  it('matches addresses without regard to case or edge space', async () => {
    const mail = plainDraft({ id: 'm', to: 'MAYA@Demo.Example', body: 'Hi' });
    const { tools } = await build({
      features: [...COMPOSE],
      routes: [draftRoute(mail), sendRoute],
      demoSendAllowlist: ['  Maya@DEMO.example '],
    });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(info.is_approval_required).toBe(true);
  });

  it('refuses every send when the list is empty', async () => {
    const mail = plainDraft({ id: 'm', to: 'maya@demo.example', body: 'Hi' });
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [draftRoute(mail), sendRoute],
      demoSendAllowlist: [],
    });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(info.tier3_card).toBeFalsy();
    expect(JSON.stringify(info)).toContain(DEMO_SEND_REFUSAL);
    expect(sentCount(google.urls)).toBe(0);
  });

  it('changes nothing outside demo mode', async () => {
    const mail = plainDraft({ id: 'm', to: 'stranger@outside.example', body: 'Hi' });
    const { tools, google } = await build({ features: [...COMPOSE], routes: [draftRoute(mail), sendRoute] });
    const call = { name: 'send_draft', arguments: { draft_id: 'd1' } };
    const info = await tools.toolCallInfo(call);
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    const response = await tools.callTool(call, undefined, approvedContext(info));
    expect(JSON.parse(text(response))).toMatchObject({ status: 'sent' });
    expect(sentCount(google.urls)).toBe(1);
  });

  it('still saves drafts to anyone, since a draft never leaves the account', async () => {
    const { tools } = await build({
      features: [...COMPOSE],
      routes: [],
      demoSendAllowlist: [],
    });
    const info = await tools.toolCallInfo({
      name: 'draft_email',
      arguments: { to: ['stranger@outside.example'], subject: 'Lease', body: 'Hi' },
    });
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
  });
});
