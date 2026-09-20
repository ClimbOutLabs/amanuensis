// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { describe, expect, it } from 'vitest';

import MemorySettings from '@/containers/SettingsBuilder/MemorySettings.js';
import { ServerProvider } from '@/server/ServerContext.js';
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
    expect(
      screen.getByText(/Aman saves memories as local Markdown files on the server/),
    ).toBeInTheDocument();
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
    expect(screen.getByLabelText('Recall timeout (milliseconds)')).toHaveAttribute(
      'placeholder',
      'Server default',
    );
    expect(screen.queryByRole('button', { name: 'Save tuning' })).not.toBeInTheDocument();
  });

  it('names the hindsight backend as experimental, with no management UI', async () => {
    renderMemory(
      capabilitiesWith({ memoryDefaults: { ...MARKDOWN_DEFAULTS, backend: 'hindsight' } }),
    );

    expect(await screen.findByText('Experimental backend')).toBeInTheDocument();
    expect(screen.getByText('Hindsight (experimental)')).toBeInTheDocument();
    expect(
      screen.getByText(/Bank management is not available in Settings/),
    ).toBeInTheDocument();
    // No tuning form and no bank lifecycle for the experimental backend either.
    expect(screen.queryByText('Memory tuning')).not.toBeInTheDocument();
    expect(screen.queryByText('Test connection')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect/i })).not.toBeInTheDocument();
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
});
