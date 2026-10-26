// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ScheduleFormDrawer } from '@/atoms/schedules/ScheduleFormDrawer.js';
import { ToasterProvider } from '@/containers/ToasterContainer.js';
import type {
  ScheduleTools,
  ScheduleToolsCatalog,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/scheduleToolsCatalog.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider } from '@/server/ShellModeContext.js';
import type { ConnectorBase, Schedule, ScheduleServer } from '@/server/types.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const calendarConnector: ConnectorBase = {
  id: 'calendar',
  name: 'calendar',
  description: '',
  url: 'https://example.com',
  auth: { type: 'none' },
  requiresAuth: false,
  authenticated: true,
};

const schedule: Schedule = {
  id: 'sched-1',
  name: 'morning-brief',
  agentId: 'assistant-0123',
  agentName: 'assistant-0123',
  runsAs: 'Zara',
  task: 'Brief me',
  cron: '0 8 * * *',
  timezone: 'UTC',
  status: 'active',
  lastRunAt: null,
};

const ownTools: ScheduleTools = {
  source: 'schedule',
  agentName: 'assistant-0123',
  connectors: [],
  skills: [],
  sandboxEnabled: false,
};

function renderEdit(input: { port: ScheduleToolsCatalog; onOpenChange?: () => void; target?: Schedule }) {
  const schedules: ScheduleServer = {
    listSchedules: vi.fn(async () => ({ data: [] })),
    getSchedule: vi.fn(),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    listScheduleRuns: vi.fn(async () => []),
    createScheduleRun: vi.fn(),
  };
  const agentServer = createMockAgentUIServer({
    catalog: createMockCatalog({
      connectorCatalog: {
        getConnectorCatalog: async () => [],
        listConnectors: async () => [calendarConnector],
        getConnector: async () => calendarConnector,
        getToolsByConnectorId: async () => [],
        createConnector: vi.fn(),
        updateConnector: vi.fn(),
        authenticateConnector: vi.fn(async () => ({ status: 'AUTHENTICATED' })),
        disconnectConnector: vi.fn(),
      },
    }),
    getMcp: vi.fn(async () => [{ id: 'calendar', name: 'calendar', authenticated: true }]),
  });
  const server = { ...agentServer, schedules, scheduleTools: input.port };
  return render(
    <SlotsProvider>
      <ToasterProvider>
        <ServerProvider server={server}>
          <ShellModeProvider>
            <ScheduleFormDrawer
              open
              mode="edit"
              schedule={input.target ?? schedule}
              onOpenChange={input.onOpenChange ?? (() => undefined)}
            />
          </ShellModeProvider>
        </ServerProvider>
      </ToasterProvider>
    </SlotsProvider>,
  );
}

describe('the Tools section of a schedule', () => {
  it("shows what the schedule runs with and saves the person's change", async () => {
    const port: ScheduleToolsCatalog = {
      getScheduleTools: vi.fn(async () => ownTools),
      setScheduleTools: vi.fn(async ({ tools }) => ({ ...ownTools, ...tools })),
    };
    renderEdit({ port });

    expect(await screen.findByText('Tools')).toBeInTheDocument();
    expect(port.getScheduleTools).toHaveBeenCalledWith('sched-1');
    const save = await screen.findByRole('button', { name: 'Save tools' });
    expect(save).toBeDisabled();

    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /calendar/i }));
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(port.setScheduleTools).toHaveBeenCalledWith({
        scheduleId: 'sched-1',
        tools: { connectors: ['calendar'], skills: [], sandboxEnabled: false },
      }),
    );
    expect(await screen.findByText('Saved. The next run uses these tools.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save tools' })).toBeDisabled();
  });

  it('shows the tools it already has as selected', async () => {
    const port: ScheduleToolsCatalog = {
      getScheduleTools: vi.fn(async () => ({ ...ownTools, connectors: ['calendar'] })),
      setScheduleTools: vi.fn(),
    };
    renderEdit({ port });
    const row = await screen.findByRole('menuitemcheckbox', { name: /calendar/i });
    expect(row).toHaveAttribute('aria-checked', 'true');
  });

  it('says what to do when the tools cannot be saved', async () => {
    const port: ScheduleToolsCatalog = {
      getScheduleTools: vi.fn(async () => ownTools),
      setScheduleTools: vi.fn(async () => {
        throw new Error('Skills need the sandbox. Turn the sandbox on or remove the skills.');
      }),
    };
    renderEdit({ port });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /calendar/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save tools' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Skills need the sandbox. Turn the sandbox on or remove the skills.',
    );
  });

  it('says where the tools come from for a schedule that runs as a saved agent, and links to it', async () => {
    const port: ScheduleToolsCatalog = {
      getScheduleTools: vi.fn(async () => ({
        source: 'saved_agent' as const,
        agentName: 'reporter',
        connectors: ['calendar'],
        skills: [],
        sandboxEnabled: true,
      })),
      setScheduleTools: vi.fn(),
    };
    const onOpenChange = vi.fn();
    renderEdit({
      port,
      onOpenChange,
      target: { ...schedule, agentId: 'reporter', agentName: 'reporter', runsAs: 'reporter' },
    });

    expect(
      await screen.findByText(
        'The tools of this schedule come from the agent reporter. To change them, change that agent.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('calendar')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save tools' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open reporter' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('leaves the section out on a server without the schedule tools', async () => {
    const schedules: ScheduleServer = {
      listSchedules: vi.fn(async () => ({ data: [] })),
      getSchedule: vi.fn(),
      createSchedule: vi.fn(),
      updateSchedule: vi.fn(),
      deleteSchedule: vi.fn(),
      listScheduleRuns: vi.fn(async () => []),
      createScheduleRun: vi.fn(),
    };
    render(
      <SlotsProvider>
        <ToasterProvider>
          <ServerProvider server={{ ...createMockAgentUIServer(), schedules }}>
            <ScheduleFormDrawer open mode="edit" schedule={schedule} onOpenChange={() => undefined} />
          </ServerProvider>
        </ToasterProvider>
      </SlotsProvider>,
    );
    expect(await screen.findByText('Runs as')).toBeInTheDocument();
    expect(screen.queryByText('Tools')).not.toBeInTheDocument();
  });
});
