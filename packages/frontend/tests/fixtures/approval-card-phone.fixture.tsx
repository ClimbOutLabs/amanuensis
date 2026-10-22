import { PermissionApprovalCard, SlotsProvider, ToolApprovalBar } from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

const noop = () => {};

// A search held after the chat read private text: the one held search the server offers a chat-wide grant for.
createRoot(rootElement).render(
  <SlotsProvider theme={{ webFonts: false }}>
    <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '1rem', display: 'grid', gap: '1rem' }}>
      <section data-testid="ticket-card">
        <PermissionApprovalCard
          card={{
            plain_what:
              'Web search: Find quiet coffee shops near the Ferry Building in San Francisco. This chat has read your private data, so Aman is checking before searching.',
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
        <ToolApprovalBar
          toolName="web_search (parallel)"
          approveOptions={[
            { id: 'allow-once', label: 'Approve', variant: 'primary' },
            { id: 'allow-chat', label: 'Approve for this chat', variant: 'secondary' },
          ]}
          denyOptions={[{ id: 'deny', label: 'Deny', variant: 'secondary', requiresReason: true }]}
          onSelect={noop}
        />
      </section>
    </main>
  </SlotsProvider>,
);
