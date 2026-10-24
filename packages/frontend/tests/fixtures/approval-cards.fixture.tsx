import {
  EmailApprovalCard,
  PermissionApprovalCard,
  ThemeProvider,
  type SentinelApprovalCard,
} from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

/** One approval card of every kind, for the type size checks. Every value is invented. */
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
};

const cards: { kind: string; card: SentinelApprovalCard }[] = [
  {
    kind: 'calendar',
    card: {
      ...blank,
      plain_what: 'Add Lunch with Ada to your calendar',
      calendar_event: {
        action: 'create',
        calendar: 'me@example.com',
        title: 'Lunch with Ada',
        when: 'Thursday 12:30',
        time_zone: 'Europe/London',
        duration: '1 hour',
        location: 'Corner cafe',
        description: 'Talk about the lease.',
        attendees: ['ada@example.com'],
        guests_emailed: true,
        one_of_repeating: false,
        before: null,
      },
    },
  },
  {
    kind: 'shell',
    card: { ...blank, plain_what: 'Run a command in the sandbox', parsed_command: 'pnpm test --filter web' },
  },
  {
    kind: 'space',
    card: {
      ...blank,
      plain_what: 'Change the Weekly plan space',
      outbound_text: 'Replace "Monday" with "Tuesday" in the Weekly plan.',
    },
  },
  {
    kind: 'connector',
    card: {
      ...blank,
      plain_what: 'This is a new tool from inert. Check what it will do before you allow it.',
      destination_host: '127.0.0.1:33425',
    },
  },
];

const emailCard: SentinelApprovalCard = {
  ...blank,
  plain_what: 'Send an email',
  email: {
    action: 'send',
    to: [{ name: 'Grace', address: 'grace@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Lease',
    body: 'Thursday works.\n\nBest,\nAda',
    replaces: null,
    reply_in_thread: null,
    reply_to: null,
  },
};

const noop = () => undefined;
const mode = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light';
const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

createRoot(rootElement).render(
  <ThemeProvider theme={{ mode, brand: { mode: 'icon-title', name: 'Amanuensis' } }}>
    <div className="aman-chat-text mx-auto flex max-w-3xl flex-col gap-4 bg-primary-bg p-4" data-fixture="chat">
      <p data-role="chat-line">Here is what I will do next.</p>
      <div data-card="email">
        <EmailApprovalCard approvalId="email" card={emailCard} onApprove={noop} onDeny={noop} />
      </div>
      {cards.map(({ kind, card }) => (
        <div key={kind} data-card={kind}>
          <PermissionApprovalCard approvalId={kind} card={card} othersWaiting={0} onApprove={noop} onDeny={noop} />
        </div>
      ))}
    </div>
  </ThemeProvider>,
);
