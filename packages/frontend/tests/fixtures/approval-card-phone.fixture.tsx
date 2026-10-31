import { PermissionApprovalCard, SlotsProvider } from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

const noop = () => {};

// A held search with every choice a ticket card can show, the chat-wide one included.
createRoot(rootElement).render(
  <SlotsProvider theme={{ webFonts: false }}>
    <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '1rem', display: 'grid', gap: '1rem' }}>
      <section data-testid="ticket-card">
        <PermissionApprovalCard
          approvalId="approval-phone"
          card={{
            plain_what:
              'Web search: Find quiet coffee shops near the Ferry Building in San Francisco. Searches are set to ask, so Aman is checking with you first.',
            plain_why: null,
            cannot_be_undone: null,
            why_asked_again: null,
            destination: null,
            recipient: null,
            amount: null,
            parsed_command: null,
            outbound_text: 'query: "Find quiet coffee shops near the Ferry Building in San Francisco"',
            destination_host: 'Parallel',
            outbound_truncated: false,
            email: null,
            calendar_event: null,
            schedule: null,
            persona: null,
          }}
          othersWaiting={0}
          onApprove={noop}
          onApproveForChat={noop}
          onDeny={noop}
        />
      </section>
      <section data-testid="plain-card">
        {/* The generic ticket a waiting call shows before its server card arrives. Invented data only. */}
        <PermissionApprovalCard
          approvalId="approval-plain"
          card={{
            plain_what: 'Allow "draft email" on email-mcp?',
            plain_why: null,
            cannot_be_undone: null,
            why_asked_again: null,
            destination: null,
            recipient: null,
            amount: null,
            parsed_command: null,
            outbound_text: 'to: robin@example.test\nsubject: Picnic plans\nbody: Bring the blue blanket.',
            destination_host: null,
            outbound_truncated: false,
            email: null,
            calendar_event: null,
            schedule: null,
            persona: null,
          }}
          othersWaiting={0}
          onApprove={noop}
          onApproveForChat={noop}
          onDeny={noop}
          outboundOpen
        />
      </section>
    </main>
  </SlotsProvider>,
);
