// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConnectorSettings from '@/containers/SettingsBuilder/ConnectorSettings.js';
import type { ConnectorWithMemoryProvider } from '@/containers/SettingsBuilder/memoryProvider.js';
import type { ConnectorChecks, ConnectorConnectionTest } from '@/server/connectorChecks.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { AgentSpec, CatalogServer, ConnectorBase } from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

// jsdom does not implement HTMLDialogElement.showModal()/close(); CenteredModal (used for the
// delete-connector confirmation) calls both, so it needs the same minimal polyfill the
// CenteredModal suite uses, toggling the `open` attribute the dialog UA stylesheet keys off.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
const showModal = vi.fn(function showModal(this: HTMLDialogElement) {
  this.open = true;
});
const close = vi.fn(function close(this: HTMLDialogElement) {
  this.open = false;
  this.dispatchEvent(new Event('close'));
});

beforeEach(() => {
  showModal.mockClear();
  close.mockClear();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close });
});

afterEach(() => {
  if (originalShowModal === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  } else {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  }
  if (originalClose === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  } else {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  }
});

let agentSpec: AgentSpec;
let mutableChat = true;
const updateAgentSpec = vi.fn();
const disconnectConnector = vi.fn(async ({ id }: { id: string }) => (id === parallelWeb.id ? parallelWeb : github));

const parallelWeb: ConnectorBase = {
  id: 'parallel-web',
  name: 'parallel-web',
  description: 'Search the web',
  url: 'https://search.parallel.ai/mcp',
  authenticated: true,
  requiresAuth: false,
  auth: { type: 'none' },
};

const github: ConnectorBase = {
  id: 'github',
  name: 'github',
  description: 'Work with repositories',
  url: 'https://api.githubcopilot.com/mcp',
  authenticated: true,
  requiresAuth: false,
  auth: { type: 'none' },
};

const configuredConnectors = [parallelWeb, github];

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

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec }),
  useTrueFoundryUpdateAgentSpec: () => updateAgentSpec,
}));

vi.mock('@/server/ShellModeContext.js', () => ({
  shellIsMutable: () => mutableChat,
  useShellMode: () => ({
    mode: { status: 'active', isMutable: mutableChat },
    pendingSessionId: null,
  }),
}));

/**
 * Neither check is on the runtime's connector port: the Harness adapter adds both, and the
 * component reads them through the same optional widening.
 */
type MockConnectorCatalog = CatalogServer['connectorCatalog'] & Partial<ConnectorChecks>;

function renderSettings(
  connectors: ConnectorBase[] = configuredConnectors,
  overrides: Partial<MockConnectorCatalog> = {},
) {
  const connectorCatalog: MockConnectorCatalog = {
    getConnectorCatalog: async () => [],
    listConnectors: async () => connectors,
    getConnector: async ({ id }) => connectors.find(item => item.id === id) ?? parallelWeb,
    getToolsByConnectorId: async () => [],
    createConnector: async () => parallelWeb,
    updateConnector: async () => parallelWeb,
    authenticateConnector: async () => ({ authorization_endpoint: '' }),
    disconnectConnector,
    ...overrides,
  };
  const server = createMockAgentUIServer({
    catalog: createMockCatalog({ connectorCatalog }),
  });

  return render(
    <ServerProvider server={server}>
      <ConnectorSettings />
    </ServerProvider>,
  );
}

describe('ConnectorSettings chat enablement', () => {
  beforeEach(() => {
    mutableChat = true;
    agentSpec = {
      model: { name: 'local/qwen36-fp8' },
      mcpServers: [{ id: github.id, name: github.name }],
    };
    updateAgentSpec.mockReset();
    disconnectConnector.mockClear();
  });

  it('does not list the memory bank, which Settings → Memory owns, while listing ordinary connectors', async () => {
    renderSettings([parallelWeb, hindsightAsProvider]);

    expect(await screen.findByText(parallelWeb.name)).toBeInTheDocument();
    // Stored as an MCP server row, but not a connector a user attaches to anything.
    expect(screen.queryByText(hindsightAsProvider.name)).not.toBeInTheDocument();
    // Its explanation moved with it: nothing about memory is left on this page.
    expect(screen.queryByText(/recalls relevant memories before every model call/)).not.toBeInTheDocument();
    expect(screen.queryByText(/HINDSIGHT_API_TENANT_API_KEY/)).not.toBeInTheDocument();
  });

  it('still lists a bank that is not flagged as the memory provider, since it is then an ordinary connector', async () => {
    renderSettings([parallelWeb, hindsight]);

    expect(await screen.findByText(hindsight.name)).toBeInTheDocument();
  });

  it('reports the tool count when a connection test reaches the connector', async () => {
    const testConnector = vi.fn().mockResolvedValue({ ok: true, toolNames: ['search', 'fetch', 'summarize'] });
    renderSettings([parallelWeb], { testConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Test the connection for parallel-web' }));

    expect(await screen.findByText('Connected. 3 tools available.')).toBeInTheDocument();
    expect(testConnector).toHaveBeenCalledWith({ id: 'parallel-web' });
  });

  it('reports a connector that answers with no tools rather than calling it healthy', async () => {
    const testConnector = vi.fn().mockResolvedValue({ ok: true, toolNames: [] });
    renderSettings([parallelWeb], { testConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Test the connection for parallel-web' }));

    expect(await screen.findByText('Connected, but this connector exposes no tools.')).toBeInTheDocument();
  });

  it('shows the API message and the credential fix when a connection test needs authentication', async () => {
    const testConnector = vi.fn().mockResolvedValue({
      ok: false,
      kind: 'auth_required',
      message: 'MCP server "parallel-web" requires authentication',
    });
    renderSettings([parallelWeb], { testConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Test the connection for parallel-web' }));

    expect(
      await screen.findByText('MCP server "parallel-web" requires authentication. Reconnect it or replace its key.'),
    ).toBeInTheDocument();
  });

  it('shows the API message and the endpoint fix when a connection test cannot reach the connector', async () => {
    const testConnector = vi.fn().mockResolvedValue({
      ok: false,
      kind: 'unreachable',
      message: 'connect ECONNREFUSED 127.0.0.1:9999',
    });
    renderSettings([parallelWeb], { testConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Test the connection for parallel-web' }));

    expect(
      await screen.findByText('connect ECONNREFUSED 127.0.0.1:9999. Check the URL and that the endpoint is reachable.'),
    ).toBeInTheDocument();
  });

  it('disables the connection test while one is in flight so it cannot be fired twice', async () => {
    let release: (result: ConnectorConnectionTest) => void = () => {};
    const testConnector = vi.fn(
      async () =>
        new Promise<ConnectorConnectionTest>(resolve => {
          release = resolve;
        }),
    );
    renderSettings([parallelWeb], { testConnector });

    const button = await screen.findByRole('button', { name: 'Test the connection for parallel-web' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(button).toBeDisabled();
    });
    expect(testConnector).toHaveBeenCalledTimes(1);

    release({ ok: true, toolNames: ['search'] });
    expect(await screen.findByText('Connected. 1 tool available.')).toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(testConnector).toHaveBeenCalledTimes(1);
  });

  it('keeps a connector’s test button disabled by its own pending test, not by whichever test started most recently', async () => {
    const releaseById = new Map<string, (result: ConnectorConnectionTest) => void>();
    const testConnector = vi.fn(
      async ({ id }: { id: string }) =>
        new Promise<ConnectorConnectionTest>(resolve => {
          releaseById.set(id, resolve);
        }),
    );
    renderSettings([parallelWeb, github], { testConnector });

    const parallelWebButton = await screen.findByRole('button', { name: 'Test the connection for parallel-web' });
    const githubButton = await screen.findByRole('button', { name: 'Test the connection for github' });

    fireEvent.click(parallelWebButton);
    await waitFor(() => {
      expect(parallelWebButton).toBeDisabled();
    });

    // Starting a second connector's test must not read as "nothing in flight" for the first one:
    // that is what let a second, overlapping test be fired for it while the first was still
    // outstanding, racing the two responses to write the same map entry.
    fireEvent.click(githubButton);
    await waitFor(() => {
      expect(githubButton).toBeDisabled();
    });
    expect(parallelWebButton).toBeDisabled();
    expect(testConnector).toHaveBeenCalledTimes(2);

    releaseById.get(parallelWeb.id)?.({ ok: true, toolNames: ['search'] });
    releaseById.get(github.id)?.({ ok: true, toolNames: ['repo'] });

    await waitFor(() => {
      expect(parallelWebButton).toBeEnabled();
      expect(githubButton).toBeEnabled();
    });
    expect(testConnector).toHaveBeenCalledTimes(2);
  });

  // `authenticated` only means "has valid credentials" (the server never dials the connector's
  // endpoint to set it), so it must not read as "reachable" until a connection test actually says
  // so.
  it('shows an unverified badge, not a false "Connected", before any connection test has run', async () => {
    const testConnector = vi.fn().mockResolvedValue({ ok: true, toolNames: [] });
    renderSettings([parallelWeb], { testConnector });

    await screen.findByRole('button', { name: 'Test the connection for parallel-web' });

    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
    expect(testConnector).not.toHaveBeenCalled();
  });

  it('shows Connected only once a connection test actually succeeds', async () => {
    const testConnector = vi.fn().mockResolvedValue({ ok: true, toolNames: ['search'] });
    renderSettings([parallelWeb], { testConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Test the connection for parallel-web' }));

    await screen.findByText('Connected. 1 tool available.');
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('reflects a failed connection test as failed rather than leaving the badge green', async () => {
    const testConnector = vi.fn().mockResolvedValue({
      ok: false,
      kind: 'unreachable',
      message: 'getaddrinfo ENOTFOUND does-not-exist.example',
    });
    renderSettings([parallelWeb], { testConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Test the connection for parallel-web' }));

    await screen.findByText(/getaddrinfo ENOTFOUND/);
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('falls back to the credential-based status when the host offers no connection test at all', async () => {
    // No `testConnector` override: `hasConnectorConnectionTest` reads it as absent, same as a
    // host whose catalog never implements the check.
    renderSettings([parallelWeb]);

    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });
});

// Deleting a connector must go through a non-blocking in-app confirmation, never a native
// window.confirm() that pauses the whole tab until dismissed.
describe('ConnectorSettings connector deletion', () => {
  beforeEach(() => {
    mutableChat = true;
    agentSpec = { model: { name: 'local/qwen36-fp8' }, mcpServers: [] };
    updateAgentSpec.mockReset();
  });

  it('confirms deletion through an in-app dialog rather than a blocking window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const deleteConnector = vi.fn().mockResolvedValue(undefined);
    renderSettings([parallelWeb], { deleteConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete the parallel-web connector' }));
    expect(confirmSpy).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(deleteConnector).toHaveBeenCalledWith({ id: parallelWeb.id });
    });
    confirmSpy.mockRestore();
  });

  it('drops the deleted connector from the active chat spec before deleting it', async () => {
    agentSpec = {
      model: { name: 'local/qwen36-fp8' },
      mcpServers: [
        { id: parallelWeb.id, name: parallelWeb.name },
        { id: github.id, name: github.name },
      ],
    };
    const deleteConnector = vi.fn().mockResolvedValue(undefined);
    renderSettings([parallelWeb, github], { deleteConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete the parallel-web connector' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(deleteConnector).toHaveBeenCalledWith({ id: parallelWeb.id });
    });
    expect(updateAgentSpec).toHaveBeenCalledWith({ mcpServers: [{ id: github.id, name: github.name }] });
    const [specUpdateOrder] = updateAgentSpec.mock.invocationCallOrder;
    const [deleteOrder] = deleteConnector.mock.invocationCallOrder;
    expect(specUpdateOrder).toBeLessThan(deleteOrder ?? Number.NEGATIVE_INFINITY);
  });

  it('deletes the connector without touching the spec of a chat that cannot be edited', async () => {
    mutableChat = false;
    agentSpec = {
      model: { name: 'local/qwen36-fp8' },
      mcpServers: [
        { id: parallelWeb.id, name: parallelWeb.name },
        { id: github.id, name: github.name },
      ],
    };
    const deleteConnector = vi.fn().mockResolvedValue(undefined);
    renderSettings([parallelWeb, github], { deleteConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete the parallel-web connector' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(deleteConnector).toHaveBeenCalledWith({ id: parallelWeb.id });
    });
    expect(updateAgentSpec).not.toHaveBeenCalled();
  });

  it('does not delete the connector when the confirmation dialog is cancelled', async () => {
    const deleteConnector = vi.fn().mockResolvedValue(undefined);
    renderSettings([parallelWeb], { deleteConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete the parallel-web connector' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(deleteConnector).not.toHaveBeenCalled();
    expect(screen.getByText('parallel-web')).toBeInTheDocument();
  });

  it('discards a connection test that resolves after its connector was deleted, so it cannot leak into a later connector added with the same id', async () => {
    let releaseTest: (result: ConnectorConnectionTest) => void = () => {};
    const testConnector = vi.fn(
      async () =>
        new Promise<ConnectorConnectionTest>(resolve => {
          releaseTest = resolve;
        }),
    );
    const deleteConnector = vi.fn().mockResolvedValue(undefined);
    const createConnector = vi.fn().mockResolvedValue(parallelWeb);
    const listConnectors = vi
      .fn()
      .mockResolvedValueOnce([parallelWeb]) // initial mount
      .mockResolvedValueOnce([]) // right after delete
      .mockResolvedValue([parallelWeb]); // once it is added back under the same id
    const parallelWebCatalogEntry = {
      id: parallelWeb.id,
      name: parallelWeb.name,
      description: parallelWeb.description,
      url: parallelWeb.url,
      auth: { type: 'none' as const },
    };

    renderSettings([parallelWeb], {
      testConnector,
      deleteConnector,
      createConnector,
      listConnectors,
      getConnectorCatalog: async () => [parallelWebCatalogEntry],
    });

    // Start a connection test for parallel-web and leave it unresolved.
    fireEvent.click(await screen.findByRole('button', { name: 'Test the connection for parallel-web' }));
    expect(testConnector).toHaveBeenCalledTimes(1);

    // Delete it while that test is still outstanding.
    fireEvent.click(screen.getByRole('button', { name: 'Delete the parallel-web connector' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(deleteConnector).toHaveBeenCalledWith({ id: parallelWeb.id });
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Delete the parallel-web connector' })).not.toBeInTheDocument();
    });

    // Add a connector back under the exact same id.
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      expect(createConnector).toHaveBeenCalled();
    });
    await screen.findByText('parallel-web');

    // The deleted row's test now answers. It must not write a result for the connector that
    // now occupies this id.
    releaseTest({ ok: true, toolNames: ['search'] });
    await waitFor(() => {
      expect(testConnector).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });
});

// A connection-test result only speaks to the credentials it was run against. Anything that
// changes those credentials — a disconnect or an OAuth reconnect — must retire it, or a
// disconnected/reauthenticated connector can keep showing a result obtained under the old ones.
describe('ConnectorSettings connection status invalidation on auth changes', () => {
  const oauthConnector: ConnectorBase = {
    id: 'oauth-connector',
    name: 'oauth-connector',
    description: 'OAuth-based connector',
    url: 'https://oauth.example.com/mcp',
    authenticated: true,
    requiresAuth: false,
    auth: { type: 'dcr' },
  };

  beforeEach(() => {
    mutableChat = true;
    agentSpec = { model: { name: 'local/qwen36-fp8' }, mcpServers: [] };
    updateAgentSpec.mockReset();
  });

  it('clears a stale "Connected" result once the connector is disconnected', async () => {
    const testConnector = vi.fn().mockResolvedValue({ ok: true, toolNames: ['search'] });
    const disconnectConnectorMock = vi.fn().mockResolvedValue(oauthConnector);
    renderSettings([oauthConnector], { testConnector, disconnectConnector: disconnectConnectorMock });

    fireEvent.click(await screen.findByRole('button', { name: 'Test the connection for oauth-connector' }));
    await screen.findByText('Connected. 1 tool available.');
    expect(screen.getByText('Connected')).toBeInTheDocument();

    // Into the connector's own page, then disconnect it.
    fireEvent.click(screen.getByText('oauth-connector'));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));

    await waitFor(() => {
      expect(disconnectConnectorMock).toHaveBeenCalledWith({ id: oauthConnector.id });
    });

    // Back on the list: the test result from before disconnecting must not survive it.
    expect(await screen.findByText('oauth-connector')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('clears a stale "Connected" result once the connector reconnects via OAuth', async () => {
    const needsAuth: ConnectorBase = { ...oauthConnector, authenticated: false, requiresAuth: true };
    const reconnected: ConnectorBase = { ...oauthConnector, authenticated: true, requiresAuth: false };
    const testConnector = vi.fn().mockResolvedValue({ ok: true, toolNames: ['search'] });
    const authenticateConnector = vi.fn().mockResolvedValue({ status: 'AUTHENTICATED' });
    const getConnector = vi.fn().mockResolvedValue(reconnected);
    renderSettings([needsAuth], { testConnector, authenticateConnector, getConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Test the connection for oauth-connector' }));
    await screen.findByText('Connected. 1 tool available.');
    expect(screen.getByText('Connected')).toBeInTheDocument();

    // Into the connector's own page, then reconnect it.
    fireEvent.click(screen.getByText('oauth-connector'));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(getConnector).toHaveBeenCalledWith({ id: oauthConnector.id });
    });

    // Back on the list: the test result obtained under the credentials before this reconnect
    // must not survive it.
    fireEvent.click(screen.getByRole('button', { name: 'Connectors' }));
    expect(await screen.findByText('oauth-connector')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });
});

// The row-level Edit control opens the same AddMcpServerForm used elsewhere, seeded from the
// connector being edited, and replaces the old auth-only "Replace Key" flow entirely.
describe('ConnectorSettings edit flow', () => {
  beforeEach(() => {
    mutableChat = true;
    agentSpec = { model: { name: 'local/qwen36-fp8' }, mcpServers: [] };
    updateAgentSpec.mockReset();
  });

  it('opens the shared form for every configured connector and updates its auth', async () => {
    const connector: ConnectorBase = {
      id: 'custom-mcp',
      name: 'Custom MCP',
      description: 'Custom tools',
      url: 'https://mcp.example.com/mcp',
      authenticated: true,
      requiresAuth: false,
      auth: { type: 'header', headerName: 'X-API-Key' },
    };
    const updateConnector = vi.fn(async () => ({ ...connector, auth: { type: 'none' } }) satisfies ConnectorBase);
    renderSettings([connector], { updateConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(screen.queryByRole('button', { name: 'Replace Key' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Edit MCP server' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/)).toHaveValue(connector.name);

    fireEvent.click(screen.getByRole('radio', { name: 'None' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateConnector).toHaveBeenCalledWith({
        id: connector.id,
        name: connector.name,
        description: connector.description,
        url: connector.url,
        auth: { type: 'none' },
      });
    });
  });
});

describe('ConnectorSettings web search provider role', () => {
  const finder: ConnectorBase = {
    id: 'finder',
    name: 'finder',
    description: 'Searches the web',
    url: 'https://finder.example/mcp',
    authenticated: true,
    requiresAuth: false,
    auth: { type: 'none' },
  };
  const finderAsProvider: ConnectorBase & { searchProvider: true } = { ...finder, searchProvider: true };
  const parallelPreset = {
    id: 'parallel-web',
    name: 'parallel-web',
    description: 'Search the web',
    url: 'https://search.parallel.ai/mcp',
    auth: { type: 'none' as const },
    searchProvider: true,
  };

  beforeEach(() => {
    mutableChat = true;
    agentSpec = { model: { name: 'local/qwen36-fp8' }, mcpServers: [] };
    updateAgentSpec.mockReset();
  });

  it('marks the connector that holds the role', async () => {
    renderSettings([finderAsProvider, github]);
    expect(await screen.findByText('Search provider')).toBeInTheDocument();
    expect(screen.getAllByText('Search provider')).toHaveLength(1);
  });

  it('makes a flagged preset the search provider when nobody holds the role yet', async () => {
    const createConnector = vi.fn(async () => finder);
    renderSettings([github], { getConnectorCatalog: async () => [parallelPreset], createConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(createConnector).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'parallel-web', searchProvider: true }),
      );
    });
  });

  it('adds a flagged preset as an ordinary connector when another connector already holds the role', async () => {
    const createConnector = vi.fn(async () => finder);
    renderSettings([finderAsProvider], { getConnectorCatalog: async () => [parallelPreset], createConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(createConnector).toHaveBeenCalledTimes(1);
    });
    expect(createConnector).toHaveBeenCalledWith(expect.not.objectContaining({ searchProvider: true }));
  });

  it('keeps the role when the holder is edited, since the update replaces the whole manifest', async () => {
    const updateConnector = vi.fn(async () => finderAsProvider);
    renderSettings([finderAsProvider], { updateConnector });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateConnector).toHaveBeenCalledWith(expect.objectContaining({ id: 'finder', searchProvider: true }));
    });
  });
});
