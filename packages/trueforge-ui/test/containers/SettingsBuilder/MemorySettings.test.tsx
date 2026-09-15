// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectorWithMemoryProvider } from '@/containers/SettingsBuilder/memoryProvider.js';
import MemorySettings from '@/containers/SettingsBuilder/MemorySettings.js';
import type { ConnectorChecks } from '@/server/connectorChecks.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type {
  AgentBuilderCapabilitiesResponse,
  AgentUIServer,
  CatalogServer,
  ConnectorBase,
  CreateConnectorRequest,
  UpdateConnectorRequest,
} from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

const parallelWeb: ConnectorBase = {
  id: 'parallel-web',
  name: 'parallel-web',
  description: 'Search the web',
  url: 'https://search.parallel.ai/mcp',
  authenticated: true,
  requiresAuth: false,
  auth: { type: 'none' },
};

const hindsight: ConnectorWithMemoryProvider = {
  id: 'hindsight',
  name: 'hindsight',
  description: 'Long-term memory bank',
  url: 'https://hindsight.example.com/mcp/aman/',
  authenticated: true,
  requiresAuth: false,
  auth: { type: 'header' },
};

const hindsightAsProvider: ConnectorWithMemoryProvider = { ...hindsight, memoryProvider: true };

/** OAuth is the form's default auth type, and a fresh OAuth row has no token yet. */
const hindsightOauth: ConnectorBase = {
  ...hindsight,
  auth: { type: 'dcr' },
  authenticated: false,
  requiresAuth: true,
};

const REST_401_REASON = 'recall returned HTTP 401: Authentication failed: Invalid API key';

/** The catalog port's requests do not declare the flag the settings UI attaches to them. */
function memoryProviderOf(request: object): boolean | undefined {
  const value = Reflect.get(request, 'memoryProvider');
  return typeof value === 'boolean' ? value : undefined;
}

type MockConnectorCatalog = CatalogServer['connectorCatalog'] & Partial<ConnectorChecks>;

function renderMemory(
  connectors: ConnectorBase[] = [],
  overrides: Partial<MockConnectorCatalog> = {},
  serverOverrides: Partial<AgentUIServer> = {},
) {
  const connectorCatalog: MockConnectorCatalog = {
    getConnectorCatalog: async () => [],
    listConnectors: async () => connectors,
    getConnector: async ({ id }) => connectors.find(item => item.id === id) ?? parallelWeb,
    getToolsByConnectorId: async () => [],
    createConnector: async () => hindsight,
    updateConnector: async () => hindsight,
    authenticateConnector: async () => ({ authorization_endpoint: '' }),
    disconnectConnector: async () => hindsight,
    ...overrides,
  };
  const server = createMockAgentUIServer({ catalog: createMockCatalog({ connectorCatalog }), ...serverOverrides });

  return render(
    <ServerProvider server={server}>
      <MemorySettings />
    </ServerProvider>,
  );
}

/**
 * A `getCapabilities` override carrying the generated SDK's normalized `memoryScreen` field. The
 * assistant runtime's narrower builder type does not declare this field yet, so the fixture widens
 * that response type without casting.
 */
type CapabilitiesResponseWithScreen = AgentBuilderCapabilitiesResponse & {
  data: AgentBuilderCapabilitiesResponse['data'] &
    Pick<TrueForgeApi.CapabilitiesData, 'memoryScreen' | 'toolOutputScreen'>;
};
type MemoryScreenStatus = TrueForgeApi.CapabilitiesData['memoryScreen'];

function capabilitiesWithScreens({
  memoryScreen,
  toolOutputScreen = { enabled: false },
}: {
  memoryScreen: MemoryScreenStatus;
  toolOutputScreen?: TrueForgeApi.ToolOutputScreenCapability;
}): Partial<AgentUIServer> {
  const response = {
    data: { sandbox: { enabled: true }, skill: { enabled: true }, memoryScreen, toolOutputScreen },
  } satisfies CapabilitiesResponseWithScreen;
  return { getCapabilities: async () => response };
}

function capabilitiesWithMemoryScreen(memoryScreen: MemoryScreenStatus): Partial<AgentUIServer> {
  return capabilitiesWithScreens({ memoryScreen });
}

/**
 * The same override for a payload whose `memory_screen` is malformed, or carries extra fields a
 * server might send (a stray `url`, an auth token). That is untyped wire data by nature, so the
 * passthrough is typed `unknown` here — still declared, still no cast — to exercise the reader's
 * tolerance and the card's "unavailable" fallback and secret-exclusion behaviour.
 */
type CapabilitiesResponseWithRawScreen = AgentBuilderCapabilitiesResponse & {
  data: AgentBuilderCapabilitiesResponse['data'] & { memory_screen?: unknown; tool_output_screen?: unknown };
};

function capabilitiesWithRawScreens({
  memory_screen,
  tool_output_screen,
}: {
  memory_screen?: unknown;
  tool_output_screen?: unknown;
}): Partial<AgentUIServer> {
  const response = {
    data: { sandbox: { enabled: true }, skill: { enabled: true }, memory_screen, tool_output_screen },
  } satisfies CapabilitiesResponseWithRawScreen;
  return { getCapabilities: async () => response };
}

function capabilitiesWithRawMemoryScreen(memory_screen: unknown): Partial<AgentUIServer> {
  return capabilitiesWithRawScreens({ memory_screen });
}

describe('MemorySettings', () => {
  // jsdom implements neither showModal nor close on HTMLDialogElement.
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reads as off with no bank configured, and offers the one action that turns it on', async () => {
    renderMemory([parallelWeb]);

    expect(await screen.findByText('Memory is off')).toBeInTheDocument();
    expect(screen.getByText('No memory bank configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect a memory bank' })).toBeInTheDocument();
    // Nothing to test or remove until a bank exists.
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
  });

  it('reads as on and names the bank once one is configured', async () => {
    renderMemory([parallelWeb, hindsightAsProvider]);

    expect(await screen.findByText('Memory is on')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: hindsight.name })).toBeInTheDocument();
    expect(screen.getByText(hindsight.url)).toBeInTheDocument();
  });

  it('shows the stored memory tuning and saves an edit with the flag resupplied', async () => {
    const provider = { ...hindsightAsProvider, memorySettings: { recallTimeoutMs: 2_500, reflectEnabled: false } };
    const updateConnector = vi.fn().mockResolvedValue(provider);
    renderMemory([provider], { updateConnector });

    const timeout = await screen.findByLabelText('Recall timeout (milliseconds)');
    // The stored values arrive one render after the form, once the provider row has been read.
    await waitFor(() => {
      expect(timeout).toHaveValue(2_500);
    });
    expect(screen.getByLabelText('Reflect layer')).toHaveValue('off');
    fireEvent.change(timeout, { target: { value: '10000' } });
    fireEvent.change(screen.getByLabelText('Reflect layer'), { target: { value: 'on' } });
    fireEvent.change(screen.getByLabelText('Reflect effort'), { target: { value: 'mid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tuning' }));

    await waitFor(() => {
      expect(updateConnector).toHaveBeenCalled();
    });
    expect(updateConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryProvider: true,
        memorySettings: { recallTimeoutMs: 10_000, reflectEnabled: true, reflectBudget: 'mid' },
      }),
    );
  });

  it('preserves stored relevance-gating fields across an unrelated tuning save', async () => {
    const provider = {
      ...hindsightAsProvider,
      memorySettings: { recallTimeoutMs: 2_500, recallMinScore: 0.6, recallMaxItems: 20, recallMaxEntities: 4 },
    };
    const updateConnector = vi.fn().mockResolvedValue(provider);
    renderMemory([provider], { updateConnector });

    const timeout = await screen.findByLabelText('Recall timeout (milliseconds)');
    await waitFor(() => {
      expect(timeout).toHaveValue(2_500);
    });
    expect(screen.getByLabelText('Recall relevance floor')).toHaveValue(0.6);
    expect(screen.getByLabelText('Recalled items kept')).toHaveValue(20);
    expect(screen.getByLabelText('Entity summaries kept')).toHaveValue(4);
    fireEvent.change(timeout, { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tuning' }));

    await waitFor(() => {
      expect(updateConnector).toHaveBeenCalled();
    });
    expect(updateConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryProvider: true,
        memorySettings: { recallTimeoutMs: 10_000, recallMinScore: 0.6, recallMaxItems: 20, recallMaxEntities: 4 },
      }),
    );
  });

  it('shows the server defaults in the tuning fields so nobody has to guess them', async () => {
    const memoryDefaults = {
      recallTimeoutMs: 6000,
      recallQueryWindow: 5,
      recallMaxItems: 50,
      recallMaxEntities: 10,
      recallMinScore: 0.5,
      curatedEnabled: true,
      curatedMaxModels: 3,
      curatedMaxTokens: 512,
      reflectEnabled: false,
      reflectBudget: 'low' as const,
      reflectMaxTokens: 512,
      reflectTimeoutMs: 8000,
    };
    const response = {
      data: { sandbox: { enabled: true }, skill: { enabled: true }, memoryDefaults },
    } satisfies AgentBuilderCapabilitiesResponse & {
      data: AgentBuilderCapabilitiesResponse['data'] & { memoryDefaults: typeof memoryDefaults };
    };
    renderMemory([hindsightAsProvider], {}, { getCapabilities: async () => response });

    const timeout = await screen.findByLabelText('Recall timeout (milliseconds)');
    await waitFor(() => {
      expect(timeout).toHaveAttribute('placeholder', '6000');
    });
    expect(screen.getByLabelText('Recall query window (messages)')).toHaveAttribute('placeholder', '5');
    expect(screen.getByRole('option', { name: 'Server default (off)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Server default (low)' })).toBeInTheDocument();
  });

  it('falls back to the plain words when the server did not report defaults', async () => {
    renderMemory([hindsightAsProvider]);

    const timeout = await screen.findByLabelText('Recall timeout (milliseconds)');
    expect(timeout).toHaveAttribute('placeholder', 'Server default');
  });

  it('keeps tuning help behind an info affordance instead of inline text', async () => {
    renderMemory([hindsightAsProvider]);

    await screen.findByLabelText('Recall timeout (milliseconds)');
    // The explanatory text lives in the tooltip, not as a visible paragraph under the field.
    expect(screen.queryByText(/Large banks search slower/)).not.toBeInTheDocument();
    const info = screen.getByRole('button', { name: 'Recall timeout (milliseconds): more info' });
    fireEvent.focus(info);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/Large banks search slower/);
  });

  it('refuses an out-of-range tuning value before any write, and clearing every field restores the defaults', async () => {
    const provider = { ...hindsightAsProvider, memorySettings: { recallTimeoutMs: 2_500 } };
    const updateConnector = vi.fn().mockResolvedValue(hindsightAsProvider);
    renderMemory([provider], { updateConnector });

    const timeout = await screen.findByLabelText('Recall timeout (milliseconds)');
    await waitFor(() => {
      expect(timeout).toHaveValue(2_500);
    });
    fireEvent.change(timeout, { target: { value: '120001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tuning' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Recall timeout (milliseconds)');
    expect(updateConnector).not.toHaveBeenCalled();

    fireEvent.change(timeout, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tuning' }));
    await waitFor(() => {
      expect(updateConnector).toHaveBeenCalled();
    });
    const [request] = updateConnector.mock.calls[0] as [Record<string, unknown>];
    expect(request['memoryProvider']).toBe(true);
    expect('memorySettings' in request).toBe(false);
  });

  it('ignores a connector that is not flagged, so an ordinary bank row does not read as memory', async () => {
    renderMemory([parallelWeb, hindsight]);

    expect(await screen.findByText('Memory is off')).toBeInTheDocument();
  });

  it('explains what memory does, and the credential trap that silently breaks it', async () => {
    renderMemory([hindsightAsProvider]);

    expect(await screen.findByRole('heading', { name: 'How memory works' })).toBeInTheDocument();
    expect(screen.getByText(/recalls relevant memories before every model call/)).toBeInTheDocument();
    expect(screen.getByText(/read tools only, loaded upfront/)).toBeInTheDocument();
    expect(screen.getByText(/aman\.memory\.recall/)).toBeInTheDocument();
    expect(screen.getByText(/HINDSIGHT_API_TENANT_API_KEY/)).toBeInTheDocument();
    // A chat that already mounted the bank cannot drop it now that it is unlisted. Stated here
    // rather than left as a control the user hunts for and never finds.
    expect(screen.getByText(/start a new chat to drop it/)).toBeInTheDocument();
  });

  it('reports a healthy bank on Test connection', async () => {
    const checkMemoryProvider = vi.fn().mockResolvedValue({ ok: true });
    renderMemory([hindsightAsProvider], { checkMemoryProvider });

    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText('Recall reached this bank. Memory is working.')).toBeInTheDocument();
    expect(checkMemoryProvider).toHaveBeenCalledWith({ id: hindsight.id });
  });

  it('reports the upstream reason when Test connection fails, rather than a generic failure', async () => {
    const checkMemoryProvider = vi.fn().mockResolvedValue({ ok: false, code: 'http_error', reason: REST_401_REASON });
    renderMemory([hindsightAsProvider], { checkMemoryProvider });

    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText(REST_401_REASON)).toBeInTheDocument();
  });

  it('creates a non-OAuth bank already flagged, so one write is validated once', async () => {
    const createConnector = vi.fn().mockResolvedValue(hindsightAsProvider);
    renderMemory([], { createConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a memory bank' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'hindsight' } });
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Long-term memory bank' } });
    fireEvent.change(screen.getByLabelText(/^URL/), { target: { value: hindsight.url } });
    // Anything but OAuth: the server can dial these on create, so the flag rides along with it.
    fireEvent.click(screen.getByLabelText('None'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(createConnector).toHaveBeenCalled();
    });
    const [request] = createConnector.mock.calls[0] as [Record<string, unknown>];
    expect(memoryProviderOf(request)).toBe(true);
    expect(request['url']).toBe(hindsight.url);
  });

  it('saves an OAuth bank unflagged, because the server cannot check a bank it cannot sign in to', async () => {
    const createConnector = vi
      .fn<(request: CreateConnectorRequest) => Promise<ConnectorBase>>()
      .mockResolvedValue(hindsightOauth);
    renderMemory([], { createConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a memory bank' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'hindsight' } });
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Long-term memory bank' } });
    fireEvent.change(screen.getByLabelText(/^URL/), { target: { value: hindsight.url } });
    // The auth type is left alone: OAuth is what the form defaults to.
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(createConnector).toHaveBeenCalled();
    });
    // A flagged create is refused by the server every time for OAuth, so the flag is not sent.
    const requests = createConnector.mock.calls.map(([request]) => request);
    expect(requests.map(memoryProviderOf)).toEqual([undefined]);
    // And the dead end is replaced by the sequence that does work.
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText(/Sign in to the bank, then turn memory on/)).toBeInTheDocument();
  });

  it('turns memory on for an OAuth bank once it is signed in', async () => {
    const createConnector = vi.fn().mockResolvedValue(hindsightOauth);
    const authenticateConnector = vi.fn().mockResolvedValue({ status: 'authenticated' });
    const getConnector = vi.fn().mockResolvedValue({ ...hindsightOauth, authenticated: true, requiresAuth: false });
    const updateConnector = vi
      .fn<(request: UpdateConnectorRequest) => Promise<ConnectorBase>>()
      .mockResolvedValue(hindsightAsProvider);
    renderMemory([], { createConnector, authenticateConnector, getConnector, updateConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a memory bank' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'hindsight' } });
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Long-term memory bank' } });
    fireEvent.change(screen.getByLabelText(/^URL/), { target: { value: hindsight.url } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    const turnOn = await screen.findByRole('button', { name: 'Turn memory on' });
    // Nothing to enable until the bank is signed in: that is what the server's check needs.
    expect(turnOn).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(turnOn).toBeEnabled();
    });
    fireEvent.click(turnOn);

    await waitFor(() => {
      expect(updateConnector).toHaveBeenCalled();
    });
    expect(authenticateConnector).toHaveBeenCalled();
    const requests = updateConnector.mock.calls.map(([request]) => request);
    expect(requests.map(memoryProviderOf)).toEqual([true]);
    expect(requests.map(request => request.id)).toEqual([hindsight.id]);
  });

  it('refuses a URL that does not name exactly one bank, before any write', async () => {
    const createConnector = vi.fn();
    renderMemory([], { createConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a memory bank' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'hindsight' } });
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Long-term memory bank' } });
    fireEvent.change(screen.getByLabelText(/^URL/), { target: { value: 'https://hindsight.example.com/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText(/single-bank MCP URL ending in \/mcp\/<bank>\//)).toBeInTheDocument();
    expect(createConnector).not.toHaveBeenCalled();
  });

  it('surfaces the upstream reason when the server refuses the bank it cannot recall from', async () => {
    const createConnector = vi.fn().mockRejectedValue({
      body: { error: { message: `memory provider check failed: ${REST_401_REASON}` } },
    });
    renderMemory([], { createConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a memory bank' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'hindsight' } });
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Long-term memory bank' } });
    fireEvent.change(screen.getByLabelText(/^URL/), { target: { value: hindsight.url } });
    // Non-OAuth, so the create itself is the write the server runs its memory check on.
    fireEvent.click(screen.getByLabelText('None'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText(/Authentication failed: Invalid API key/)).toBeInTheDocument();
  });

  it('edits without resending a key, so an untouched field keeps the stored credential', async () => {
    const updateConnector = vi.fn().mockResolvedValue(hindsightAsProvider);
    renderMemory([hindsightAsProvider], { updateConnector });

    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText(/^URL/), {
      target: { value: 'https://hindsight.example.com/mcp/other/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateConnector).toHaveBeenCalled();
    });
    const [request] = updateConnector.mock.calls[0] as [UpdateConnectorRequest];
    expect(request.url).toBe('https://hindsight.example.com/mcp/other/');
    // Still the provider, and no key is sent: the write path keeps the stored one for a blank field.
    expect(memoryProviderOf(request)).toBe(true);
    expect(Reflect.get(request.auth, 'apiKey')).toBeUndefined();
  });

  it('has no control that clears the flag and keeps the row, so a bank can never hide from Memory', async () => {
    // Typed so the recorded calls can be read without asserting their shape back.
    const updateConnector = vi
      .fn<(request: UpdateConnectorRequest) => Promise<ConnectorBase>>()
      .mockResolvedValue(hindsightAsProvider);
    const deleteConnector = vi.fn().mockResolvedValue(undefined);
    const checkMemoryProvider = vi.fn().mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderMemory([hindsightAsProvider], { updateConnector, deleteConnector, checkMemoryProvider });

    expect(await screen.findByText('Memory is on')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /turn .*off/i })).not.toBeInTheDocument();

    // Every control the section offers while a bank is configured.
    for (const control of screen.getAllByRole('button')) {
      fireEvent.click(control);
    }

    await waitFor(() => {
      expect(deleteConnector).toHaveBeenCalledWith({ id: hindsight.id });
    });
    // The flag is the only thing marking this row as the bank. A write that cleared it while
    // keeping the row would leave a row this section can no longer find and the connector picker
    // would offer again, reachable from nowhere that owns it.
    const clearedTheFlag = updateConnector.mock.calls.some(([request]) => memoryProviderOf(request) === false);
    expect(clearedTheFlag).toBe(false);
  });

  it('removes the row outright, so hiding it from the connectors list strands nothing', async () => {
    const deleteConnector = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderMemory([hindsightAsProvider], { deleteConnector });

    fireEvent.click(await screen.findByRole('button', { name: `Remove the ${hindsight.name} memory bank` }));

    await waitFor(() => {
      expect(deleteConnector).toHaveBeenCalledWith({ id: hindsight.id });
    });
  });

  it('offers no Remove when the catalog port cannot delete, and says memory cannot be turned off', async () => {
    const connectors = [hindsightAsProvider];
    // The port's `deleteConnector` is optional, so a host without one simply omits it.
    const connectorCatalog: MockConnectorCatalog = {
      getConnectorCatalog: async () => [],
      listConnectors: async () => connectors,
      getConnector: async () => hindsight,
      getToolsByConnectorId: async () => [],
      createConnector: async () => hindsight,
      updateConnector: async () => hindsight,
      authenticateConnector: async () => ({ authorization_endpoint: '' }),
      disconnectConnector: async () => hindsight,
    };
    const server = createMockAgentUIServer({ catalog: createMockCatalog({ connectorCatalog }) });
    render(
      <ServerProvider server={server}>
        <MemorySettings />
      </ServerProvider>,
    );

    expect(await screen.findByText('Memory is on')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /memory bank$/ })).not.toBeInTheDocument();
    expect(screen.getByText(/does not support removing one/)).toBeInTheDocument();
  });

  describe('recall screen status', () => {
    it('reads as unavailable, not off, with no memory_screen capability at all (older or unpatched build)', async () => {
      // This override reports no memory_screen field, like a server built before it existed. The
      // card must not claim the defense is off without evidence — it shows "status unavailable".
      renderMemory([parallelWeb], {}, capabilitiesWithRawScreens({}));

      expect(await screen.findByText('Recall screening status unavailable')).toBeInTheDocument();
      expect(screen.queryByText('Recall screening is off')).not.toBeInTheDocument();
      expect(screen.getByText(/Screens what recall is about to inject/)).toBeInTheDocument();
      // Nothing to show for a screen whose status was never reported.
      expect(screen.queryByText('Threshold')).not.toBeInTheDocument();
      expect(screen.getByText(/MEMORY_SCREEN_ENABLED/)).toBeInTheDocument();
      expect(screen.getByText('Tool-output screening status unavailable')).toBeInTheDocument();
    });

    it('reads as unavailable when the memory_screen payload is malformed', async () => {
      // `enabled` missing → the reader returns null → still "unavailable", never a definitive "off".
      renderMemory([parallelWeb], {}, capabilitiesWithRawMemoryScreen({ threshold: 0.5 }));

      expect(await screen.findByText('Recall screening status unavailable')).toBeInTheDocument();
      expect(screen.queryByText('Recall screening is off')).not.toBeInTheDocument();
    });

    it('reads as off when the server reports MEMORY_SCREEN_ENABLED false', async () => {
      renderMemory([parallelWeb], {}, capabilitiesWithMemoryScreen({ enabled: false, configured: true }));

      expect(await screen.findByText('Recall screening is off')).toBeInTheDocument();
      expect(screen.queryByText('Recall screening status unavailable')).not.toBeInTheDocument();
      expect(screen.queryByText('Threshold')).not.toBeInTheDocument();
    });

    it('reads as on and shows the threshold the server reports', async () => {
      renderMemory(
        [parallelWeb],
        {},
        capabilitiesWithMemoryScreen({ enabled: true, configured: true, threshold: 0.62 }),
      );

      expect(await screen.findByText('Recall screening is on')).toBeInTheDocument();
      expect(screen.getByText('Threshold')).toBeInTheDocument();
      expect(screen.getByText('0.62')).toBeInTheDocument();
    });

    it('shows live tool-output screening status under Memory', async () => {
      renderMemory(
        [parallelWeb],
        {},
        capabilitiesWithScreens({
          memoryScreen: { enabled: false, configured: true },
          toolOutputScreen: { enabled: true, threshold: 0.62, timeoutMs: 2250 },
        }),
      );

      expect(await screen.findByText('Tool-output screening is on')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Live tool-output screen' })).toBeInTheDocument();
      expect(screen.getByText(/open-world tool results/)).toBeInTheDocument();
      expect(screen.getByText('2250 ms')).toBeInTheDocument();
      expect(screen.getByText(/TOOL_OUTPUT_SCREEN_ENABLED/)).toBeInTheDocument();
    });

    it('reads live tool-output screening as unavailable when the capability is malformed', async () => {
      renderMemory(
        [parallelWeb],
        {},
        capabilitiesWithRawScreens({ memory_screen: { enabled: false }, tool_output_screen: { threshold: 0.5 } }),
      );

      expect(await screen.findByText('Tool-output screening status unavailable')).toBeInTheDocument();
      expect(screen.queryByText('Tool-output screening is off')).not.toBeInTheDocument();
    });

    it('never renders the classifier url or an auth token, even if either rode along in the payload', async () => {
      // The wire contract omits both, but an older server or a misconfigured one could still send
      // them. The card must never surface internal infrastructure or a secret regardless.
      renderMemory(
        [parallelWeb],
        {},
        capabilitiesWithRawMemoryScreen({
          enabled: true,
          url: 'https://screen.internal:8443',
          threshold: 0.5,
          authToken: 'super-secret-classifier-token',
        }),
      );

      expect(await screen.findByText('Recall screening is on')).toBeInTheDocument();
      expect(screen.getByText('Tool-output screening status unavailable')).toBeInTheDocument();
      expect(screen.queryByText('https://screen.internal:8443')).not.toBeInTheDocument();
      expect(screen.queryByText(/super-secret-classifier-token/)).not.toBeInTheDocument();
    });

    it('offers no control to change it, since it is configured through the environment', async () => {
      renderMemory(
        [parallelWeb],
        {},
        capabilitiesWithScreens({
          memoryScreen: { enabled: true, configured: true, threshold: 0.5 },
          toolOutputScreen: { enabled: true, threshold: 0.5 },
        }),
      );

      await screen.findByText('Recall screening is on');
      expect(screen.queryByRole('button', { name: /recall screen/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /tool-output screen/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: /classifier|threshold/i })).not.toBeInTheDocument();
    });
  });

  describe('recall screen switch', () => {
    const SWITCH_NAME = 'Screen recalled memories with Prompt Guard';

    it('is not shown until a memory bank is configured', async () => {
      renderMemory([parallelWeb], {}, capabilitiesWithRawMemoryScreen({ enabled: true, configured: true }));

      await screen.findByText('Memory is off');
      expect(screen.queryByRole('switch', { name: SWITCH_NAME })).not.toBeInTheDocument();
    });

    it('shows checked and enabled when the bank has explicitly turned screening on', async () => {
      const provider = { ...hindsightAsProvider, memorySettings: { screen_enabled: true } };
      renderMemory(
        [provider],
        {},
        capabilitiesWithRawMemoryScreen({ enabled: true, configured: true, threshold: 0.5 }),
      );

      const toggle = await screen.findByRole('switch', { name: SWITCH_NAME });
      expect(toggle).toBeChecked();
      expect(toggle).toBeEnabled();
      expect(
        screen.getByText(/memories that came from tools, documents or email are checked for prompt injection/i),
      ).toBeInTheDocument();
    });

    it('shows unchecked when the bank has explicitly turned screening off, even though the server default is on', async () => {
      const provider = { ...hindsightAsProvider, memorySettings: { screen_enabled: false } };
      renderMemory([provider], {}, capabilitiesWithRawMemoryScreen({ enabled: false, configured: true }));

      const toggle = await screen.findByRole('switch', { name: SWITCH_NAME });
      expect(toggle).not.toBeChecked();
    });

    it('falls back to the effective server state when the bank has not set the switch itself', async () => {
      renderMemory(
        [hindsightAsProvider],
        {},
        capabilitiesWithRawMemoryScreen({ enabled: true, configured: true, threshold: 0.5 }),
      );

      const toggle = await screen.findByRole('switch', { name: SWITCH_NAME });
      expect(toggle).toBeChecked();
    });

    it('disables the switch with the server reason when no screening service is configured', async () => {
      renderMemory(
        [hindsightAsProvider],
        {},
        capabilitiesWithRawMemoryScreen({
          enabled: false,
          configured: false,
          reason: 'No screening service configured',
        }),
      );

      const toggle = await screen.findByRole('switch', { name: SWITCH_NAME });
      expect(toggle).toBeDisabled();
      expect(screen.getByText('No screening service configured')).toBeInTheDocument();
    });

    it('writes the setting immediately when toggled, resupplying the rest of the stored settings', async () => {
      const provider = { ...hindsightAsProvider, memorySettings: { screen_enabled: false, recallTimeoutMs: 2_500 } };
      const updateConnector = vi.fn().mockResolvedValue(provider);
      renderMemory(
        [provider],
        { updateConnector },
        capabilitiesWithRawMemoryScreen({ enabled: false, configured: true }),
      );

      const toggle = await screen.findByRole('switch', { name: SWITCH_NAME });
      fireEvent.click(toggle);

      await waitFor(() => {
        expect(updateConnector).toHaveBeenCalled();
      });
      expect(updateConnector).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryProvider: true,
          memorySettings: { screen_enabled: true, recallTimeoutMs: 2_500 },
        }),
      );
    });
  });
});
