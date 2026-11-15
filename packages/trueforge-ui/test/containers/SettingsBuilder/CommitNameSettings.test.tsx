// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RunCodeStatusProvider } from '@/components/RunCodeStatusContext.js';
import SandboxSettings from '@/containers/SettingsBuilder/SandboxSettings.js';
import type {
  GitCommitIdentityCatalog,
  GitCommitIdentitySetting,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/gitCommitIdentityCatalog.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { createMockAgentUIServer } from '../../server/mockServer.js';

const UNSET: GitCommitIdentitySetting = {
  name: null,
  email: null,
  default_name: 'Sam Rivera',
  default_email: 'aman@localhost',
};

function renderPage(catalog: GitCommitIdentityCatalog | undefined) {
  const base = createMockAgentUIServer({
    getCapabilities: async () => ({
      data: {
        sandbox: { enabled: true },
        skill: { enabled: true },
        settings: { enabled: true },
        memoryScreen: { enabled: false },
        toolOutputScreen: { enabled: false },
      },
    }),
  });
  const server = catalog === undefined ? base : { ...base, gitCommitIdentity: catalog };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServerProvider server={server}>
      <RunCodeStatusProvider api={{ getRunCodeStatus: async () => ({ state: 'ready' as const }) }}>
        {children}
      </RunCodeStatusProvider>
    </ServerProvider>
  );
  return render(<SandboxSettings />, { wrapper });
}

function catalogWith(input: {
  stored: GitCommitIdentitySetting;
  set?: GitCommitIdentityCatalog['setGitCommitIdentity'];
}): GitCommitIdentityCatalog {
  return {
    getGitCommitIdentity: vi.fn(async () => input.stored),
    setGitCommitIdentity: vi.fn(input.set ?? (async choice => ({ ...input.stored, ...choice }))),
  };
}

describe('the name on Git commits in Sandbox settings', () => {
  it("shows the person's own name as the default in an empty box", async () => {
    renderPage(catalogWith({ stored: UNSET }));
    const name = await screen.findByLabelText('Name');
    await waitFor(() => {
      expect(name.getAttribute('placeholder')).toBe('Sam Rivera');
    });
    expect(name).toHaveProperty('value', '');
    expect(screen.getByLabelText('Email').getAttribute('placeholder')).toBe('aman@localhost');
  });

  it('shows a name that was chosen before', async () => {
    renderPage(catalogWith({ stored: { ...UNSET, name: 'Aman' } }));
    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Aman');
    });
  });

  it('saves a new name and an email, and says so', async () => {
    const catalog = catalogWith({ stored: UNSET });
    renderPage(catalog);
    const name = await screen.findByLabelText('Name');
    await waitFor(() => {
      expect(name.getAttribute('placeholder')).toBe('Sam Rivera');
    });
    fireEvent.change(name, { target: { value: '  Aman ' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(catalog.setGitCommitIdentity).toHaveBeenCalledWith({ name: 'Aman', email: 'sam@example.com' });
  });

  it('sends an emptied box as a return to the default', async () => {
    const catalog = catalogWith({ stored: { ...UNSET, name: 'Aman' } });
    renderPage(catalog);
    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Aman');
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(catalog.setGitCommitIdentity).toHaveBeenCalledWith({ name: null, email: null });
  });

  it('shows what to change when the save is refused', async () => {
    const catalog = catalogWith({
      stored: UNSET,
      set: async () => {
        throw new Error(
          'That name or email cannot be used. Use a name without < or >, and an email like you@example.com.',
        );
      },
    });
    renderPage(catalog);
    const name = await screen.findByLabelText('Name');
    await waitFor(() => {
      expect(name.getAttribute('placeholder')).toBe('Sam Rivera');
    });
    fireEvent.change(name, { target: { value: 'Sam <x>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('That name or email cannot be used.');
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('is not shown where the server has no such setting', async () => {
    renderPage(undefined);
    await screen.findByText('Sandbox');
    expect(screen.queryByText('Name on Git commits')).toBeNull();
  });
});
