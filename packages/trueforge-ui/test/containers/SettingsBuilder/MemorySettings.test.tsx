// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MemorySettings from '@/containers/SettingsBuilder/MemorySettings.js';
import { ServerProvider, useOptionalRefreshServerCapabilities } from '@/server/ServerContext.js';
import type { AgentBuilderCapabilitiesResponse, AgentUIServer } from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

/** Every memory-defaults field, as the reader normalizes them (camelCase). */
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
  reflectEnabled: true,
  reflectBudget: 'low',
  reflectMaxTokens: 512,
  reflectTimeoutMs: 8000,
} satisfies TrueForgeApi.MemoryDefaultsCapability;

type MemoryCapabilitiesData = {
  memoryDefaults?: TrueForgeApi.MemoryDefaultsCapability;
  memoryScreen?: TrueForgeApi.MemoryScreenCapability;
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

describe('MemorySettings (Markdown-only)', () => {
  it('shows Markdown as the active memory implementation', async () => {
    renderMemory(capabilitiesWith({ memoryDefaults: MARKDOWN_DEFAULTS }));

    expect(await screen.findByText('Memory is on')).toBeInTheDocument();
    expect(screen.getByText('Markdown (local files)')).toBeInTheDocument();
    expect(screen.getByText(/Aman saves memories as local Markdown files on the server/)).toBeInTheDocument();
    expect(screen.getByText('How memory works')).toBeInTheDocument();
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

  it('renders tuning read-only: values visible, nothing to save', async () => {
    renderMemory(capabilitiesWith({ memoryDefaults: MARKDOWN_DEFAULTS }));

    expect(await screen.findByText('Memory tuning')).toBeInTheDocument();
    // No save affordance: Markdown memory is tuned through the server environment.
    expect(screen.queryByRole('button', { name: 'Save tuning' })).not.toBeInTheDocument();
    expect(screen.getByText(/no per-bank settings to save/)).toBeInTheDocument();

    // The fields still show the effective server values, but cannot be edited.
    const timeout = screen.getByLabelText('Recall timeout (milliseconds)');
    expect(timeout).toHaveAttribute('placeholder', '2500');
    expect(timeout).toBeDisabled();
    expect(screen.getByLabelText('Recall query window (messages)')).toBeDisabled();
  });

  it('falls back to the plain words when the server did not report defaults', async () => {
    renderMemory(capabilitiesWith({}));

    // The server default backend is markdown, so the UI still reads as Markdown.
    expect(await screen.findByText('Markdown (local files)')).toBeInTheDocument();
    expect(screen.getByText('Memory tuning')).toBeInTheDocument();
    // 'Server default' is the placeholder text when the server reported no defaults.
    expect(screen.getByLabelText('Recall timeout (milliseconds)')).toHaveAttribute('placeholder', 'Server default');
    expect(screen.queryByRole('button', { name: 'Save tuning' })).not.toBeInTheDocument();
  });

  it('never names Hindsight in Settings, even when the server reports the experimental backend', async () => {
    renderMemory(capabilitiesWith({ memoryDefaults: { ...MARKDOWN_DEFAULTS, backend: 'hindsight' } }));

    // Settings always presents the supported Markdown memory; the server-side
    // experimental backend is never named here.
    expect(await screen.findByText('Memory is on')).toBeInTheDocument();
    expect(screen.getByText('Markdown (local files)')).toBeInTheDocument();
    expect(screen.queryByText(/hindsight/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Experimental backend')).not.toBeInTheDocument();
    expect(screen.queryByText(/Bank management is not available in Settings/)).not.toBeInTheDocument();
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

    it('offers no switch: recall screening is resolved by the server', async () => {
      // The tool-output port is provided so its (live) toggle renders; the recall card
      // must still have no switch of its own.
      const toolOutputScreenPort = {
        toolOutputScreen: {
          getToolOutputScreen: async () => ({
            enabled: false,
            overridden: false,
            defaultEnabled: false,
          }),
          setToolOutputScreenEnabled: async () => ({
            enabled: false,
            overridden: false,
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
        ...toolOutputScreenPort,
      });
      await screen.findByText('Recall screening is on');

      // The only switch on the page belongs to tool-output screening.
      expect(screen.getAllByRole('switch')).toHaveLength(1);
      expect(screen.getByText(/there is no per-bank switch/)).toBeInTheDocument();
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
      expect(screen.getByText(/important details/)).toBeInTheDocument();
      expect(screen.getByText(/full transcript/)).toBeInTheDocument();
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
