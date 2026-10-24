import {
  AmanRuntimeRail,
  SentinelApiProvider,
  SentinelAuditFeed,
  ThemeProvider,
  type SentinelApi,
  type SentinelAuditEntry,
} from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

/** The right panel with its folds full, for the font, link and picture checks. Every entry is invented. */
const ACTIONS = ['read_email', 'list_events', 'tavily_search', 'update_space', 'run_code', 'write_file', 'send_draft'];

const entries: SentinelAuditEntry[] = ACTIONS.map((action, index) => ({
  id: `entry-${String(index)}`,
  session_id: 'chat-1',
  created_at: `2026-10-23T10:0${String(index)}:00.000Z`,
  tier: 2,
  action_type: action,
  description: '',
  outcome: index % 2 === 0 ? 'ran' : 'approved',
}));

const settings = {
  offline_mode: false,
  tier2_auto_allow: [],
  search_without_asking: true,
  maps_without_asking: false,
  sandbox_without_asking: false,
};

const api: SentinelApi = {
  listAuditEntries: async () => entries,
  listUserAuditEntries: async () => ({ entries: [] }),
  getUserSettings: async () => settings,
  updateUserSettings: async () => settings,
  listSentinelSessionContext: async () => ({ approvals: [] }),
  listBriefItemCompletions: async () => [],
  markBriefItemDone: async () => undefined,
  unmarkBriefItemDone: async () => undefined,
};

const mode = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light';

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

createRoot(rootElement).render(
  <ThemeProvider theme={{ mode, brand: { mode: 'icon-title', name: 'Amanuensis' } }}>
    <SentinelApiProvider api={api}>
      <div className="flex min-h-screen justify-end bg-primary-bg" data-fixture="runtime-rail">
        <AmanRuntimeRail
          avatarSrc="/aman-avatar.png"
          status="ready"
          auditFeed={<SentinelAuditFeed sessionId="chat-1" />}
        />
      </div>
    </SentinelApiProvider>
  </ThemeProvider>,
);
