import {
  EmailApprovalCard,
  HeldActionCard,
  PermissionApprovalCard,
  ThemeProvider,
  type SentinelApprovalCard,
} from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

/** Every approval card kind stacked in one column, so their choice rows can be compared. Every value is invented. */
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

const searchCard: SentinelApprovalCard = {
  ...blank,
  plain_what: 'Search the web',
  destination_host: 'search.example.test',
  copy: {
    headline: 'Search the web for "harbour picnic spots"?',
    consequence: null,
    reason: 'Searches are set to ask, so Aman is checking with you first.',
  },
};

const calendarCard: SentinelApprovalCard = {
  ...blank,
  plain_what: 'Add Harbour picnic to your calendar',
  calendar_event: {
    action: 'create',
    calendar: 'me@example.test',
    title: 'Harbour picnic',
    when: 'Saturday 11:00',
    time_zone: 'Europe/London',
    duration: '2 hours',
    location: 'North pier',
    description: 'Bring the blue blanket.',
    attendees: ['robin@example.test'],
    guests_emailed: true,
    one_of_repeating: false,
    before: null,
  },
  copy: {
    headline: 'Add "Harbour picnic" to your calendar?',
    consequence: 'Robin Ellis will get an invitation by email.',
    reason: 'Events with guests always ask.',
  },
  safe_choice: true,
};

const mail = {
  action: 'send' as const,
  to: [{ name: 'Robin Ellis', address: 'robin@example.test' }],
  cc: [],
  bcc: [],
  subject: 'Picnic plans',
  body: 'Saturday still works for us.\n\nBest,\nAda',
  check_code: 'A7F39C',
  replaces: null,
  reply_in_thread: null,
  reply_to: null,
};

const emailCard: SentinelApprovalCard = {
  ...blank,
  plain_what: 'Send an email',
  email: mail,
  copy: {
    headline: 'Send this email to Robin Ellis?',
    consequence: "Once Robin Ellis has it, it can't be unsent.",
    reason: 'You approve every send in this chat.',
  },
  safe_choice: true,
  destructive: true,
};

const newRecipientCard: SentinelApprovalCard = {
  ...emailCard,
  plain_what: 'New recipient. Approving adds robin@example.test to your send list and sends.',
  mail_new_recipients: ['robin@example.test'],
};

const commandCard: SentinelApprovalCard = {
  ...blank,
  plain_what: 'Run a command',
  parsed_command: 'python3 tidy_photos.py --folder invented-photos',
  copy: {
    headline: 'Run a command on this computer?',
    consequence: null,
    reason: 'Running commands always asks in this chat.',
  },
};

const heldCard: SentinelApprovalCard = {
  ...blank,
  plain_what: 'Delete the note "Old packing list"',
  copy: {
    headline: 'Delete the note "Old packing list"?',
    consequence: "A deleted note can't be brought back.",
    reason: 'A scheduled run held this for you.',
  },
  safe_choice: true,
  destructive: true,
};

const skillNetworkCard: SentinelApprovalCard = {
  ...blank,
  plain_what: 'Let the Trail Weather skill reach api.weather.example.test?',
  plain_why: 'This skill names these sites as the ones it needs. It cannot reach any of them until you say yes.',
  copy: {
    headline: 'Let the Trail Weather skill reach api.weather.example.test?',
    consequence: null,
    reason: null,
  },
  skill_network: {
    skill_name: 'Trail Weather',
    hosts: ['api.weather.example.test'],
    reason: 'first_use',
    code_pin: null,
  },
};

const noop = () => undefined;
const mode = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light';
const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

createRoot(rootElement).render(
  <ThemeProvider theme={{ mode, brand: { mode: 'icon-title', name: 'Amanuensis' } }}>
    <main className="aman-chat-text mx-auto flex max-w-3xl flex-col gap-4 bg-primary-bg p-4">
      <section data-row-card="search">
        <PermissionApprovalCard
          approvalId="search"
          card={searchCard}
          othersWaiting={0}
          onApprove={noop}
          onApproveForChat={noop}
          onChangeRequest={noop}
          onDeny={noop}
        />
      </section>
      <section data-row-card="calendar">
        <PermissionApprovalCard
          approvalId="calendar"
          card={calendarCard}
          othersWaiting={0}
          onApprove={noop}
          onChangeRequest={noop}
          onDeny={noop}
        />
      </section>
      <section data-row-card="email">
        <EmailApprovalCard
          approvalId="email"
          card={emailCard}
          onApprove={noop}
          onDeny={noop}
          onChangeRequest={noop}
          onSaveDraft={noop}
        />
      </section>
      <section data-row-card="email-new-recipient">
        <EmailApprovalCard
          approvalId="email-new-recipient"
          card={newRecipientCard}
          onApprove={noop}
          onDeny={noop}
          onChangeRequest={noop}
          onSaveDraft={noop}
        />
      </section>
      <section data-row-card="command">
        <PermissionApprovalCard
          approvalId="command"
          card={commandCard}
          othersWaiting={2}
          batchSize={3}
          onApprove={noop}
          onApproveForChat={noop}
          onApproveAll={noop}
          onChangeRequest={noop}
          onDeny={noop}
        />
      </section>
      <ul data-row-card="held" className="m-0 p-0">
        <HeldActionCard
          card={heldCard}
          status={{ kind: 'waiting' }}
          alwaysAllowOffered
          onApprove={noop}
          onAlwaysAllow={noop}
          onChangeRequest={noop}
          onDeny={noop}
        />
      </ul>
      <ul data-row-card="skill-network" className="m-0 p-0">
        <HeldActionCard
          card={skillNetworkCard}
          status={{ kind: 'waiting' }}
          alwaysAllowOffered
          onApprove={noop}
          onAlwaysAllow={noop}
          onDeny={noop}
        />
      </ul>
    </main>
  </ThemeProvider>,
);
