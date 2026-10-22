import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AmanRuntimeRail } from '@/components/AmanRuntimeRail.js';
import { PersonalizationProvider } from '@/components/PersonalizationContext.js';
import { CurrentUserProvider } from '@/contexts/CurrentUserContext.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import type { SentinelApi, SentinelAuditEntry, SentinelUserSettings } from '@/sentinel/types.js';

import { RuntimeHarness } from '../containers/RuntimeHarness.js';

const fetchMock = vi.fn();

// Walks up from wherever the runner started, so the stylesheet is found whether vitest
// runs in the package or at the monorepo root. import.meta.url is not a file URL here.
const findStylesheet = (): string => {
  let dir = process.cwd();
  for (;;) {
    for (const relative of ['src/styles.css', 'packages/trueforge-ui/src/styles.css']) {
      const candidate = resolve(dir, relative);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not locate trueforge-ui src/styles.css');
    dir = parent;
  }
};

describe('AmanRuntimeRail', () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockReset();
    // The probe stays in flight unless a test overrides the mock, so sync tests
    // never see a post-assertion status flip.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the assistant name, the shared Aman fallback, and the role line', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail avatarSrc="/aman-avatar.png" modelName="local-model" />
      </RuntimeHarness>,
    );

    expect(screen.getByRole('complementary', { name: 'Amanuensis runtime status' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Aman' })).toBeInTheDocument();
    expect(screen.getByText('Your Chief of Staff')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Aman, drawn as a panda writing with a quill' })).toHaveAttribute(
      'src',
      '/aman-avatar.png',
    );
  });

  it('collapses and expands the rail from its toggle, and remembers the choice', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail modelName="local-model" />
      </RuntimeHarness>,
    );

    const collapse = screen.getByRole('button', { name: 'Collapse rail' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('complementary', { name: 'Amanuensis runtime status' })).not.toHaveClass(
      'aman-runtime-rail--collapsed',
    );

    fireEvent.click(collapse);

    const expand = screen.getByRole('button', { name: 'Expand rail' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('complementary', { name: 'Amanuensis runtime status' })).toHaveClass(
      'aman-runtime-rail--collapsed',
    );
    expect(screen.queryByText('local-model')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('aui-runtime-rail-collapsed')).toBe('true');

    fireEvent.click(expand);

    expect(screen.getByRole('button', { name: 'Collapse rail' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('local-model')).toBeInTheDocument();
    expect(window.localStorage.getItem('aui-runtime-rail-collapsed')).toBe('false');
  });

  it('keeps offline mode visible when the rail is collapsed', async () => {
    window.localStorage.setItem('aui-runtime-rail-collapsed', 'true');
    const settings: SentinelUserSettings = {
      offline_mode: true,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    };
    const api: SentinelApi = {
      listAuditEntries: vi.fn(async () => []),
      listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
      getUserSettings: vi.fn(async () => settings),
      updateUserSettings: vi.fn(async () => settings),
      listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
    };
    render(
      <SentinelApiProvider api={api}>
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail modelName="local-model" />
        </RuntimeHarness>
      </SentinelApiProvider>,
    );

    expect(await screen.findByRole('status', { name: 'Offline mode is on' })).toBeInTheDocument();
  });

  it('keeps the model name out of the collapsed status dot', () => {
    window.localStorage.setItem('aui-runtime-rail-collapsed', 'true');
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail modelName="local-model" status="ready" />
      </RuntimeHarness>,
    );
    const dot = screen.getByRole('img', { name: 'Ready' });
    expect(dot).toHaveAttribute('title', 'Ready');
    expect(dot.getAttribute('aria-label')).not.toContain('local-model');
  });

  it('starts collapsed when the stored preference says so', () => {
    window.localStorage.setItem('aui-runtime-rail-collapsed', 'true');

    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail modelName="local-model" />
      </RuntimeHarness>,
    );

    expect(screen.getByRole('button', { name: 'Expand rail' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('complementary', { name: 'Amanuensis runtime status' })).toHaveClass(
      'aman-runtime-rail--collapsed',
    );
  });

  it('renders expanded when reading the stored preference throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    try {
      render(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail modelName="local-model" />
        </RuntimeHarness>,
      );

      expect(screen.getByRole('button', { name: 'Collapse rail' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('local-model')).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
    }
  });

  it('still collapses when writing the preference throws', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    try {
      render(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail modelName="local-model" />
        </RuntimeHarness>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Collapse rail' }));

      expect(screen.getByRole('button', { name: 'Expand rail' })).toHaveAttribute('aria-expanded', 'false');
    } finally {
      setItem.mockRestore();
    }
  });

  it('feathers the avatar edges without a container, motion, or a literal colour', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail avatarSrc="/aman-avatar.png" />
      </RuntimeHarness>,
    );
    const avatar = screen.getByRole('img', { name: 'Aman, drawn as a panda writing with a quill' });
    expect(avatar).toHaveClass('aman-runtime-rail__avatar');

    const stylesheet = readFileSync(findStylesheet(), 'utf8');
    const selector = '.aman-runtime-rail__avatar {';
    // Pinning the count keeps the slice below honest: a second block for the same selector
    // would let this read an earlier rule and pass on stale declarations.
    expect(stylesheet.split(selector)).toHaveLength(2);
    const rule = stylesheet.slice(stylesheet.indexOf(selector));
    const avatarRule = rule.slice(0, rule.indexOf('}') + 1);

    // The prefixed pair is asserted separately because WebKit ships only those, and an
    // unprefixed-only rule would leave Safari with the hard rectangle this change removes.
    expect(avatarRule).toMatch(/^\s{2}mask-image:/m);
    expect(avatarRule).toMatch(/^\s{2}mask-composite:/m);
    expect(avatarRule).toContain('-webkit-mask-image:');
    expect(avatarRule).toContain('-webkit-mask-composite:');
    // The rail background must show through the feather, so the rule names no colour of
    // its own beyond the mask alpha ramp, and stays static.
    expect(avatarRule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(avatarRule).not.toMatch(/animation|transition|transform/);
  });

  it('calls the build line a release, with a shortened reference', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail version="0.4.2" buildRef="4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90" />
      </RuntimeHarness>,
    );

    const value = screen.getByText('Release 0.4.2 · 4f2a91c');
    expect(value).toBeInTheDocument();
    expect(value).toHaveAttribute('title', 'Release 0.4.2 · 4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90');
    expect(screen.queryByText(/Session/)).not.toBeInTheDocument();
  });

  it('leaves a tag-shaped build reference whole in the release line', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail version="0.4.2" buildRef="v0.4.2-rc1" />
      </RuntimeHarness>,
    );

    expect(screen.getByText('Release 0.4.2 · v0.4.2-rc1')).toBeInTheDocument();
  });

  it('shows the version alone in the release line when the build carries no reference', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail version="0.4.2" />
      </RuntimeHarness>,
    );

    expect(screen.getByText('Release 0.4.2')).toBeInTheDocument();
  });

  it('leaves out the release line when the server reports no version', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail buildRef="4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90" />
      </RuntimeHarness>,
    );

    expect(screen.queryByText(/^Release /)).not.toBeInTheDocument();
  });

  it('uses the name the person gave in the role line, and never the login name', async () => {
    const { container } = render(
      <RuntimeHarness messages={[]}>
        <PersonalizationProvider
          api={{
            getProfile: async () => ({
              assistant_name: null,
              assistant_identity: null,
              voice_guidance: null,
              user_name: 'Maria',
              address_as: 'Mum',
              user_profile: null,
              pinned_preferences: [],
              help_areas: [],
              learned_profile: null,
            }),
            updateProfile: async profile => profile,
            deleteProfile: async () => {},
          }}
        >
          <AmanRuntimeRail modelName="local-model" />
        </PersonalizationProvider>
      </RuntimeHarness>,
    );

    expect(await screen.findByText("Mum's Chief of Staff")).toBeInTheDocument();
    expect(screen.queryByText('Maria')).not.toBeInTheDocument();
    expect(screen.queryByText('Markdown (local files)')).not.toBeInTheDocument();
    expect(container.querySelector('[data-section="account"]')).toBeNull();
  });

  it('renders an accessible fallback when no avatar is configured', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail status="offline" />
      </RuntimeHarness>,
    );

    expect(screen.getByRole('img', { name: 'Aman, drawn as a panda writing with a quill' })).toHaveTextContent('A');
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('shows the personalized name without exposing editing controls in the runtime rail', async () => {
    render(
      <RuntimeHarness messages={[]}>
        <PersonalizationProvider
          api={{
            getProfile: async () => ({
              assistant_name: 'Mira',
              assistant_identity: null,
              voice_guidance: null,
              user_name: null,
              address_as: null,
              user_profile: null,
              pinned_preferences: [],
              help_areas: [],
              learned_profile: null,
            }),
            updateProfile: async profile => profile,
            deleteProfile: async () => {},
          }}
        >
          <AmanRuntimeRail />
        </PersonalizationProvider>
      </RuntimeHarness>,
    );

    expect(await screen.findByRole('heading', { name: 'Mira' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Personalize assistant' })).not.toBeInTheDocument();
  });

  it('groups the rail into labeled answering and model sections', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail modelName="local-model" version="0.4.2" personaName="Mannie" />
      </RuntimeHarness>,
    );

    expect(screen.getByRole('heading', { name: 'Answering' })).toBeInTheDocument();
    // The model moved behind Details; the section heading is gone from the rail itself.
    expect(screen.queryByRole('heading', { name: 'Model' })).not.toBeInTheDocument();
    expect(screen.getByText('Mannie')).toBeInTheDocument();

    // Old labels must not reappear.
    expect(screen.queryByRole('heading', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Session' })).not.toBeInTheDocument();
  });

  it('shows the probe latency next to a ready status', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail />
      </RuntimeHarness>,
    );

    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(await screen.findByText(/\d+ ms/)).toBeInTheDocument();
  });

  it('lets an explicit status prop override the live probe', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail status="degraded" />
      </RuntimeHarness>,
    );

    // The probe would report ready, but the host's status wins and no probing happens.
    expect(screen.getByText('Degraded')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ ms/)).not.toBeInTheDocument();
  });

  it('shows a retry control when the live probe fails, and re-probes on retry', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail />
      </RuntimeHarness>,
    );

    const retry = await screen.findByRole('button', { name: /retry/i });
    expect(await screen.findByText('Offline')).toBeInTheDocument();

    fireEvent.click(retry);

    // The retry succeeds after a failure, so the rail reports degraded rather than ready.
    expect(await screen.findByText('Degraded')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders the avatar as a plain, static image with no animator wrapper classes', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail avatarSrc="/aman-avatar.png" />
      </RuntimeHarness>,
    );

    const avatar = screen.getByRole('img', { name: 'Aman, drawn as a panda writing with a quill' });
    expect(avatar.tagName).toBe('IMG');
    expect(avatar.className).not.toMatch(/mascot-animator/);
    expect(avatar.parentElement?.querySelector('.mascot-animator__container')).toBeNull();
    expect(avatar.parentElement?.querySelector('.mascot-animator__halo')).toBeNull();
  });
  describe('living avatar', () => {
    const motionSources = {
      idle: ['/aman-avatar/idle-a.mp4', '/aman-avatar/idle-b.mp4'],
      thinking: '/aman-avatar/thinking.mp4',
      writing: '/aman-avatar/writing.mp4',
      error: '/aman-avatar/error.mp4',
      poster: '/aman-avatar/poster.png',
    };

    const stubMatchMedia = (matches: boolean): void => {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });
    };

    beforeEach(() => {
      stubMatchMedia(false);
      vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
      vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
      vi.spyOn(window.HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
      vi.stubGlobal(
        'IntersectionObserver',
        // A plain function, not an arrow: the component constructs it with `new`.
        vi.fn(function () {
          return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('paints only the poster on an idle page, then plays clips once the agent acts', () => {
      const { rerender } = render(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail avatarSrc="/aman-avatar.png" avatarMotion={motionSources} />
        </RuntimeHarness>,
      );

      // Idle on arrival: the poster still, no video element, no clip bytes.
      expect(document.querySelectorAll('video')).toHaveLength(0);
      const still = screen.getByRole('img', { name: 'Aman, drawn as a panda writing with a quill' });
      expect(still.tagName).toBe('IMG');
      expect(still).toHaveAttribute('src', motionSources.poster);

      // First non-idle activity: the video mounts and takes over.
      rerender(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail avatarSrc="/aman-avatar.png" avatarMotion={motionSources} activity="thinking" />
        </RuntimeHarness>,
      );
      const avatar = screen.getByRole('img', { name: 'Aman, drawn as a panda writing with a quill' });
      expect(avatar.tagName).toBe('VIDEO');
      expect(avatar.getAttribute('src')).toBe(motionSources.thinking);
      expect(avatar).toHaveAttribute('poster', motionSources.poster);
    });

    it('plays the error clip the moment an error is reported', () => {
      render(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail avatarSrc="/aman-avatar.png" avatarMotion={motionSources} activity="error" />
        </RuntimeHarness>,
      );

      expect(screen.getByRole('img', { name: 'Aman, drawn as a panda writing with a quill' })).toHaveAttribute(
        'src',
        motionSources.error,
      );
    });

    it('keeps the static image when motion sources are absent, whatever the activity', () => {
      render(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail avatarSrc="/aman-avatar.png" activity="writing" />
        </RuntimeHarness>,
      );

      const avatar = screen.getByRole('img', { name: 'Aman, drawn as a panda writing with a quill' });
      expect(avatar.tagName).toBe('IMG');
      expect(avatar).toHaveAttribute('src', '/aman-avatar.png');
    });

    it('renders only the poster still when the user prefers reduced motion', () => {
      stubMatchMedia(true);
      render(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail avatarSrc="/aman-avatar.png" avatarMotion={motionSources} activity="writing" />
        </RuntimeHarness>,
      );

      const avatar = screen.getByRole('img', { name: 'Aman, drawn as a panda writing with a quill' });
      expect(avatar.tagName).toBe('IMG');
      expect(avatar).toHaveAttribute('src', motionSources.poster);
      expect(document.querySelectorAll('video')).toHaveLength(0);
    });

    it('still renders the accessible fallback when neither image nor motion is configured', () => {
      render(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail activity="thinking" />
        </RuntimeHarness>,
      );

      expect(screen.getByRole('img', { name: 'Aman, drawn as a panda writing with a quill' })).toHaveTextContent('A');
    });
  });
});

describe('AmanRuntimeRail folded sections, waiting status and Recent actions', () => {
  const settingsStub: SentinelUserSettings = {
    offline_mode: false,
    tier2_auto_allow: [],
    search_without_asking: true,
    maps_without_asking: false,
    sandbox_without_asking: false,
  };

  const motionSources = {
    idle: ['/aman-avatar/idle-a.mp4', '/aman-avatar/idle-b.mp4'],
    thinking: '/aman-avatar/thinking.mp4',
    writing: '/aman-avatar/writing.mp4',
    error: '/aman-avatar/error.mp4',
    poster: '/aman-avatar/poster.png',
  };

  function sentinelWith(
    settings: SentinelUserSettings,
    entries: SentinelAuditEntry[] = [],
    listAuditEntries: SentinelApi['listAuditEntries'] = vi.fn(async () => entries),
  ): SentinelApi {
    return {
      listAuditEntries,
      listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
      getUserSettings: vi.fn(async () => settings),
      updateUserSettings: vi.fn(async () => settings),
      listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
    };
  }

  function auditEntry(overrides: Partial<SentinelAuditEntry>): SentinelAuditEntry {
    return {
      id: 'entry',
      session_id: 'session-1',
      created_at: new Date().toISOString(),
      tier: 2,
      action_type: 'web_search',
      description: '',
      outcome: 'ran',
      ...overrides,
    };
  }

  const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

  /** A list of `count` rows one minute apart, newest first: they all belong to one reply. */
  function oneReply(count: number): SentinelAuditEntry[] {
    return Array.from({ length: count }, (_, index) =>
      auditEntry({ id: `row-${index}`, action_type: 'web_search', created_at: minutesAgo(index + 1) }),
    );
  }

  function renderRail({
    entries = [],
    settings = settingsStub,
    pendingApprovalIds,
    listAuditEntries,
  }: {
    entries?: SentinelAuditEntry[];
    settings?: SentinelUserSettings;
    pendingApprovalIds?: readonly string[];
    listAuditEntries?: SentinelApi['listAuditEntries'];
  } = {}) {
    return render(
      <SentinelApiProvider api={sentinelWith(settings, entries, listAuditEntries)}>
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail
            avatarSrc="/aman-avatar.png"
            pendingApprovalIds={pendingApprovalIds}
            recentActionsSessionId="session-1"
            settingsHref="/settings"
          />
        </RuntimeHarness>
      </SentinelApiProvider>,
    );
  }

  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'IntersectionObserver',
      // A plain function, not an arrow: the component constructs it with `new`.
      vi.fn(function () {
        return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
      }),
    );
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts every section folded, so the rail reads as a calm column', async () => {
    renderRail({ entries: oneReply(3) });

    expect(await screen.findByRole('button', { name: /^Recent actions/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /^Rules/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /^Memory/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Web searches run without asking')).not.toBeInTheDocument();
    expect(screen.queryByText('Memory is kept in Settings.')).not.toBeInTheDocument();
  });

  it('puts the panda first, then the status line, then Rules, Memory and Recent actions', async () => {
    const { container } = renderRail({ entries: oneReply(1) });
    await screen.findByRole('button', { name: /^Recent actions/ });

    const order = Array.from(container.querySelectorAll('[data-section]')).map(node =>
      node.getAttribute('data-section'),
    );
    expect(order).toEqual(['panda', 'rules', 'memory', 'recent-actions']);
    expect(container.querySelector('[data-section="needs-you"]')).toBeNull();
  });

  it('shows the count and the latest action on the folded Recent actions header', async () => {
    const entries = Array.from({ length: 9 }, (_, index) =>
      index === 0
        ? auditEntry({ id: 'latest', action_type: 'gmail_read', outcome: 'ran', created_at: minutesAgo(2) })
        : auditEntry({ id: `older-${index}`, action_type: 'web_search', created_at: minutesAgo(index + 3) }),
    );
    renderRail({ entries });

    expect(await screen.findByText('· 9')).toBeInTheDocument();
    expect(screen.getByText('Last: Gmail · read email · 2m ago')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Recent actions/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the warning dot only while an entry failed, and never opens the section for it', async () => {
    renderRail({
      entries: [auditEntry({ id: 'blocked', action_type: 'exec', outcome: 'auto_denied', tier: 3 })],
    });
    expect(await screen.findByRole('img', { name: 'A recent action failed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Recent actions/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows no warning dot when every entry succeeded', async () => {
    renderRail({ entries: oneReply(2) });
    await screen.findByText('· 2');
    expect(screen.queryByRole('img', { name: 'A recent action failed' })).not.toBeInTheDocument();
  });

  it('expands to replies, newest first: This reply, then an earlier day', async () => {
    renderRail({
      entries: [
        auditEntry({ id: 'now-1', action_type: 'gmail_read', created_at: minutesAgo(1) }),
        auditEntry({ id: 'now-2', action_type: 'web_search', created_at: minutesAgo(3) }),
        auditEntry({ id: 'older', action_type: 'exec', created_at: minutesAgo(2 * 24 * 60 + 5) }),
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Recent actions/ }));

    const labels = screen.getAllByText(/^(This reply|Earlier today|Yesterday|Earlier)$/).map(node => node.textContent);
    expect(labels).toEqual(['This reply', 'Earlier']);
    const replyRows = screen.getAllByRole('listitem');
    expect(replyRows).toHaveLength(3);
    expect(replyRows[0]).toHaveTextContent('Gmail · read email');
  });

  it('shows the four newest rows, then Show all N in the accent, and folds back again', async () => {
    const { container } = renderRail({ entries: oneReply(9) });
    fireEvent.click(await screen.findByRole('button', { name: /^Recent actions/ }));

    expect(container.querySelectorAll('.aman-runtime-rail__row')).toHaveLength(4);
    const showAll = screen.getByRole('button', { name: 'Show all 9' });
    expect(showAll).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(showAll);
    expect(container.querySelectorAll('.aman-runtime-rail__row')).toHaveLength(9);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(container.querySelectorAll('.aman-runtime-rail__row')).toHaveLength(4);
  });

  it('names the real service and gives one of the five subtitles on each row, never connected app', async () => {
    const { container } = renderRail({
      entries: [
        auditEntry({ id: 'a', action_type: 'gmail_read', outcome: 'ran' }),
        auditEntry({ id: 'b', action_type: 'web_search', outcome: 'approved', tier: 3 }),
        auditEntry({ id: 'c', action_type: 'calendar_write', outcome: 'denied', tier: 3 }),
        auditEntry({ id: 'd', action_type: 'exec', outcome: 'logged', tier: 2 }),
        auditEntry({ id: 'e', action_type: 'exec', outcome: 'auto_denied', tier: 3 }),
        auditEntry({ id: 'f', action_type: 'some_new_tool', outcome: 'ran' }),
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Recent actions/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Show all 6' }));

    const rows = Array.from(container.querySelectorAll('.aman-runtime-rail__row'));
    const read = rows.map(row => ({
      title: row.querySelector('.aman-runtime-rail__row-title')?.textContent,
      subtitle: row.querySelector('.aman-runtime-rail__row-subtitle')?.textContent,
      mark: row.querySelector('.aman-runtime-rail__mark')?.textContent,
    }));
    expect(read).toEqual([
      { title: 'Gmail · read email', subtitle: 'Done · allowed by your settings', mark: '✓' },
      { title: 'Web search · searched the web', subtitle: 'You approved', mark: '✓' },
      { title: 'Calendar · changed an event', subtitle: 'You declined', mark: '–' },
      { title: 'Sandbox · ran a command', subtitle: 'Waiting for you', mark: '·' },
      { title: 'Sandbox · ran a command', subtitle: 'Failed: blocked by your settings', mark: '!' },
      { title: 'Some new tool', subtitle: 'Done · allowed by your settings', mark: '✓' },
    ]);
    expect(container.textContent).not.toContain('connected app');
  });

  it('makes each row one keyboard stop', async () => {
    const { container } = renderRail({ entries: oneReply(2) });
    fireEvent.click(await screen.findByRole('button', { name: /^Recent actions/ }));
    for (const row of Array.from(container.querySelectorAll('.aman-runtime-rail__row'))) {
      expect(row).toHaveAttribute('tabindex', '0');
    }
  });

  it('remembers which sections were left open, across a fresh mount in this browser', async () => {
    const first = renderRail({ entries: oneReply(1) });
    fireEvent.click(await screen.findByRole('button', { name: /^Rules/ }));
    expect(screen.getByRole('button', { name: /^Rules/ })).toHaveAttribute('aria-expanded', 'true');
    expect(JSON.parse(window.localStorage.getItem('aui-runtime-rail-folds') ?? '{}')).toMatchObject({ rules: true });
    first.unmount();

    renderRail({ entries: oneReply(1) });
    expect(await screen.findByRole('button', { name: /^Rules/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /^Memory/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Web searches run without asking')).toBeInTheDocument();
  });

  it('starts folded when the stored fold state is unreadable, and still toggles when saving throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderRail({ entries: oneReply(1) });

    const rules = await screen.findByRole('button', { name: /^Rules/ });
    expect(rules).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(rules);
    expect(rules).toHaveAttribute('aria-expanded', 'true');
  });

  it('says what went wrong with a plain line and a retry, when the list cannot load', async () => {
    const listAuditEntries = vi.fn(async () => {
      throw new Error('Connection lost');
    });
    renderRail({ listAuditEntries });
    fireEvent.click(await screen.findByRole('button', { name: /^Recent actions/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load recent actions: Connection lost');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listAuditEntries).toHaveBeenCalledTimes(2));
  });

  it('says nothing has happened yet when the chat has no rows', async () => {
    renderRail({ entries: [] });
    fireEvent.click(await screen.findByRole('button', { name: /^Recent actions/ }));
    expect(screen.getByText('Nothing has happened in this chat yet.')).toBeInTheDocument();
  });

  it('leaves Recent actions out when the rail has no chat to read', () => {
    const { container } = render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail avatarSrc="/aman-avatar.png" />
      </RuntimeHarness>,
    );
    expect(container.querySelector('[data-section="recent-actions"]')).toBeNull();
  });

  it('reads the three rules in plain words from the saved settings, once Rules is opened', async () => {
    renderRail({ settings: { ...settingsStub, offline_mode: true } });
    fireEvent.click(await screen.findByRole('button', { name: /^Rules/ }));
    expect(screen.getByText('Web searches run without asking')).toBeInTheDocument();
    expect(screen.getByText('Sandbox code asks first')).toBeInTheDocument();
    expect(screen.getByText('Offline mode is on')).toBeInTheDocument();
    // Read-only: the rules offer no switch.
    expect(screen.queryByRole('switch', { name: /offline/i })).not.toBeInTheDocument();
  });

  it('keeps the memory pointer in Settings, behind its own fold', async () => {
    renderRail({ entries: oneReply(1) });
    fireEvent.click(await screen.findByRole('button', { name: /^Memory/ }));
    expect(screen.getByText('Memory is kept in Settings.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings');
  });

  it('shows Needs you nowhere: an approval waiting shows as the status line instead', async () => {
    const { container } = renderRail({ pendingApprovalIds: ['approval-1', 'approval-2'], entries: oneReply(1) });
    await screen.findByRole('button', { name: /^Recent actions/ });
    expect(screen.queryByText(/Needs you/)).not.toBeInTheDocument();
    expect(container.querySelectorAll('.aui-ticket--selected')).toHaveLength(0);
  });

  it('says Waiting on your approval with a gold dot, and the panda plays its writing clip', () => {
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(window.HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const { container, rerender } = render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail status="ready" avatarMotion={motionSources} activity="idle" />
      </RuntimeHarness>,
    );
    expect(container.querySelector('.aman-runtime-rail__status')).toHaveTextContent('Ready');
    expect(container.querySelector('.aman-runtime-rail__status')).not.toHaveAttribute('data-waiting');

    rerender(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail
          status="ready"
          avatarMotion={motionSources}
          activity="idle"
          pendingApprovalIds={['approval-1']}
        />
      </RuntimeHarness>,
    );
    const status = container.querySelector('.aman-runtime-rail__status');
    expect(status).toHaveTextContent('Waiting on your approval');
    expect(status).toHaveAttribute('data-waiting', 'true');
    expect(screen.getByRole('img', { name: 'Aman, drawn as a panda writing with a quill' })).toHaveAttribute(
      'src',
      motionSources.writing,
    );
  });

  it('keeps a broken connection on the status line even while an approval waits', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail status="offline" pendingApprovalIds={['approval-1']} />
      </RuntimeHarness>,
    );
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.queryByText('Waiting on your approval')).not.toBeInTheDocument();
  });

  it('keeps the status line polite for screen readers and says what Aman is doing', () => {
    const { container, rerender } = render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail status="ready" activity="thinking" />
      </RuntimeHarness>,
    );
    const status = container.querySelector('.aman-runtime-rail__status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Working on it…');

    rerender(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail status="ready" activity="idle" />
      </RuntimeHarness>,
    );
    expect(container.querySelector('.aman-runtime-rail__status')).toHaveTextContent('Ready');
  });

  it('uses the assistant name the person set, and the role line never says owner', async () => {
    render(
      <PersonalizationProvider
        api={{
          getProfile: async () => ({
            assistant_name: 'Pip',
            assistant_identity: null,
            voice_guidance: null,
            user_name: null,
            address_as: null,
            user_profile: null,
            pinned_preferences: [],
            help_areas: [],
            learned_profile: null,
          }),
          updateProfile: async profile => profile,
          deleteProfile: async () => {},
        }}
      >
        <CurrentUserProvider currentUser={{ displayName: 'owner' }}>
          <RuntimeHarness messages={[]}>
            <AmanRuntimeRail />
          </RuntimeHarness>
        </CurrentUserProvider>
      </PersonalizationProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Pip' })).toBeInTheDocument();
    expect(screen.getByText('Your Chief of Staff')).toBeInTheDocument();
    expect(screen.queryByText(/owner/i)).not.toBeInTheDocument();
  });

  it('uses the sign-in name in the role line when no name was given', () => {
    render(
      <CurrentUserProvider currentUser={{ displayName: 'Sam' }}>
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail />
        </RuntimeHarness>
      </CurrentUserProvider>,
    );
    expect(screen.getByText("Sam's Chief of Staff")).toBeInTheDocument();
  });
});
