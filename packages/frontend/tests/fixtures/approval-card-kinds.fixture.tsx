import {
  EmailApprovalCard,
  PermissionApprovalCard,
  SlotsProvider,
  type SentinelApprovalCard,
} from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

/**
 * One approval card per kind, each carrying server copy and the safe choice marks. Every value is
 * invented. Each card's older plain_what field carries an id-shaped token on purpose: the copy is
 * what renders, so the token must never reach the page.
 */
const TOKEN = 'tok-invented-9f8e7d6c5b4a';

const blank: SentinelApprovalCard = {
  plain_what: '',
  plain_why: null,
  cannot_be_undone: null,
  why_asked_again: null,
  destination: null,
  recipient: null,
  amount: null,
  parsed_command: null,
  outbound_text: null,
  destination_host: null,
  outbound_truncated: false,
  email: null,
  calendar_event: null,
  schedule: null,
  persona: null,
  skill: null,
};

const calendarCard: SentinelApprovalCard = {
  ...blank,
  plain_what: `Delete ${TOKEN}`,
  copy: {
    headline: 'Delete "Harbour picnic", Sat 8 Nov, 11:00 AM?',
    consequence: 'Ada will be emailed that it is cancelled. A cancelled event can be hard to bring back.',
    reason: 'Aman always asks before deleting an event in this calendar.',
  },
  safe_choice: true,
  destructive: true,
};

const emailCard: SentinelApprovalCard = {
  ...blank,
  plain_what: `Send ${TOKEN}`,
  email: {
    action: 'send',
    sent_from: { address: 'ada@example.test', service: 'Gmail' },
    to: [{ name: 'Robin Ellis', address: 'robin@example.test' }],
    cc: [],
    bcc: [],
    subject: 'Picnic plans',
    body: 'Saturday still works for us.\n\nBest,\nAda',
    replaces: null,
    reply_in_thread: null,
    reply_to: null,
  },
  copy: {
    headline: 'Send this email to Robin Ellis?',
    consequence: "Once Robin Ellis has it, it can't be unsent.",
    reason: 'You approve every send in this chat.',
  },
  safe_choice: true,
  destructive: true,
};

const fileCard: SentinelApprovalCard = {
  ...blank,
  plain_what: `Write ${TOKEN}`,
  copy: {
    headline: 'Write the packing list into trips/packing.md?',
    consequence: null,
    reason: 'Writing to this folder always asks.',
  },
};

const paymentCard: SentinelApprovalCard = {
  ...blank,
  plain_what: `Send ${TOKEN} to Acme Corp`,
  destination: 'acme-corp',
  recipient: 'Acme Corp',
  amount: '$250',
  copy: {
    headline: 'Send $250 to Acme Corp?',
    consequence: 'The transfer cannot be reversed.',
    reason: 'Payments always ask.',
  },
  safe_choice: true,
  destructive: true,
};

const sandboxCard: SentinelApprovalCard = {
  ...blank,
  plain_what: `Run ${TOKEN}`,
  parsed_command: 'python3 tidy_photos.py --folder invented-photos',
  copy: {
    headline: 'Run a command on this computer?',
    consequence: null,
    reason: 'Running commands always asks in this chat.',
  },
};

const noop = () => undefined;
const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

createRoot(rootElement).render(
  <SlotsProvider>
    <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '1rem', display: 'grid', gap: '1rem' }}>
      <section data-testid="kind-calendar">
        <PermissionApprovalCard
          approvalId="kind-calendar"
          card={calendarCard}
          othersWaiting={0}
          onApprove={noop}
          onDeny={noop}
        />
      </section>
      <section data-testid="kind-email">
        <EmailApprovalCard approvalId="kind-email" card={emailCard} onApprove={noop} onDeny={noop} />
      </section>
      <section data-testid="kind-file">
        <PermissionApprovalCard
          approvalId="kind-file"
          card={fileCard}
          othersWaiting={0}
          onApprove={noop}
          onDeny={noop}
        />
      </section>
      <section data-testid="kind-payment">
        <PermissionApprovalCard
          approvalId="kind-payment"
          card={paymentCard}
          othersWaiting={0}
          onApprove={noop}
          onDeny={noop}
        />
      </section>
      <section data-testid="kind-sandbox">
        <PermissionApprovalCard
          approvalId="kind-sandbox"
          card={sandboxCard}
          othersWaiting={0}
          onApprove={noop}
          onDeny={noop}
        />
      </section>
    </main>
  </SlotsProvider>,
);
