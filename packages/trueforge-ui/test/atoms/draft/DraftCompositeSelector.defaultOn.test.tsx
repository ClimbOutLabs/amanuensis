// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftCatalogProvider } from '@/atoms/draft/DraftCatalogProvider.js';
import { DraftCompositeSelector } from '@/atoms/draft/DraftCompositeSelector.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { AgentSpec } from '@/server/types.js';
import { connectorOffKey } from '@truefoundry/trueforge-core/core/connectors/chatConnectorChoice';
import { createMockAgentUIServer } from '../../server/mockServer.js';

let agentSpec: AgentSpec;
let draftSessionId: string | undefined;
const updateAgentSpec = vi.fn();

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec, draftSessionId }),
  useTrueFoundryUpdateAgentSpec: () => updateAgentSpec,
}));

vi.mock('@/server/ShellModeContext.js', () => ({
  useOptionalShellMode: () => null,
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const SEARCH = { id: 'parallel-web', name: 'parallel-web', authenticated: true, searchProvider: true };
const EMAIL = { id: 'Email', name: 'Email', authenticated: true };
const CALENDAR = { id: 'Calendar', name: 'Calendar', authenticated: true };
const GITHUB = { id: 'github', name: 'github', authenticated: true };

function sessionRecord(id: string, metadata: Record<string, string>) {
  return {
    id,
    isMutable: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    metadata,
  };
}

/** A session record that keeps what the picker writes, so a remount can read it back. */
function fakeSessions(initialMetadata: Record<string, string>) {
  const stored = { metadata: initialMetadata };
  const updateSession = vi.fn(async (request: { sessionId: string; metadata?: Record<string, string> }) => {
    if (request.metadata !== undefined) stored.metadata = request.metadata;
    return sessionRecord(request.sessionId, stored.metadata);
  });
  const getSession = vi.fn(async ({ sessionId }: { sessionId: string }) => sessionRecord(sessionId, stored.metadata));
  return { stored, updateSession, getSession };
}

function renderPicker({
  setUp,
  sessions = fakeSessions({}),
}: {
  setUp: { id: string; name: string; authenticated: boolean; searchProvider?: boolean }[];
  sessions?: ReturnType<typeof fakeSessions>;
}) {
  const server = createMockAgentUIServer({
    getCapabilities: async () => ({ data: { sandbox: { enabled: true }, skill: { enabled: true } } }),
    getModels: async () => [],
    getSkills: async () => [],
    getMcp: async () => setUp,
    getSession: sessions.getSession,
    updateSession: sessions.updateSession,
  });
  const view = render(
    <ServerProvider server={server}>
      <DraftCatalogProvider>
        <DraftCompositeSelector />
      </DraftCatalogProvider>
    </ServerProvider>,
  );
  return { view, sessions };
}

async function openConnectors() {
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add-ons' }));
  return screen.findByRole('menuitemcheckbox', { name: /Email/ });
}

function row(name: RegExp) {
  return screen.getByRole('menuitemcheckbox', { name });
}

describe('connectors that are on by default in the composer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    agentSpec = { model: { name: 'openai/gpt-4.1' } };
    draftSessionId = undefined;
    updateAgentSpec.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows search, Email and Calendar selected in a new chat, and leaves other connectors unselected', async () => {
    renderPicker({ setUp: [SEARCH, EMAIL, CALENDAR, GITHUB] });
    await openConnectors();

    expect(row(/Web search/)).toHaveAttribute('aria-checked', 'true');
    expect(row(/Email/)).toHaveAttribute('aria-checked', 'true');
    expect(row(/Calendar/)).toHaveAttribute('aria-checked', 'true');
    expect(row(/GitHub/)).toHaveAttribute('aria-checked', 'false');
  });

  it('shows the same selection in a chat made before this change', async () => {
    draftSessionId = 'older-chat';
    agentSpec = { model: { name: 'openai/gpt-4.1' }, mcpServers: [{ id: 'github', name: 'github' }] };
    renderPicker({ setUp: [SEARCH, EMAIL, GITHUB], sessions: fakeSessions({ agent_details: 'expanded' }) });
    await openConnectors();

    expect(row(/Email/)).toHaveAttribute('aria-checked', 'true');
    expect(row(/Web search/)).toHaveAttribute('aria-checked', 'true');
    expect(row(/GitHub/)).toHaveAttribute('aria-checked', 'true');
  });

  it('never shows a connector as selected when it is not set up', async () => {
    renderPicker({ setUp: [SEARCH, GITHUB] });
    await screen.findByRole('button', { name: 'Add' });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add-ons' }));
    await screen.findByRole('menuitemcheckbox', { name: /GitHub/ });

    expect(screen.queryByRole('menuitemcheckbox', { name: /Email/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemcheckbox', { name: /Calendar/ })).not.toBeInTheDocument();
  });

  it('keeps Email off for the chat after it is unticked, across a reload, and clears the choice when ticked again', async () => {
    draftSessionId = 'chat-1';
    const sessions = fakeSessions({ agent_details: 'expanded' });
    const first = renderPicker({ setUp: [SEARCH, EMAIL], sessions });
    await openConnectors();

    await act(async () => {
      fireEvent.click(row(/Email/));
    });
    await waitFor(() => expect(sessions.updateSession).toHaveBeenCalledTimes(1));
    expect(sessions.stored.metadata).toEqual({ agent_details: 'expanded', [connectorOffKey('Email')]: '1' });
    expect(row(/Email/)).toHaveAttribute('aria-checked', 'false');
    expect(row(/Web search/)).toHaveAttribute('aria-checked', 'true');

    first.view.unmount();
    renderPicker({ setUp: [SEARCH, EMAIL], sessions });
    await openConnectors();
    await waitFor(() => expect(row(/Email/)).toHaveAttribute('aria-checked', 'false'));

    await act(async () => {
      fireEvent.click(row(/Email/));
    });
    await waitFor(() => expect(sessions.updateSession).toHaveBeenCalledTimes(2));
    expect(sessions.stored.metadata).toEqual({ agent_details: 'expanded' });
    expect(row(/Email/)).toHaveAttribute('aria-checked', 'true');
  });

  it('holds the choice of a new chat until its session exists, and does not write the agent spec for it', async () => {
    const sessions = fakeSessions({});
    renderPicker({ setUp: [SEARCH, EMAIL], sessions });
    await openConnectors();

    await act(async () => {
      fireEvent.click(row(/Email/));
    });

    expect(row(/Email/)).toHaveAttribute('aria-checked', 'false');
    expect(sessions.updateSession).not.toHaveBeenCalled();
    expect(updateAgentSpec).not.toHaveBeenCalledWith(expect.objectContaining({ mcpServers: expect.anything() }));
  });

  it('shows a plain message and the stored switch when the choice could not be saved', async () => {
    draftSessionId = 'chat-2';
    const sessions = fakeSessions({});
    sessions.updateSession.mockRejectedValueOnce(new Error('offline'));
    renderPicker({ setUp: [SEARCH, EMAIL], sessions });
    await openConnectors();

    await act(async () => {
      fireEvent.click(row(/Email/));
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/not saved/);
    expect(row(/Email/)).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    await openConnectors();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('turns a connector with a very long name off and back on without a rejected write', async () => {
    draftSessionId = 'chat-3';
    const longName = 'long-search-provider-'.repeat(20);
    const longSearch = { id: longName, name: longName, authenticated: true, searchProvider: true };
    const sessions = fakeSessions({});
    renderPicker({ setUp: [longSearch, EMAIL], sessions });
    await openConnectors();

    await act(async () => {
      fireEvent.click(row(/Long search provider/));
    });
    await waitFor(() => expect(sessions.updateSession).toHaveBeenCalledTimes(1));
    for (const [key, value] of Object.entries(sessions.stored.metadata)) {
      expect(key.length).toBeLessThanOrEqual(32);
      expect(value.length).toBeLessThanOrEqual(128);
    }
    expect(row(/Long search provider/)).toHaveAttribute('aria-checked', 'false');

    await act(async () => {
      fireEvent.click(row(/Long search provider/));
    });
    await waitFor(() => expect(sessions.updateSession).toHaveBeenCalledTimes(2));
    expect(sessions.stored.metadata).toEqual({});
    expect(row(/Long search provider/)).toHaveAttribute('aria-checked', 'true');
  });
});
