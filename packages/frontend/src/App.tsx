import {
  AmanPandaSourceProvider,
  AmanRuntimeRail,
  AmanSetupProvider,
  AmanWelcome,
  BugReportProvider,
  ComposerDraftScopeProvider,
  DEFAULT_AGENT_SPEC_SKILLS,
  getErrorMessage,
  HelpProvider,
  ImplementationPlanGrantProvider,
  MemoryRecallProvider,
  ModelUsageProvider,
  PersonalizationProvider,
  PersonaProvider,
  RepositoryWorkProvider,
  RunCodeStatusProvider,
  SentinelApiProvider,
  SentinelAuditFeed,
  ThemeProvider,
  TrueForgeUI,
  useTheme,
  VoiceInputProvider,
  type AgentConfig,
  type AmanAvatarActivity,
  type AmanAvatarMotionSources,
  type CurrentUser,
  type FirstRunGuideState,
  type RoutesConfig,
  type SlotOverrides,
  type ThemeConfig,
  type TrueForgeServerConfig,
} from '@truefoundry/trueforge-ui';
import {
  createTrueForgeClient,
  getCapabilities,
  listModels,
  type BuildIdentity,
  type HarnessAgentSpec,
} from '@truefoundry/trueforge-ui/plugins/trueforge-agent-server-adapter';
import { memo, useEffect, useMemo, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import { AuthErrorScreen } from './AuthErrorScreen';
import { createAuthAwareFetch } from './authFetch';
import { probeSession, type SessionState } from './authSession';
import { parseAuthErrorReason, shouldShowAuthErrorScreen, stripAuthErrorSearch } from './authStatusSearch';
import { createBugReportApi } from './bugReportApi';
import { createChatFolderStore } from './chatFolderStore';
import { createFirstRunGuideApi } from './firstRunGuideApi';
import { GetStartedScreen } from './GetStartedScreen';
import { createHelpApi } from './helpApi';
import { createImplementationPlanGrantApi } from './implementationPlanGrantApi';
import { LogoutButton } from './LogoutButton';
import { createMemoryRecallApi } from './memoryRecallApi';
import { createModelUsageApi } from './modelUsageApi';
import { createPersonaApi } from './personaApi';
import { createPersonalizationApi } from './personalizationApi';
import { API_BASE_URL, apiPath, uiRouterBasename } from './publicPath';
import { createRepositoryWorkApi } from './repositoryWorkApi';
import { createRunCodeStatusApi } from './runCodeStatusApi';
import { createSentinelApi, readAllSessionEvents } from './sentinelApi';
import { isSetupComplete, mergeSetupRead, SETUP_REFRESH_MS, type SetupSnapshot } from './setupStatus';
import { createSpaceStore } from './spaceStore';
import { TRUST_PAGE_URL } from './trustPageUrl';
import { createVoiceInputApi } from './voiceInputApi';

/** Shared cookie/OIDC fetch for boot helpers and `<TrueForgeUI server />`. */
const authAwareFetch = createAuthAwareFetch();
// UI + API share the public prefix from `window.__TRUEFORGE_BASE_PATH__`.
const bootClient = createTrueForgeClient({ baseUrl: API_BASE_URL, fetch: authAwareFetch });
const routerBasename = uiRouterBasename();
const chatFolders = createChatFolderStore(authAwareFetch);
const spaces = createSpaceStore(authAwareFetch);
const SERVER_CONFIG: TrueForgeServerConfig = { type: 'trueforge', baseUrl: API_BASE_URL, fetch: authAwareFetch };
const firstRunGuideApi = createFirstRunGuideApi(authAwareFetch);

/** Whether this owner has at least one chat; one page of one is enough to know. */
async function hasAnyChat(): Promise<boolean> {
  const page = await bootClient.sessions.list({ limit: 1 });
  return page.data.length > 0;
}
const ROUTES: RoutesConfig | undefined = routerBasename ? { basename: routerBasename } : undefined;

/**
 * Living-avatar clip sources, resolved through the public base path so subpath deploys
 * fetch them from the right prefix. Hoisted to module scope: the object identity is
 * stable, so the rail never re-renders just because the host did.
 */
const AMAN_AVATAR_MOTION_SOURCES: AmanAvatarMotionSources = {
  idle: [apiPath('/aman-avatar/idle-a.mp4'), apiPath('/aman-avatar/idle-b.mp4')],
  thinking: apiPath('/aman-avatar/thinking.mp4'),
  writing: apiPath('/aman-avatar/writing.mp4'),
  error: apiPath('/aman-avatar/error.mp4'),
  poster: apiPath('/aman-avatar/poster.jpg'),
};

/** The panda picture, shown by the rail and by the phone's first frame. */
const AMAN_PANDA_SRC = apiPath('/aman-avatar.png');

const AMAN_THEME: ThemeConfig = {
  defaultMode: 'light',
  webFonts: false,
  brand: {
    mode: 'icon-title',
    name: 'Amanuensis',
  },
};

/** Host look: the kit's warm paper and gold. No host colour overrides. */
const appTheme: ThemeConfig = {
  // The shell CSP keeps stylesheets and fonts on the app origin.
  webFonts: false,
};

function Loader() {
  const { mode } = useTheme();
  return (
    <div className="boot-screen" role="status" aria-label="Loading" aria-live="polite" aria-busy="true">
      <ThinkingOrb
        state="connecting"
        speed={1}
        theme={mode}
        paused={false}
        aria-hidden
        size={64}
        style={{ width: '4.5rem', height: '4.5rem' }}
      />
    </div>
  );
}

type BootState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      defaultAgentSpec: HarnessAgentSpec;
      openSettings: boolean;
      /** Undefined against a server that predates the build identity in its capabilities. */
      build: BuildIdentity | undefined;
      /** Whether a chat exists yet; undefined when the boot read failed. */
      hasChatted: boolean | undefined;
      /** Whether the owner has put the first-run checklist away; a failed read shows it. */
      firstRunGuideDismissed: boolean;
    };

/**
 * The chat itself. Memoized with props that stay stable across avatar activity flips, so the
 * activity it reports up to `AmanShell` re-renders only the runtime rail, not the chat tree.
 */
const AmanChatSurface = memo(function AmanChatSurface({
  defaultAgentSpec,
  openSettings,
  displayName,
  overrides,
  onAgentActivity,
  onActiveSessionChange,
  onPendingApprovalsChange,
}: {
  defaultAgentSpec: HarnessAgentSpec;
  openSettings: boolean;
  displayName: string;
  overrides: SlotOverrides;
  onAgentActivity: (activity: AmanAvatarActivity) => void;
  onActiveSessionChange: (sessionId: string | undefined) => void;
  onPendingApprovalsChange: (approvalIds: readonly string[]) => void;
}) {
  const agentConfig = useMemo(
    (): AgentConfig => ({ mode: 'AgentLibraryWithComposer', defaultAgentSpec }),
    [defaultAgentSpec],
  );
  const currentUser = useMemo((): CurrentUser => ({ displayName }), [displayName]);
  return (
    <main className="aman-chat-surface">
      <TrueForgeUI
        server={SERVER_CONFIG}
        chatFolders={chatFolders}
        spaces={spaces}
        theme={AMAN_THEME}
        layout="sidebar"
        withRouter
        {...(ROUTES ? { routes: ROUTES } : {})}
        agentConfig={agentConfig}
        initialSettingsOpen={openSettings}
        currentUser={currentUser}
        trustPageUrl={TRUST_PAGE_URL}
        onAgentActivity={onAgentActivity}
        onActiveSessionChange={onActiveSessionChange}
        onPendingApprovalsChange={onPendingApprovalsChange}
        overrides={overrides}
        className="app-assistant"
      />
    </main>
  );
});

/**
 * The authenticated chat surface + runtime rail. Owns the raw agent-activity state that
 * drives the living avatar — scoped here, not at the App root, so every activity
 * transition re-renders only this subtree instead of the whole app.
 */
function AmanShell({
  defaultAgentSpec,
  openSettings,
  displayName,
  overrides,
  modelName,
  version,
  buildRef,
}: {
  defaultAgentSpec: HarnessAgentSpec;
  openSettings: boolean;
  displayName: string;
  overrides: SlotOverrides;
  modelName: string;
  version: string | undefined;
  buildRef: string | undefined;
}) {
  // Raw agent activity driving the living avatar in the runtime rail. The rail's motion
  // component applies the display policy (debounce, dwell, error auto-clear); this stays
  // the ground truth straight from the chat runtime.
  const [avatarActivity, setAvatarActivity] = useState<AmanAvatarActivity>('idle');
  // Active session id, lifted out of the chat runtime so the right-rail permissions
  // feed can follow the session the user is looking at.
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  // Approvals waiting in the active chat, for the rail's waiting status and panda.
  const [pendingApprovalIds, setPendingApprovalIds] = useState<readonly string[]>([]);
  return (
    <div className="aman-shell">
      <AmanChatSurface
        defaultAgentSpec={defaultAgentSpec}
        openSettings={openSettings}
        displayName={displayName}
        overrides={overrides}
        onAgentActivity={setAvatarActivity}
        onActiveSessionChange={setActiveSessionId}
        onPendingApprovalsChange={setPendingApprovalIds}
      />
      <AmanRuntimeRail
        modelName={modelName}
        avatarSrc={AMAN_PANDA_SRC}
        avatarMotion={AMAN_AVATAR_MOTION_SOURCES}
        activity={avatarActivity}
        version={version}
        buildRef={buildRef}
        settingsHref="/settings"
        pendingApprovalIds={pendingApprovalIds}
        auditFeed={activeSessionId === undefined ? undefined : <SentinelAuditFeed sessionId={activeSessionId} />}
      />
    </div>
  );
}

export function App() {
  const authError = parseAuthErrorReason(window.location.search);
  const [session, setSession] = useState<SessionState | { status: 'checking' }>({ status: 'checking' });
  // Drafts in session storage are keyed by this, so a later sign-in in the same tab never sees them.
  const [draftScope, setDraftScope] = useState('');
  const [boot, setBoot] = useState<BootState>({ status: 'loading' });

  // Gate boot on a non-redirecting `/me` probe: unauthenticated users see the
  // welcome screen instead of being bounced to login by the auth-aware fetch.
  // Probe even when the URL has `?error=` — a replayed callback can leave that
  // query on a session that is still valid.
  useEffect(() => {
    const state = { cancelled: false };
    void probeSession().then(result => {
      if (!state.cancelled) {
        setSession(result.state);
        setDraftScope(result.subjectId ?? '');
      }
    });
    return () => {
      state.cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (session.status !== 'authenticated') {
      return;
    }
    if (parseAuthErrorReason(window.location.search) == null) {
      return;
    }
    window.history.replaceState(
      window.history.state,
      '',
      stripAuthErrorSearch({
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
      }),
    );
  }, [session]);

  useEffect(() => {
    if (session.status !== 'authenticated') {
      return;
    }
    const state = { cancelled: false };
    void (async () => {
      try {
        const [models, capabilities, hasChatted, firstRunGuideDismissed] = await Promise.all([
          listModels(bootClient),
          getCapabilities(bootClient),
          hasAnyChat().catch((): undefined => undefined),
          // A failed read shows the checklist: one extra look at it is the harmless side.
          firstRunGuideApi.getDismissed().catch((): boolean => false),
        ]);
        if (state.cancelled) {
          return;
        }
        const first = models[0];
        const sandboxConfig = { sandbox: { enabled: capabilities.sandbox.enabled } };
        const build = capabilities.build;
        if (first === undefined) {
          setBoot({
            status: 'ready',
            openSettings: true,
            build,
            hasChatted,
            firstRunGuideDismissed,
            defaultAgentSpec: {
              model: { name: '' },
              config: sandboxConfig,
              skills: [...DEFAULT_AGENT_SPEC_SKILLS],
            },
          });
          return;
        }
        const reasoningEfforts = first.properties.reasoningEfforts;
        // Default to the lowest real effort, not "none" — catalog lists are ordered ascending.
        const defaultReasoningEffort = reasoningEfforts?.find(effort => effort !== 'none') ?? reasoningEfforts?.[0];
        setBoot({
          status: 'ready',
          openSettings: false,
          build,
          hasChatted,
          firstRunGuideDismissed,
          defaultAgentSpec: {
            model: {
              name: first.name,
              ...(defaultReasoningEffort ? { params: { reasoningEffort: defaultReasoningEffort } } : {}),
            },
            config: sandboxConfig,
            skills: [...DEFAULT_AGENT_SPEC_SKILLS],
          },
        });
      } catch (err) {
        if (!state.cancelled) {
          setBoot({
            status: 'error',
            message: getErrorMessage(err, 'Failed to boot'),
          });
        }
      }
    })();
    return () => {
      state.cancelled = true;
    };
  }, [session]);

  const overrides: SlotOverrides = useMemo(
    () => ({ ShellActionsActionSlot: LogoutButton, WelcomeScreen: AmanWelcome }),
    [],
  );

  // Setup as the first screen shows it. Seeded from boot, then re-read whenever the window
  // regains focus and, while anything is still unset, every few seconds, so choosing a model or
  // connecting a bank in Settings shows up without a reload. The reads never fail the app: a failed
  // read keeps what was known.
  const [setupRead, setSetupRead] = useState<SetupSnapshot | null>(null);
  // Until the first re-read lands, the boot snapshot is the setup state; no effect needed to copy it.
  const setup: SetupSnapshot | null =
    setupRead ??
    (boot.status === 'ready'
      ? {
          modelName: boot.defaultAgentSpec.model.name || null,
          hasChatted: boot.hasChatted,
        }
      : null);
  const setupComplete = setup !== null && isSetupComplete(setup);
  useEffect(() => {
    if (boot.status !== 'ready') {
      return;
    }
    // Before the first re-read lands, the boot snapshot is what the screen shows; merge over it.
    const bootSnapshot: SetupSnapshot = {
      modelName: boot.defaultAgentSpec.model.name || null,
      hasChatted: boot.hasChatted,
    };
    const state = { cancelled: false };
    const refresh = async () => {
      const [models, hasChatted] = await Promise.all([
        listModels(bootClient).catch((): undefined => undefined),
        hasAnyChat().catch((): undefined => undefined),
      ]);
      if (state.cancelled) {
        return;
      }
      setSetupRead(previous =>
        mergeSetupRead(previous ?? bootSnapshot, {
          modelName: models === undefined ? undefined : (models[0]?.name ?? null),
          hasChatted,
        }),
      );
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const interval = setupComplete ? undefined : window.setInterval(() => void refresh(), SETUP_REFRESH_MS);
    return () => {
      state.cancelled = true;
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      if (interval !== undefined) {
        window.clearInterval(interval);
      }
    };
  }, [boot, setupComplete]);
  // The checklist's dismissal lives on the server so it follows the owner to every browser. The
  // card hides at once; a failed write brings it back, since nothing was remembered.
  const [guideDismissedLocally, setGuideDismissedLocally] = useState<boolean | undefined>(undefined);
  const firstRunGuide = useMemo(
    (): FirstRunGuideState => ({
      dismissed: guideDismissedLocally ?? (boot.status === 'ready' && boot.firstRunGuideDismissed),
      dismiss: () => {
        setGuideDismissedLocally(true);
        void firstRunGuideApi.setDismissed(true).catch(() => {
          setGuideDismissedLocally(false);
        });
      },
    }),
    [guideDismissedLocally, boot],
  );
  const personalizationApi = useMemo(() => createPersonalizationApi(authAwareFetch), []);
  const personaApi = useMemo(() => createPersonaApi(authAwareFetch), []);
  const helpApi = useMemo(
    () => createHelpApi({ fetcher: authAwareFetch, listPersonas: () => personaApi.listPersonas() }),
    [personaApi],
  );
  const implementationPlanGrantApi = useMemo(() => createImplementationPlanGrantApi(authAwareFetch), []);
  const repositoryWorkApi = useMemo(() => createRepositoryWorkApi(authAwareFetch), []);
  const bugReportApi = useMemo(() => createBugReportApi(authAwareFetch), []);
  const runCodeStatusApi = useMemo(() => createRunCodeStatusApi(authAwareFetch), []);
  const voiceInputApi = useMemo(() => createVoiceInputApi(authAwareFetch), []);
  const memoryRecallApi = useMemo(() => createMemoryRecallApi(bootClient), []);
  const modelUsageApi = useMemo(() => createModelUsageApi(bootClient), []);
  // Raw persisted session events for Sentinel's durable read (approval cards and Tier 2
  // notices rebuilt after a reload). Paginates the whole event history; the parser in
  // trueforge-ui drops everything that is not a Sentinel event.
  const sentinelApi = useMemo(
    () =>
      createSentinelApi({
        fetcher: authAwareFetch,
        listSessionEvents: sessionId =>
          readAllSessionEvents(async input => {
            const page = await bootClient.sessions.listEvents(sessionId, input);
            return { data: page.data, nextPageToken: page.response.pagination.nextPageToken };
          }),
      }),
    [],
  );

  const authErrorReason = shouldShowAuthErrorScreen({ authError, session });
  if (authErrorReason != null) {
    return (
      <ThemeProvider theme={appTheme}>
        <AuthErrorScreen reason={authErrorReason} />
      </ThemeProvider>
    );
  }

  if (session.status === 'checking') {
    return (
      <ThemeProvider theme={appTheme}>
        <Loader />
      </ThemeProvider>
    );
  }

  if (session.status === 'unauthenticated') {
    return (
      <ThemeProvider theme={appTheme}>
        <GetStartedScreen />
      </ThemeProvider>
    );
  }

  if (boot.status === 'error') {
    return (
      <ThemeProvider theme={appTheme}>
        <div className="boot-screen" data-error="true">
          Failed to load application configuration: {boot.message}
        </div>
      </ThemeProvider>
    );
  }

  if (boot.status === 'loading') {
    return (
      <ThemeProvider theme={appTheme}>
        <Loader />
      </ThemeProvider>
    );
  }

  return (
    <div className="app-root">
      <ThemeProvider theme={AMAN_THEME}>
        <SentinelApiProvider api={sentinelApi}>
          <PersonalizationProvider api={personalizationApi}>
            <ImplementationPlanGrantProvider api={implementationPlanGrantApi}>
              <RepositoryWorkProvider api={repositoryWorkApi}>
                <BugReportProvider api={bugReportApi}>
                  <VoiceInputProvider api={voiceInputApi}>
                    <RunCodeStatusProvider api={runCodeStatusApi}>
                      <MemoryRecallProvider api={memoryRecallApi}>
                        <ModelUsageProvider api={modelUsageApi}>
                          <PersonaProvider api={personaApi}>
                            <HelpProvider api={helpApi}>
                              <AmanSetupProvider
                                value={{
                                  modelName: setup?.modelName ?? (boot.defaultAgentSpec.model.name || null),
                                  hasChatted: setup === null ? boot.hasChatted : setup.hasChatted,
                                  firstRunGuide,
                                  settingsHref: '/settings',
                                }}
                              >
                                <ComposerDraftScopeProvider scope={draftScope}>
                                  <AmanPandaSourceProvider src={AMAN_PANDA_SRC}>
                                    <AmanShell
                                      defaultAgentSpec={boot.defaultAgentSpec}
                                      openSettings={boot.openSettings}
                                      displayName={session.displayName}
                                      overrides={overrides}
                                      modelName={
                                        setup?.modelName ?? (boot.defaultAgentSpec.model.name || 'Choose a model')
                                      }
                                      version={boot.build?.version}
                                      buildRef={boot.build?.ref}
                                    />
                                  </AmanPandaSourceProvider>
                                </ComposerDraftScopeProvider>
                              </AmanSetupProvider>
                            </HelpProvider>
                          </PersonaProvider>
                        </ModelUsageProvider>
                      </MemoryRecallProvider>
                    </RunCodeStatusProvider>
                  </VoiceInputProvider>
                </BugReportProvider>
              </RepositoryWorkProvider>
            </ImplementationPlanGrantProvider>
          </PersonalizationProvider>
        </SentinelApiProvider>
      </ThemeProvider>
    </div>
  );
}
