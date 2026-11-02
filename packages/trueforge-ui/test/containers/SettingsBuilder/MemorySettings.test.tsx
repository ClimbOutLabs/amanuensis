// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MemorySettings from '@/containers/SettingsBuilder/MemorySettings.js';
import { ServerProvider, useOptionalRefreshServerCapabilities } from '@/server/ServerContext.js';
import type { AgentBuilderCapabilitiesResponse, AgentUIServer } from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

/** The agent's own memory setting, shown only until the person-level switch is set; the runtime hook is stubbed. */
const recallState = vi.hoisted(() => ({ enabled: true }));

vi.mock('@truefoundry/assistant-ui-runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('@truefoundry/assistant-ui-runtime')>()),
  useTrueFoundryAgentSpec: () => ({
    agentSpec: { config: { memory: { recallEnabled: recallState.enabled } } },
  }),
}));

/** Memory-defaults fixture per the generated SDK type. The page only reads `backend` and
 * `markdownDir` from it; the tuning fields exist to satisfy the type. */
const MARKDOWN_DEFAULTS = {
  backend: 'markdown',
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMaxItems: 50,
  recallMaxEntities: 10,
  recallMinScore: 0.6,
  curatedEnabled: true,
  curatedMaxModels: 3,
  curatedMaxTokens: 512,
  prerecallGateEnabled: false,
  reflectEnabled: true,
  reflectBudget: 'low',
  reflectMaxTokens: 512,
  reflectTimeoutMs: 8000,
} satisfies TrueForgeApi.MemoryDefaultsCapability;

/** The storage directory the server reports for the markdown backend. */
const MEMORY_DEFAULTS_WITH_DIR: TrueForgeApi.MemoryDefaultsCapability = {
  ...MARKDOWN_DEFAULTS,
  markdownDir: '/srv/aman/data/memory',
};

type MemoryCapabilitiesData = {
  memoryDefaults?: TrueForgeApi.MemoryDefaultsCapability;
  /** Raw wire shape, as the server actually sends it (`markdown_dir`, snake_case). */
  memory_defaults?: unknown;
  memoryScreen?: TrueForgeApi.MemoryScreenCapability & { configured?: boolean; threshold?: number };
  toolOutputScreen?: TrueForgeApi.ToolOutputScreenCapability;
  memory_screen?: unknown;
  tool_output_screen?: unknown;
};

function capabilitiesWith(data: MemoryCapabilitiesData): Partial<AgentUIServer> {
  const response = {
    data: { sandbox: { enabled: true }, skill: { enabled: true }, ...data },
  } satisfies AgentBuilderCapabilitiesResponse & {
    data: AgentBuilderCapabilitiesResponse['data'] & MemoryCapabilitiesData;
  };
  return { getCapabilities: async () => response };
}

function renderMemory(serverOverrides: Partial<AgentUIServer> = {}) {
  const server = createMockAgentUIServer({ catalog: createMockCatalog(), ...serverOverrides });
  return render(
    <ServerProvider server={server}>
      <MemorySettings />
    </ServerProvider>,
  );
}

describe('MemorySettings (backend honesty)', () => {
  it('says it is checking while capabilities are unsettled — never claiming on', async () => {
    // A capabilities promise that never resolves: the page must not name a backend.
    const getCapabilities = vi.fn((): Promise<AgentBuilderCapabilitiesResponse> => new Promise(() => {}));
    renderMemory({ getCapabilities });

    expect(await screen.findByText('Checking memory status…')).toBeInTheDocument();
    expect(screen.queryByText('Memory is on')).not.toBeInTheDocument();
    expect(screen.queryByText('Markdown (local files)')).not.toBeInTheDocument();
    expect(screen.queryByText('Hindsight (experimental)')).not.toBeInTheDocument();
    expect(screen.queryByText('Memory status unavailable')).not.toBeInTheDocument();
  });

  it('shows Markdown as the active memory implementation', async () => {
    renderMemory(capabilitiesWith({ memoryDefaults: MARKDOWN_DEFAULTS }));

    expect(await screen.findByText('Memory is on')).toBeInTheDocument();
    expect(screen.getByText('Markdown (local files)')).toBeInTheDocument();
    expect(screen.getByText(/Aman saves memories as notes on this computer/)).toBeInTheDocument();
    expect(screen.getByText('How memory works')).toBeInTheDocument();
    expect(screen.queryByText('Checking memory status…')).not.toBeInTheDocument();
    expect(screen.queryByText('Memory status unavailable')).not.toBeInTheDocument();
  });

  it('exposes no bank lifecycle UI: no connect, test, edit, remove, or provider URL', async () => {
    renderMemory(capabilitiesWith({ memoryDefaults: MARKDOWN_DEFAULTS }));
    await screen.findByText('Markdown (local files)');

    expect(screen.queryByText('Hindsight')).not.toBeInTheDocument();
    expect(screen.queryByText('Test connection')).not.toBeInTheDocument();
    expect(screen.queryByText('No memory bank configured')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/bank URL/i)).not.toBeInTheDocument();
  });

  it('shows the server-reported storage location and no tuning controls', async () => {
    renderMemory(capabilitiesWith({ memoryDefaults: MEMORY_DEFAULTS_WITH_DIR }));

    expect(await screen.findByText('Markdown (local files)')).toBeInTheDocument();
    // The storage line reads the server-resolved directory — display only, never editable.
    expect(screen.getByText('/srv/aman/data/memory')).toBeInTheDocument();
    expect(screen.getByText(/Memories live in/)).toBeInTheDocument();
    // The dead tuning surface is gone entirely: no heading, no save, no knobs.
    expect(screen.queryByText('Memory tuning')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save tuning' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Recall timeout/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Recall query window/)).not.toBeInTheDocument();
  });

  it('reads the raw snake_case wire shape for the storage location', async () => {
    renderMemory(capabilitiesWith({ memory_defaults: { backend: 'markdown', markdown_dir: '/var/lib/aman/memory' } }));

    expect(await screen.findByText('/var/lib/aman/memory')).toBeInTheDocument();
    expect(screen.getByText(/Memories live in/)).toBeInTheDocument();
  });

  it('says the status is unavailable when the settled capability names no known backend', async () => {
    renderMemory(capabilitiesWith({}));

    // Missing `memory_defaults`: the UI must not guess Markdown.
    expect(await screen.findByText('Memory status unavailable')).toBeInTheDocument();
    expect(screen.getByText(/on or off cannot be confirmed here/)).toBeInTheDocument();
    expect(screen.queryByText('Memory is on')).not.toBeInTheDocument();
    expect(screen.queryByText('Markdown (local files)')).not.toBeInTheDocument();
    expect(screen.queryByText('Hindsight (experimental)')).not.toBeInTheDocument();
    expect(screen.queryByText('How memory works')).not.toBeInTheDocument();
  });

  it('says the status is unavailable when the server names an unknown backend', async () => {
    // Raw wire shape: the typed fixture cannot spell an unknown backend, but the wire can.
    renderMemory(capabilitiesWith({ memory_defaults: { backend: 'flux-capacitor' } }));

    expect(await screen.findByText('Memory status unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Memory is on')).not.toBeInTheDocument();
    expect(screen.queryByText('Markdown (local files)')).not.toBeInTheDocument();
  });

  it('names Hindsight truthfully — experimental, Markdown off — on the hindsight backend', async () => {
    renderMemory(capabilitiesWith({ memoryDefaults: { ...MARKDOWN_DEFAULTS, backend: 'hindsight' } }));

    // Hindsight is a working server-side backend, so memory reads as on — but the card
    // names it truthfully and makes no Markdown claims.
    expect(await screen.findByText('Memory is on')).toBeInTheDocument();
    expect(screen.getByText('Hindsight (experimental)')).toBeInTheDocument();
    expect(screen.getByText(/Markdown file memory.*does not apply here/)).toBeInTheDocument();
    expect(screen.getByText(/uses the experimental Hindsight memory instead of note files/)).toBeInTheDocument();
    expect(screen.queryByText('Markdown (local files)')).not.toBeInTheDocument();
    expect(screen.queryByText('How memory works')).not.toBeInTheDocument();
    expect(screen.queryByText(/Memories live in/)).not.toBeInTheDocument();
  });

  describe('recall screening status', () => {
    it('reads as unavailable, not off, with no memory_screen capability at all', async () => {
      renderMemory(capabilitiesWith({ memoryDefaults: MARKDOWN_DEFAULTS }));

      expect(await screen.findByText('Recall screening status unavailable')).toBeInTheDocument();
      expect(screen.queryByText('Recall screening is off')).not.toBeInTheDocument();
      // The status card still names the server env that drives it.
      expect(screen.getByText(/MEMORY_SCREEN_ENABLED/)).toBeInTheDocument();
    });

    it('reads as off when the server reports enabled false', async () => {
      renderMemory(
        capabilitiesWith({
          memoryDefaults: MARKDOWN_DEFAULTS,
          memoryScreen: { enabled: false, configured: true },
        }),
      );

      expect(await screen.findByText('Recall screening is off')).toBeInTheDocument();
      expect(screen.queryByText('Recall screening status unavailable')).not.toBeInTheDocument();
    });

    it('reads as on and shows the threshold the server reports', async () => {
      renderMemory(
        capabilitiesWith({
          memoryDefaults: MARKDOWN_DEFAULTS,
          memoryScreen: { enabled: true, configured: true, threshold: 0.62 },
        }),
      );

      expect(await screen.findByText('Recall screening is on')).toBeInTheDocument();
      expect(screen.getByText('Threshold')).toBeInTheDocument();
      expect(screen.getByText('0.62')).toBeInTheDocument();
    });

    it('renders a working recall-screen switch backed by the persisted setting', async () => {
      // The memory-screen port is provided so its toggle renders; the tool-output port
      // is omitted so only the recall switch is on the page.
      const memoryScreenPort = {
        memoryScreen: {
          getMemoryScreen: async () => ({
            enabled: true,
            overridden: true,
            defaultEnabled: false,
          }),
          setMemoryScreenEnabled: async () => ({
            enabled: true,
            overridden: true,
            defaultEnabled: false,
          }),
        },
      };
      renderMemory({
        ...capabilitiesWith({
          memoryDefaults: MARKDOWN_DEFAULTS,
          memoryScreen: { enabled: true, configured: true },
          tool_output_screen: { enabled: false, configured: true },
        }),
        ...memoryScreenPort,
      });
      await screen.findByText('Recall screening is on');

      // The recall card now has its own switch, backed by the persisted setting.
      const toggle = screen.getByRole('switch', { name: 'Screen recalled memories with Prompt Guard' });
      expect(toggle).toBeEnabled();
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByText('This switch overrides the server default.')).toBeInTheDocument();
      expect(screen.queryByText(/there is no per-bank switch/)).not.toBeInTheDocument();
    });

    it('never renders the classifier url or an auth token, even if either rode along', async () => {
      renderMemory(
        capabilitiesWith({
          memoryDefaults: MARKDOWN_DEFAULTS,
          memory_screen: {
            enabled: true,
            configured: true,
            url: 'https://screen.internal/classify',
            auth_token: 'sekrit',
          },
        }),
      );

      expect(await screen.findByText('Recall screening is on')).toBeInTheDocument();
      expect(screen.queryByText(/screen\.internal/)).not.toBeInTheDocument();
      expect(screen.queryByText(/sekrit/)).not.toBeInTheDocument();
    });
  });

  describe('tool-output screen switch', () => {
    const SWITCH_NAME = 'Screen live tool output with Prompt Guard';
    const NOT_CONFIGURED_REASON = 'No screening service configured';

    /** The trueforge adapter's tool-output port, so the toggle renders instead of hiding. */
    function renderToolOutputSwitch(
      tool_output_screen: unknown,
      stored: { enabled: boolean; overridden: boolean; defaultEnabled: boolean } = {
        enabled: false,
        overridden: false,
        defaultEnabled: false,
      },
    ) {
      const toolOutputScreenPort = {
        toolOutputScreen: {
          getToolOutputScreen: async () => stored,
          setToolOutputScreenEnabled: async () => stored,
        },
      };
      renderMemory({
        ...capabilitiesWith({
          memoryDefaults: MARKDOWN_DEFAULTS,
          memory_screen: { enabled: false, configured: true },
          tool_output_screen,
        }),
        ...toolOutputScreenPort,
      });
    }

    it('disables the switch with the server reason when no screening service is configured', async () => {
      renderToolOutputSwitch({ enabled: false, configured: false, reason: NOT_CONFIGURED_REASON });

      const toggle = await screen.findByRole('switch', { name: SWITCH_NAME });
      expect(toggle).toBeDisabled();
      expect(screen.getByText(NOT_CONFIGURED_REASON)).toBeInTheDocument();
    });

    it('leaves the switch enabled when the screening service is configured', async () => {
      renderToolOutputSwitch({ enabled: true, configured: true, threshold: 0.5, timeout_ms: 2_250 });

      const toggle = await screen.findByRole('switch', { name: SWITCH_NAME });
      expect(toggle).toBeEnabled();
      expect(screen.queryByText(NOT_CONFIGURED_REASON)).not.toBeInTheDocument();
    });

    it('shows live tool-output screening status under Memory', async () => {
      renderToolOutputSwitch({ enabled: true, configured: true, threshold: 0.62, timeoutMs: 2250 });

      expect(await screen.findByText('Tool-output screening is on')).toBeInTheDocument();
      expect(screen.getByText('2250 ms')).toBeInTheDocument();
      expect(screen.getByText(/TOOL_OUTPUT_SCREEN_ENABLED/)).toBeInTheDocument();
    });
  });

  describe('turn summarization switch', () => {
    const SWITCH_NAME = 'Summarize turns before saving';
    const RESET_NAME = 'Reset to server default';

    type SummarizeStored = {
      enabled: boolean;
      overridden: boolean;
      defaultEnabled: boolean;
      effectiveEnabled: boolean;
    };

    /** The trueforge adapter's summarization port, so the toggle renders instead of hiding. */
    function renderSummarizeSwitch(stored: SummarizeStored, writes: Array<boolean | null> = []) {
      const memorySummarizePort = {
        memorySummarize: {
          getMemorySummarize: async () => stored,
          setMemorySummarizeEnabled: async (enabled: boolean | null) => {
            writes.push(enabled);
            // The mock server applies the same markdown-only gate as the real one:
            // on this (markdown) backend the effective state equals the stored value.
            const nextEnabled = enabled === null ? stored.defaultEnabled : enabled;
            return {
              enabled: nextEnabled,
              overridden: enabled !== null,
              defaultEnabled: stored.defaultEnabled,
              effectiveEnabled: nextEnabled,
            };
          },
        },
      };
      renderMemory({
        ...capabilitiesWith({ memoryDefaults: MARKDOWN_DEFAULTS }),
        ...memorySummarizePort,
      });
    }

    it('renders the Turn summaries card in plain English', async () => {
      renderSummarizeSwitch({ enabled: true, overridden: true, defaultEnabled: false, effectiveEnabled: true });

      expect(await screen.findByText('Turn summaries')).toBeInTheDocument();
      expect(screen.getByText(/saves only the lasting facts/)).toBeInTheDocument();
      const toggle = screen.getByRole('switch', { name: SWITCH_NAME });
      expect(toggle).toBeChecked();
    });

    it('shows ON at startup when the env default is on and nothing is stored', async () => {
      // Fresh install, no MEMORY_SUMMARIZE env var, no override: the toggle shows the
      // effective state, which is on.
      renderSummarizeSwitch({
        enabled: true,
        overridden: false,
        defaultEnabled: true,
        effectiveEnabled: true,
      });

      const toggle = await screen.findByRole('switch', { name: SWITCH_NAME });
      expect(toggle).toBeChecked();
      expect(toggle).toBeEnabled();
      expect(screen.getByText(/server default \(on\)/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: RESET_NAME })).not.toBeInTheDocument();
    });

    it('shows the effective state — off and disabled — when the backend gate blocks', async () => {
      // The stored setting says on, but this server will not summarize: the toggle
      // shows the truth instead of the stored wish.
      renderSummarizeSwitch({
        enabled: true,
        overridden: true,
        defaultEnabled: true,
        effectiveEnabled: false,
      });

      const toggle = await screen.findByRole('switch', { name: SWITCH_NAME });
      expect(toggle).not.toBeChecked();
      expect(toggle).toBeDisabled();
      expect(screen.getByText(/need Markdown memory/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: RESET_NAME })).not.toBeInTheDocument();
    });

    it('flips the toggle and writes the new state through the port', async () => {
      const writes: Array<boolean | null> = [];
      renderSummarizeSwitch({ enabled: true, overridden: true, defaultEnabled: false, effectiveEnabled: true }, writes);

      const toggle = await screen.findByRole('switch', { name: SWITCH_NAME });
      fireEvent.click(toggle);

      await waitFor(() => {
        expect(writes).toEqual([false]);
      });
      expect(toggle).not.toBeChecked();
    });

    it('offers reset only while overridden, and clearing returns to the server default', async () => {
      const writes: Array<boolean | null> = [];
      renderSummarizeSwitch({ enabled: true, overridden: true, defaultEnabled: false, effectiveEnabled: true }, writes);

      const reset = await screen.findByRole('button', { name: RESET_NAME });
      fireEvent.click(reset);

      await waitFor(() => {
        expect(writes).toEqual([null]);
      });
      // Optimistic: back to the server default (off) while the server confirms.
      expect(screen.getByRole('switch', { name: SWITCH_NAME })).not.toBeChecked();
    });

    it('hides the card when the server has no summarization port', async () => {
      renderMemory(capabilitiesWith({ memoryDefaults: MARKDOWN_DEFAULTS }));

      await screen.findByText('Memory is on');
      expect(screen.queryByText('Turn summaries')).not.toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: SWITCH_NAME })).not.toBeInTheDocument();
    });
  });

  describe('meaning-based recall status polling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Capabilities payload whose embeddings card reads a given state. */
    function embeddingsResponse(state: string) {
      return {
        data: {
          sandbox: { enabled: true },
          skill: { enabled: true },
          memory_embeddings: {
            enabled: true,
            state,
            detail: `state is ${state}`,
            indexed_entries: 3,
          },
        },
      };
    }

    /** Renders with fake timers and flushes the initial capabilities fetch. */
    async function renderWithState(state: string) {
      const getCapabilities = vi.fn(async () => embeddingsResponse(state));
      const rendered = renderMemory({ getCapabilities });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      return { ...rendered, getCapabilities };
    }

    it('reads "Keywords only" — never "Off" — when meaning-based search is disabled', async () => {
      const getCapabilities = vi.fn(async () => ({
        data: {
          sandbox: { enabled: true },
          skill: { enabled: true },
          memory_embeddings: {
            enabled: false,
            state: 'unavailable',
            detail: 'Meaning-based recall is off on this server.',
            indexed_entries: 0,
          },
        },
      }));
      renderMemory({ getCapabilities });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      // Markdown keyword search still works when embeddings are off; the badge must
      // say so instead of implying memory search is off entirely.
      expect(screen.getByText('Keywords only')).toBeInTheDocument();
      expect(screen.queryByText('Off')).not.toBeInTheDocument();
    });

    it('polls capabilities every 5s while downloading and stops on unmount', async () => {
      const { getCapabilities, unmount } = await renderWithState('downloading');

      expect(screen.getByText('Downloading')).toBeInTheDocument();
      expect(getCapabilities).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(getCapabilities).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(getCapabilities).toHaveBeenCalledTimes(3);

      // Unmount clears the interval: no more polls after the card is gone.
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000);
      });
      expect(getCapabilities).toHaveBeenCalledTimes(3);
    });

    it('does not poll once the state is ready', async () => {
      const { getCapabilities } = await renderWithState('ready');

      expect(screen.getByText('Ready')).toBeInTheDocument();
      expect(getCapabilities).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(getCapabilities).toHaveBeenCalledTimes(1);
    });

    it('does not poll when the server reports no embeddings status', async () => {
      const getCapabilities = vi.fn(async () => ({
        data: { sandbox: { enabled: true }, skill: { enabled: true } },
      }));
      renderMemory({ getCapabilities });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      expect(screen.getByText('Status unavailable')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(getCapabilities).toHaveBeenCalledTimes(1);
    });
    it('polls while unavailable so a recovery is picked up', async () => {
      const { getCapabilities } = await renderWithState('unavailable');

      expect(screen.getByText('Keywords only')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(getCapabilities).toHaveBeenCalledTimes(2);
    });

    it('surfaces the failure once: dismissible, not a nag on later polls', async () => {
      const { getCapabilities } = await renderWithState('unavailable');

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Smart search isn\u2019t available right now');
      expect(alert).toHaveTextContent('keyword');
      expect(alert).toHaveTextContent('trying again automatically');

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // Still unavailable on the next polls: the notice stays dismissed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(getCapabilities).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('re-arms the failure notice after recovery and a new failure', async () => {
      let state = 'unavailable';
      let refresh: (() => void) | null = null;
      const Probe = () => {
        refresh = useOptionalRefreshServerCapabilities();
        return null;
      };
      const getCapabilities = vi.fn(async () => embeddingsResponse(state));
      const server = createMockAgentUIServer({ catalog: createMockCatalog(), getCapabilities });
      render(
        <ServerProvider server={server}>
          <Probe />
          <MemorySettings />
        </ServerProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      expect(screen.getByRole('alert')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // Recovery clears the dismissal …
      state = 'ready';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.getByText('Ready')).toBeInTheDocument();

      // … so a new failure surfaces the notice again.
      state = 'unavailable';
      await act(async () => {
        refresh?.();
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});

describe('MemorySettings (use memories in replies)', () => {
  /** A memory-recall port backed by one stored value, as the server keeps it. */
  function recallPort(initial: boolean | null) {
    const state = { enabled: initial };
    const setMemoryRecallEnabled = vi.fn(async (next: boolean | null) => {
      state.enabled = next;
      return { enabled: state.enabled };
    });
    return {
      setMemoryRecallEnabled,
      server: {
        ...capabilitiesWith({ memoryDefaults: MARKDOWN_DEFAULTS }),
        memoryRecall: { getMemoryRecall: async () => ({ enabled: state.enabled }), setMemoryRecallEnabled },
      },
    };
  }

  it('saves the switch to the server setting, not to the agent', async () => {
    recallState.enabled = true;
    const { server, setMemoryRecallEnabled } = recallPort(null);
    renderMemory(server);

    const recall = await screen.findByRole('switch', { name: 'Use memories in replies' });
    // Nothing is stored yet, so the agent's own value (on) shows.
    expect(recall).toBeChecked();

    fireEvent.click(recall);
    await waitFor(() => {
      expect(setMemoryRecallEnabled).toHaveBeenLastCalledWith(false);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Use memories in replies' })).not.toBeChecked();
    });

    fireEvent.click(screen.getByRole('switch', { name: 'Use memories in replies' }));
    await waitFor(() => {
      expect(setMemoryRecallEnabled).toHaveBeenLastCalledWith(true);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Use memories in replies' })).toBeChecked();
    });
  });

  it('reflects the stored setting over the agent value', async () => {
    recallState.enabled = true;
    renderMemory(recallPort(false).server);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Use memories in replies' })).not.toBeChecked();
    });
  });

  it('clears the switch back to the agent setting', async () => {
    recallState.enabled = true;
    const { server, setMemoryRecallEnabled } = recallPort(false);
    renderMemory(server);

    fireEvent.click(await screen.findByRole('button', { name: "Follow each agent's own setting" }));
    await waitFor(() => {
      expect(setMemoryRecallEnabled).toHaveBeenLastCalledWith(null);
    });
    // Nothing is stored now, so the agent's own value (on) shows and the link is gone.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Use memories in replies' })).toBeChecked();
    });
    expect(screen.queryByRole('button', { name: "Follow each agent's own setting" })).not.toBeInTheDocument();
  });

  it('shows a plain message and keeps the old value when the save fails', async () => {
    recallState.enabled = true;
    const { server } = recallPort(true);
    const failingServer = {
      ...server,
      memoryRecall: {
        ...server.memoryRecall,
        setMemoryRecallEnabled: async () => {
          throw new Error('The memory switch failed with HTTP 500. Try again in a moment.');
        },
      },
    };
    renderMemory(failingServer);

    fireEvent.click(await screen.findByRole('switch', { name: 'Use memories in replies' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in a moment');
    expect(screen.getByRole('switch', { name: 'Use memories in replies' })).toBeChecked();
  });

  it('hides the recall switch while the memory backend is not confirmed', async () => {
    renderMemory(capabilitiesWith({}));

    expect(await screen.findByText('Memory status unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Use memories in replies' })).not.toBeInTheDocument();
  });
});

describe('MemorySettings (past-chat search)', () => {
  /** A chat-search port backed by one stored value, as the server keeps it. */
  function chatSearchPort(initial: boolean) {
    const state = { enabled: initial };
    const setChatSearchEnabled = vi.fn(async (next: boolean) => {
      state.enabled = next;
      return { enabled: state.enabled };
    });
    return {
      setChatSearchEnabled,
      server: {
        ...capabilitiesWith({ memoryDefaults: MARKDOWN_DEFAULTS }),
        chatSearch: {
          getChatSearch: async () => ({ enabled: state.enabled }),
          setChatSearchEnabled,
          searchOwnChats: async () => ({ searchEnabled: state.enabled, hits: [] }),
        },
      },
    };
  }

  it('is off until the person turns it on, and saves each flip', async () => {
    const { server, setChatSearchEnabled } = chatSearchPort(false);
    renderMemory(server);

    const toggle = await screen.findByRole('switch', { name: 'Let Aman search your past chats when you ask' });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(setChatSearchEnabled).toHaveBeenLastCalledWith(true);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Let Aman search your past chats when you ask' })).toBeChecked();
    });

    fireEvent.click(screen.getByRole('switch', { name: 'Let Aman search your past chats when you ask' }));
    await waitFor(() => {
      expect(setChatSearchEnabled).toHaveBeenLastCalledWith(false);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Let Aman search your past chats when you ask' })).not.toBeChecked();
    });
  });

  it('shows the stored on value', async () => {
    renderMemory(chatSearchPort(true).server);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Let Aman search your past chats when you ask' })).toBeChecked();
    });
  });

  it('shows a plain message and keeps the old value when the save fails', async () => {
    const { server } = chatSearchPort(false);
    const failingServer = {
      ...server,
      chatSearch: {
        ...server.chatSearch,
        setChatSearchEnabled: async () => {
          throw new Error('The past-chat search switch failed with HTTP 500. Try again in a moment.');
        },
      },
    };
    renderMemory(failingServer);

    fireEvent.click(await screen.findByRole('switch', { name: 'Let Aman search your past chats when you ask' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in a moment');
    expect(screen.getByRole('switch', { name: 'Let Aman search your past chats when you ask' })).not.toBeChecked();
  });
});
