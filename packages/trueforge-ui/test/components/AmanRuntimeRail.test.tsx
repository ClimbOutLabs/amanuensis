import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { avatarAltText } from '@/components/AmanAvatarMotion.js';
import { AmanRuntimeRail } from '@/components/AmanRuntimeRail.js';
import { PersonalizationProvider } from '@/components/PersonalizationContext.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import type { SentinelApi, SentinelUserSettings } from '@/sentinel/types.js';
import { clearContextCompaction, publishContextCompaction } from '@/utils/contextCompactionLive.js';

import { RuntimeHarness } from '../containers/RuntimeHarness.js';

const fetchMock = vi.fn();

/** The panda's accessible name carries the assistant's default display name. */
const PANDA_ALT = avatarAltText('Aman');

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

  it('shows the assistant identity and runtime summary', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail avatarSrc="/aman-avatar.png" modelName="local-model" />
      </RuntimeHarness>,
    );

    expect(screen.getByRole('complementary', { name: 'Amanuensis runtime status' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Aman' })).toBeInTheDocument();
    expect(screen.queryByText('local-model')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: PANDA_ALT })).toHaveAttribute('src', '/aman-avatar.png');
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
    expect(screen.getByRole('heading', { name: 'Aman' })).toBeInTheDocument();
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
      listBriefItemCompletions: async () => [],
      markBriefItemDone: async () => undefined,
      unmarkBriefItemDone: async () => undefined,
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
      expect(screen.getByRole('heading', { name: 'Aman' })).toBeInTheDocument();
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

  it('frames the picture with rounded corners and a fade inside the frame, with no border', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail avatarSrc="/aman-avatar.png" />
      </RuntimeHarness>,
    );
    const picture = screen.getByRole('img', { name: PANDA_ALT });
    const frame = picture.parentElement;
    expect(frame).toHaveClass('aman-runtime-rail__avatar');
    expect(frame?.querySelector('.aman-runtime-rail__fade')).not.toBeNull();

    const stylesheet = readFileSync(findStylesheet(), 'utf8');
    const ruleOf = (selector: string): string => {
      const start = stylesheet.indexOf(`${selector} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      return stylesheet.slice(start, stylesheet.indexOf('}', start) + 1);
    };
    // The frame clips its children and owns the rounded corners; it draws no border and no padding.
    const frameRule = ruleOf('.aman-runtime-rail__avatar');
    expect(frameRule).toMatch(/^\s{2}overflow: hidden;/m);
    expect(frameRule).toMatch(/^\s{2}border-radius: 0\.75rem;/m);
    expect(frameRule).not.toMatch(/border:|padding:|box-shadow/);
    // The fade is an absolute child at the foot of the frame, fading into the paper colour.
    const fadeRule = ruleOf('.aman-runtime-rail__fade');
    expect(fadeRule).toMatch(/^\s{2}position: absolute;/m);
    expect(fadeRule).toMatch(/^\s{2}bottom: 0;/m);
    expect(fadeRule).toMatch(/^\s{2}height: 3\.5rem;/m);
    expect(fadeRule).toContain('linear-gradient(to bottom, transparent, var(--paper))');
  });

  it('shows no release line, no Details disclosure, and no pixel lengths in the rail', () => {
    const { container } = render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail
          avatarSrc="/aman-avatar.png"
          modelName="local-model"
          version="0.4.2"
          buildRef="abcdef1234567"
        />
      </RuntimeHarness>,
    );

    expect(screen.queryByText(/Release/)).not.toBeInTheDocument();
    expect(screen.queryByText('Details')).not.toBeInTheDocument();
    expect(screen.queryByText('local-model')).not.toBeInTheDocument();
    expect(container.querySelector('.aman-runtime-rail__footer')).toBeNull();
  });

  it('folds Rules, Memory and Activity closed by default, with the chevron on the left of each label', () => {
    const { container } = render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail avatarSrc="/aman-avatar.png" auditFeed={<p>Recent actions body</p>} />
      </RuntimeHarness>,
    );

    const rows = Array.from(container.querySelectorAll<HTMLDetailsElement>('details.aman-runtime-rail__details'));
    expect(rows.map(row => row.dataset.section)).toEqual(['rules', 'memory', 'activity']);
    for (const row of rows) {
      expect(row.open).toBe(false);
      const summary = row.querySelector('summary');
      expect(summary?.firstElementChild).toHaveClass('aman-runtime-rail__fold-chevron');
    }
    expect(screen.getByText('Rules')).toBeInTheDocument();
    expect(screen.getByText('Memory')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
  });

  it('does not show a signed-in name or a memory status row', () => {
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

    expect(screen.queryByRole('heading', { name: 'You' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Memory' })).not.toBeInTheDocument();
    expect(screen.queryByText('Mum')).not.toBeInTheDocument();
    expect(screen.queryByText('Maria')).not.toBeInTheDocument();
    expect(screen.queryByText('Markdown (local files)')).not.toBeInTheDocument();
    expect(container.querySelector('[data-section="account"]')).toBeNull();
    expect(container.querySelector('[data-section="memory"]')).toHaveTextContent('What Aman remembers is in Settings.');
  });

  it('renders an accessible fallback when no avatar is configured', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail status="offline" />
      </RuntimeHarness>,
    );

    expect(screen.getByRole('img', { name: PANDA_ALT })).toHaveTextContent('A');
    expect(screen.getByText('Offline. Check your connection.')).toBeInTheDocument();
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

  it('captions the panda "Chief of staff" and names it with the assistant name only', async () => {
    render(
      <PersonalizationProvider
        api={{
          getProfile: async () => ({
            assistant_name: 'Mannie',
            assistant_identity: null,
            voice_guidance: null,
            user_name: 'Maya',
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
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail avatarSrc="/aman-avatar.png" />
        </RuntimeHarness>
      </PersonalizationProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Mannie' })).toBeInTheDocument();
    expect(screen.getByText('Chief of staff')).toHaveClass('aui-panda__role');
    expect(screen.getByRole('img', { name: avatarAltText('Mannie') })).toBeInTheDocument();
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

  it('shows ready once the live probe answers', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail />
      </RuntimeHarness>,
    );

    expect(await screen.findByText('Ready')).toBeInTheDocument();
  });

  it('lets an explicit status prop override the live probe', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail status="degraded" />
      </RuntimeHarness>,
    );

    // The probe would report ready, but the host's status wins and no probing happens.
    expect(screen.getByText('Connection is slow')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
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
    expect(await screen.findByText('Offline. Check your connection.')).toBeInTheDocument();

    fireEvent.click(retry);

    // The retry succeeds after a failure, so the rail reports degraded rather than ready.
    expect(await screen.findByText('Connection is slow')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders the avatar as a plain, static image with no animator wrapper classes', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail avatarSrc="/aman-avatar.png" />
      </RuntimeHarness>,
    );

    const avatar = screen.getByRole('img', { name: PANDA_ALT });
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
      const still = screen.getByRole('img', { name: PANDA_ALT });
      expect(still.tagName).toBe('IMG');
      expect(still).toHaveAttribute('src', motionSources.poster);

      // First non-idle activity: the video mounts and takes over.
      rerender(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail avatarSrc="/aman-avatar.png" avatarMotion={motionSources} activity="thinking" />
        </RuntimeHarness>,
      );
      const avatar = screen.getByRole('img', { name: PANDA_ALT });
      expect(avatar.tagName).toBe('VIDEO');
      expect(avatar.getAttribute('src')).toBe(motionSources.thinking);
      expect(avatar).toHaveAttribute('poster', motionSources.poster);
    });

    it('shows the still poster while an approval waits, when there is no waiting clip', () => {
      render(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail
            avatarSrc="/aman-avatar.png"
            avatarMotion={motionSources}
            activity="idle"
            status="ready"
            pendingApprovalIds={['approval-1']}
          />
        </RuntimeHarness>,
      );
      const still = screen.getByRole('img', { name: PANDA_ALT });
      expect(still.tagName).toBe('IMG');
      expect(still).toHaveAttribute('src', motionSources.poster);
      expect(screen.getByText('Waiting for you')).toBeInTheDocument();
    });

    it('plays the waiting clip while an approval waits, even when the agent is idle', () => {
      render(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail
            avatarSrc="/aman-avatar.png"
            avatarMotion={{ ...motionSources, waiting: '/aman-avatar/waiting.mp4' }}
            activity="idle"
            pendingApprovalIds={['approval-1']}
          />
        </RuntimeHarness>,
      );
      const avatar = screen.getByRole('img', { name: PANDA_ALT });
      expect(avatar.tagName).toBe('VIDEO');
      expect(avatar.getAttribute('src')).toBe('/aman-avatar/waiting.mp4');
    });

    it('plays the error clip the moment an error is reported', () => {
      render(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail avatarSrc="/aman-avatar.png" avatarMotion={motionSources} activity="error" />
        </RuntimeHarness>,
      );

      expect(screen.getByRole('img', { name: PANDA_ALT })).toHaveAttribute('src', motionSources.error);
    });

    it('keeps the static image when motion sources are absent, whatever the activity', () => {
      render(
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail avatarSrc="/aman-avatar.png" activity="writing" />
        </RuntimeHarness>,
      );

      const avatar = screen.getByRole('img', { name: PANDA_ALT });
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

      const avatar = screen.getByRole('img', { name: PANDA_ALT });
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

      expect(screen.getByRole('img', { name: PANDA_ALT })).toHaveTextContent('A');
    });
  });
});

describe('AmanRuntimeRail recent actions, rules and Needs you', () => {
  const settingsStub: SentinelUserSettings = {
    offline_mode: false,
    tier2_auto_allow: [],
    search_without_asking: true,
    maps_without_asking: false,
    sandbox_without_asking: false,
  };

  function sentinelWith(settings: SentinelUserSettings): SentinelApi {
    return {
      listAuditEntries: vi.fn(async () => []),
      listBriefItemCompletions: async () => [],
      markBriefItemDone: async () => undefined,
      unmarkBriefItemDone: async () => undefined,
      listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
      getUserSettings: vi.fn(async () => settings),
      updateUserSettings: vi.fn(async () => settings),
      listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
    };
  }

  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts the panda first, then the status line, then Rules, Memory and Activity', async () => {
    const { container } = render(
      <SentinelApiProvider api={sentinelWith(settingsStub)}>
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail
            avatarSrc="/aman-avatar.png"
            pendingApprovalIds={['approval-1']}
            auditFeed={<p>Recent actions body</p>}
            settingsHref="/settings"
          />
        </RuntimeHarness>
      </SentinelApiProvider>,
    );
    await screen.findByText('Sandbox code asks first');
    const order = Array.from(container.querySelectorAll('[data-section]')).map(node =>
      node.getAttribute('data-section'),
    );
    expect(order).toEqual(['panda', 'rules', 'memory', 'activity']);
    expect(container.querySelector('[data-section="activity"]')).toContainElement(
      screen.getByText('Recent actions body'),
    );
    expect(screen.getByRole('link', { name: 'Change in Settings' })).toHaveAttribute('href', '/settings');
  });

  it('shows one pending signal: no Needs you ticket, and the status line says the approval is waiting', () => {
    const { container } = render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail pendingApprovalIds={['approval-1', 'approval-2']} status="ready" />
      </RuntimeHarness>,
    );
    expect(container.querySelector('[data-section="needs-you"]')).toBeNull();
    expect(screen.queryByText(/Needs you/)).not.toBeInTheDocument();
    expect(container.querySelectorAll('.aui-ticket--selected')).toHaveLength(0);
    expect(screen.getByText('Waiting for you')).toBeInTheDocument();
  });

  it('says what Aman is doing in the status line and keeps it polite for screen readers', () => {
    const { container, rerender } = render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail status="ready" activity="thinking" />
      </RuntimeHarness>,
    );
    const status = container.querySelector('.aman-runtime-rail__status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Working on it');

    rerender(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail status="ready" activity="idle" />
      </RuntimeHarness>,
    );
    expect(container.querySelector('.aman-runtime-rail__status')).toHaveTextContent('Ready');
  });

  it('says the conversation is being tidied while this chat is shortened, and only this chat', () => {
    const { container } = render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail status="ready" activity="thinking" sessionId="chat-1" />
      </RuntimeHarness>,
    );
    const status = () => container.querySelector('.aman-runtime-rail__status');
    act(() => publishContextCompaction({ sessionId: 'chat-2', active: true }));
    expect(status()).toHaveTextContent('Working on it');

    act(() => publishContextCompaction({ sessionId: 'chat-1', active: true }));
    expect(status()).toHaveTextContent('Tidying up the conversation');

    act(() => publishContextCompaction({ sessionId: 'chat-1', active: false }));
    expect(status()).toHaveTextContent('Working on it');
    act(() => clearContextCompaction());
  });

  it('reads the three rules in plain words from the saved settings', async () => {
    render(
      <SentinelApiProvider api={sentinelWith({ ...settingsStub, offline_mode: true })}>
        <RuntimeHarness messages={[]}>
          <AmanRuntimeRail />
        </RuntimeHarness>
      </SentinelApiProvider>,
    );
    expect(await screen.findByText('Web searches run without asking')).toBeInTheDocument();
    expect(screen.getByText('Sandbox code asks first')).toBeInTheDocument();
    expect(screen.getByText('Offline mode is on')).toBeInTheDocument();
    // Read-only: the rules offer no switch.
    expect(screen.queryByRole('switch', { name: /offline/i })).not.toBeInTheDocument();
  });

  it('keeps the model name out of the rail', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail modelName="local-model" />
      </RuntimeHarness>,
    );
    expect(screen.queryByText('local-model')).not.toBeInTheDocument();
  });
});
