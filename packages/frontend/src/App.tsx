import {
  AmanRuntimeRail,
  AmanSetupProvider,
  AmanWelcome,
  BugReportProvider,
  ComposerDraftScopeProvider,
  DEFAULT_AGENT_SPEC_SKILLS,
  getErrorMessage,
  ImplementationPlanGrantProvider,
  MemoryRecallProvider,
  PersonalizationProvider,
  PersonaProvider,
  ThemeProvider,
  TrueForgeUI,
  useTheme,
  VoiceInputProvider,
  type AmanAvatarActivity,
  type AmanAvatarMotionSources,
  type MemoryBankStatus,
  type SlotOverrides,
  type ThemeConfig,
} from '@truefoundry/trueforge-ui';
import {
  createTrueForgeClient,
  getCapabilities,
  getMemoryBankStatus,
  listModels,
  type BuildIdentity,
  type HarnessAgentSpec,
} from '@truefoundry/trueforge-ui/plugins/trueforge-agent-server-adapter';
import { useEffect, useMemo, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import { AuthErrorScreen } from './AuthErrorScreen';
import { createAuthAwareFetch } from './authFetch';
import { probeSession, type SessionState } from './authSession';
import { parseAuthErrorReason, shouldShowAuthErrorScreen, stripAuthErrorSearch } from './authStatusSearch';
import { createBugReportApi } from './bugReportApi';
import { createChatFolderStore } from './chatFolderStore';
import { GetStartedScreen } from './GetStartedScreen';
import { createImplementationPlanGrantApi } from './implementationPlanGrantApi';
import { LogoutButton } from './LogoutButton';
import { createMemoryRecallApi } from './memoryRecallApi';
import { createPersonaApi } from './personaApi';
import { createPersonalizationApi } from './personalizationApi';
import { API_BASE_URL, apiPath, uiRouterBasename } from './publicPath';
import { isSetupComplete, mergeSetupRead, SETUP_REFRESH_MS, type SetupSnapshot } from './setupStatus';
import { createSpaceStore } from './spaceStore';
import { createVoiceInputApi } from './voiceInputApi';

/** Shared cookie/OIDC fetch for boot helpers and `<TrueForgeUI server />`. */
const authAwareFetch = createAuthAwareFetch();
// UI + API share the public prefix from `window.__TRUEFORGE_BASE_PATH__`.
const bootClient = createTrueForgeClient({ baseUrl: API_BASE_URL, fetch: authAwareFetch });
const routerBasename = uiRouterBasename();
const chatFolders = createChatFolderStore(authAwareFetch);
const spaces = createSpaceStore(authAwareFetch);

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
const upgradeSandboxRuntime = async (providerId: string) => {
  await bootClient.settings.sandboxProviders.upgradeImage(providerId);
};

const AMAN_THEME: ThemeConfig = {
  defaultMode: 'light',
  brand: {
    mode: 'icon-title',
    name: 'Amanuensis',
  },
};

/** Host brand: primary CTA fill is a gradient (see `index.css`); keep solid token for accents. */
const appTheme: ThemeConfig = {
  className: 'harness-primary-gradient',
  tokens: {
    primaryButtonBg: '#6366F1',
    primaryButtonHover: '#3d2dd4',
  },
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
      /** Memory bank, null when off, undefined when the boot read failed. */
      memoryBank: MemoryBankStatus | null | undefined;
    };

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
  memoryBank,
  version,
  buildRef,
}: {
  defaultAgentSpec: HarnessAgentSpec;
  openSettings: boolean;
  displayName: string;
  overrides: SlotOverrides;
  modelName: string;
  memoryBank: MemoryBankStatus | null | undefined;
  version: string | undefined;
  buildRef: string | undefined;
}) {
  // Raw agent activity driving the living avatar in the runtime rail. The rail's motion
  // component applies the display policy (debounce, dwell, error auto-clear); this stays
  // the ground truth straight from the chat runtime.
  const [avatarActivity, setAvatarActivity] = useState<AmanAvatarActivity>('idle');
  return (
    <div className="aman-shell">
      <main className="aman-chat-surface">
        <TrueForgeUI
          server={{ type: 'trueforge', baseUrl: API_BASE_URL, fetch: authAwareFetch }}
          chatFolders={chatFolders}
          spaces={spaces}
          upgradeSandboxRuntime={upgradeSandboxRuntime}
          theme={AMAN_THEME}
          layout="sidebar"
          withRouter
          {...(routerBasename ? { routes: { basename: routerBasename } } : {})}
          agentConfig={{
            mode: 'AgentLibraryWithComposer',
            defaultAgentSpec,
          }}
          initialSettingsOpen={openSettings}
          currentUser={{ displayName }}
          onAgentActivity={setAvatarActivity}
          overrides={overrides}
          className="app-assistant"
        />
      </main>
      <AmanRuntimeRail
        modelName={modelName}
        userName={displayName}
        avatarSrc={apiPath('/aman-avatar.png')}
        avatarMotion={AMAN_AVATAR_MOTION_SOURCES}
        activity={avatarActivity}
        version={version}
        buildRef={buildRef}
        memoryBank={memoryBank}
        settingsHref="/settings"
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
        const [models, capabilities, memoryBank] = await Promise.all([
          listModels(bootClient),
          getCapabilities(bootClient),
          // Informational only: a failed read leaves memory unknown rather than failing boot.
          getMemoryBankStatus(bootClient).catch((): undefined => undefined),
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
            memoryBank,
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
          memoryBank,
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
      ? { modelName: boot.defaultAgentSpec.model.name || null, memoryBank: boot.memoryBank }
      : null);
  const setupComplete = setup !== null && isSetupComplete(setup);
  useEffect(() => {
    if (boot.status !== 'ready') {
      return;
    }
    // Before the first re-read lands, the boot snapshot is what the screen shows; merge over it.
    const bootSnapshot: SetupSnapshot = {
      modelName: boot.defaultAgentSpec.model.name || null,
      memoryBank: boot.memoryBank,
    };
    const state = { cancelled: false };
    const refresh = async () => {
      const [models, memoryBank] = await Promise.all([
        listModels(bootClient).catch((): undefined => undefined),
        getMemoryBankStatus(bootClient).catch((): undefined => undefined),
      ]);
      if (state.cancelled) {
        return;
      }
      setSetupRead(previous =>
        mergeSetupRead(previous ?? bootSnapshot, {
          modelName: models === undefined ? undefined : (models[0]?.name ?? null),
          memoryBank,
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
  const personalizationApi = useMemo(() => createPersonalizationApi(authAwareFetch), []);
  const personaApi = useMemo(() => createPersonaApi(authAwareFetch), []);
  const implementationPlanGrantApi = useMemo(() => createImplementationPlanGrantApi(authAwareFetch), []);
  const bugReportApi = useMemo(() => createBugReportApi(authAwareFetch), []);
  const voiceInputApi = useMemo(() => createVoiceInputApi(authAwareFetch), []);
  const memoryRecallApi = useMemo(() => createMemoryRecallApi(bootClient), []);

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
        <PersonalizationProvider api={personalizationApi}>
          <ImplementationPlanGrantProvider api={implementationPlanGrantApi}>
            <BugReportProvider api={bugReportApi}>
              <VoiceInputProvider api={voiceInputApi}>
                <MemoryRecallProvider api={memoryRecallApi}>
                  <PersonaProvider api={personaApi}>
                    <AmanSetupProvider
                      value={{
                        modelName: setup?.modelName ?? (boot.defaultAgentSpec.model.name || null),
                        memoryBank: setup === null ? boot.memoryBank : setup.memoryBank,
                        settingsHref: '/settings',
                      }}
                    >
                      <ComposerDraftScopeProvider scope={draftScope}>
                        <AmanShell
                          defaultAgentSpec={boot.defaultAgentSpec}
                          openSettings={boot.openSettings}
                          displayName={session.displayName}
                          overrides={overrides}
                          modelName={setup?.modelName ?? (boot.defaultAgentSpec.model.name || 'Choose a model')}
                          memoryBank={setup === null ? boot.memoryBank : setup.memoryBank}
                          version={boot.build?.version}
                          buildRef={boot.build?.ref}
                        />
                      </ComposerDraftScopeProvider>
                    </AmanSetupProvider>
                  </PersonaProvider>
                </MemoryRecallProvider>
              </VoiceInputProvider>
            </BugReportProvider>
          </ImplementationPlanGrantProvider>
        </PersonalizationProvider>
      </ThemeProvider>
    </div>
  );
}
