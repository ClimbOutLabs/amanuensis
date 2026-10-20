// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  RepositoryWorkProvider,
  type GithubRepositoryDetails,
  type GithubRepositoryOption,
  type RepositoryCommandProposal,
  type RepositorySummary,
  type RepositoryWorkApi,
} from '@/components/RepositoryWorkContext.js';
import { WorkOnRepoControls } from '@/containers/WorkOnRepoControls.js';

const option: GithubRepositoryOption = {
  name: 'demo-repo',
  full_name: 'octo-example/demo-repo',
  clone_url: 'https://github.com/octo-example/demo-repo.git',
  default_branch: 'main',
  size_kb: 2_048,
  private: false,
};

const details: GithubRepositoryDetails = { ...option, branches: ['main', 'dev'] };

const repository: RepositorySummary = {
  id: 'repo-1',
  name: 'demo-repo',
  clone_url: option.clone_url,
  default_branch: 'main',
  revision: 1,
};

const testProposal: RepositoryCommandProposal = {
  id: 'proposal-test',
  purpose: 'test',
  command: 'pnpm test',
  source_kind: 'package_json',
  source_path: 'package.json',
};

const verifyProposal: RepositoryCommandProposal = {
  id: 'proposal-verify',
  purpose: 'verify',
  command: 'ruff check .',
  source_kind: 'pyproject_toml',
  source_path: 'pyproject.toml',
};

type FakeState = {
  bound: boolean;
  proposals: RepositoryCommandProposal[];
};

function fakeApi(state: FakeState): RepositoryWorkApi {
  return {
    listGithubRepositories: vi.fn().mockResolvedValue([option]),
    getGithubRepository: vi.fn().mockResolvedValue(details),
    startRepositoryWork: vi.fn().mockImplementation(() => {
      state.bound = true;
      return Promise.resolve({
        session_id: 'session-1',
        repository_id: repository.id,
        workspace_cwd: '/workspace/demo-repo',
        branch: 'main',
        repository,
      });
    }),
    getSessionRepository: vi.fn().mockImplementation(() =>
      Promise.resolve({
        session_id: 'session-1',
        repository_id: state.bound ? repository.id : null,
        workspace_cwd: state.bound ? '/workspace/demo-repo' : null,
      }),
    ),
    getRepository: vi.fn().mockResolvedValue(repository),
    listCommandProposals: vi.fn().mockImplementation(() => Promise.resolve([...state.proposals])),
    confirmCommandProposal: vi.fn().mockImplementation((input: { proposalId: string }) => {
      state.proposals = state.proposals.filter(proposal => proposal.id !== input.proposalId);
      return Promise.resolve();
    }),
    dismissCommandProposal: vi.fn().mockImplementation((input: { proposalId: string }) => {
      state.proposals = state.proposals.filter(proposal => proposal.id !== input.proposalId);
      return Promise.resolve();
    }),
    unbindSessionRepository: vi.fn().mockImplementation(() => {
      state.bound = false;
      return Promise.resolve();
    }),
  };
}

function renderControls(api: RepositoryWorkApi, props: { sessionId: string | null; isRunning?: boolean }) {
  const sendMessage = vi.fn();
  const view = render(
    <RepositoryWorkProvider api={api}>
      <WorkOnRepoControls sessionId={props.sessionId} isRunning={props.isRunning ?? false} sendMessage={sendMessage} />
    </RepositoryWorkProvider>,
  );
  return { sendMessage, view };
}

describe('WorkOnRepoControls', () => {
  it('picks a repo and branch, asks for the clone in the chat, then binds when the turn ends', async () => {
    const state: FakeState = { bound: false, proposals: [] };
    const api = fakeApi(state);
    const { sendMessage, view } = renderControls(api, { sessionId: 'session-1' });

    fireEvent.click(await screen.findByRole('button', { name: /Work on a repo/ }));
    fireEvent.click(await screen.findByRole('button', { name: /octo-example\/demo-repo/ }));
    expect(await screen.findByLabelText('Branch')).toHaveValue('main');

    fireEvent.click(screen.getByRole('button', { name: 'Start work' }));
    expect(sendMessage).toHaveBeenCalledWith(
      'Clone https://github.com/octo-example/demo-repo.git into a new folder named demo-repo in the workspace, then check out the main branch.',
    );
    expect(api.startRepositoryWork).not.toHaveBeenCalled();

    view.rerender(
      <RepositoryWorkProvider api={api}>
        <WorkOnRepoControls sessionId="session-1" isRunning sendMessage={sendMessage} />
      </RepositoryWorkProvider>,
    );
    expect(api.startRepositoryWork).not.toHaveBeenCalled();

    view.rerender(
      <RepositoryWorkProvider api={api}>
        <WorkOnRepoControls sessionId="session-1" isRunning={false} sendMessage={sendMessage} />
      </RepositoryWorkProvider>,
    );
    await waitFor(() => {
      expect(api.startRepositoryWork).toHaveBeenCalledWith({
        sessionId: 'session-1',
        cloneUrl: 'https://github.com/octo-example/demo-repo.git',
        branch: 'main',
      });
    });
    expect(await screen.findByText('Working on demo-repo')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('shows the connect GitHub message from the server in the picker', async () => {
    const state: FakeState = { bound: false, proposals: [] };
    const api = fakeApi(state);
    vi.mocked(api.listGithubRepositories).mockRejectedValue(new Error('Connect GitHub first, under Connectors.'));
    renderControls(api, { sessionId: 'session-1' });

    fireEvent.click(await screen.findByRole('button', { name: /Work on a repo/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connect GitHub first, under Connectors.');
  });

  it('looks up a pasted address and offers its branches', async () => {
    const state: FakeState = { bound: false, proposals: [] };
    const api = fakeApi(state);
    const { sendMessage } = renderControls(api, { sessionId: 'session-1' });

    fireEvent.click(await screen.findByRole('button', { name: /Work on a repo/ }));
    fireEvent.change(screen.getByLabelText('Or paste a GitHub repo address'), {
      target: { value: 'https://github.com/octo-example/demo-repo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(api.getGithubRepository).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cloneUrl: 'https://github.com/octo-example/demo-repo',
    });
    const branchSelect = await screen.findByLabelText('Branch');
    fireEvent.change(branchSelect, { target: { value: 'dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }));
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('check out the dev branch.'));
  });

  it('confirms every proposal from one card and dismisses single proposals', async () => {
    const state: FakeState = { bound: true, proposals: [testProposal, verifyProposal] };
    const api = fakeApi(state);
    renderControls(api, { sessionId: 'session-1' });

    expect(await screen.findByText('Commands found in this repo')).toBeInTheDocument();
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByText('ruff check .')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm all' }));
    await waitFor(() => {
      expect(api.confirmCommandProposal).toHaveBeenCalledTimes(2);
    });
    expect(api.confirmCommandProposal).toHaveBeenCalledWith({
      repositoryId: 'repo-1',
      proposalId: 'proposal-test',
      commandId: 'test',
      timeoutMs: 900_000,
    });
    expect(api.confirmCommandProposal).toHaveBeenCalledWith({
      repositoryId: 'repo-1',
      proposalId: 'proposal-verify',
      commandId: 'verify',
      timeoutMs: 900_000,
    });
    await waitFor(() => {
      expect(screen.queryByText('Commands found in this repo')).not.toBeInTheDocument();
    });
  });

  it('dismisses one proposal without touching the others', async () => {
    const state: FakeState = { bound: true, proposals: [testProposal, verifyProposal] };
    const api = fakeApi(state);
    renderControls(api, { sessionId: 'session-1' });

    expect(await screen.findByText('pnpm test')).toBeInTheDocument();
    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss' });
    expect(dismissButtons).toHaveLength(2);
    const firstDismiss = dismissButtons[0];
    if (firstDismiss) {
      fireEvent.click(firstDismiss);
    }
    await waitFor(() => {
      expect(api.dismissCommandProposal).toHaveBeenCalledWith({ repositoryId: 'repo-1', proposalId: 'proposal-test' });
    });
    await waitFor(() => {
      expect(screen.queryByText('pnpm test')).not.toBeInTheDocument();
    });
    expect(screen.getByText('ruff check .')).toBeInTheDocument();
  });

  it('stops working on the repo from the indicator', async () => {
    const state: FakeState = { bound: true, proposals: [] };
    const api = fakeApi(state);
    renderControls(api, { sessionId: 'session-1' });

    fireEvent.click(await screen.findByRole('button', { name: 'Stop working on this repo' }));
    await waitFor(() => {
      expect(api.unbindSessionRepository).toHaveBeenCalledWith('session-1');
    });
    expect(await screen.findByRole('button', { name: /Work on a repo/ })).toBeInTheDocument();
  });

  it('starts from a new chat: paste only, and binds once the chat exists and settles', async () => {
    const state: FakeState = { bound: false, proposals: [] };
    const api = fakeApi(state);
    const { sendMessage, view } = renderControls(api, { sessionId: null });

    fireEvent.click(await screen.findByRole('button', { name: /Work on a repo/ }));
    expect(screen.queryByText('Your GitHub repos')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Or paste a GitHub repo address'), {
      target: { value: 'https://github.com/octo-example/demo-repo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(api.getGithubRepository).toHaveBeenCalledWith({
      sessionId: null,
      cloneUrl: 'https://github.com/octo-example/demo-repo',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Start work' }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(api.startRepositoryWork).not.toHaveBeenCalled();

    view.rerender(
      <RepositoryWorkProvider api={api}>
        <WorkOnRepoControls sessionId="session-1" isRunning sendMessage={sendMessage} />
      </RepositoryWorkProvider>,
    );
    expect(api.startRepositoryWork).not.toHaveBeenCalled();

    view.rerender(
      <RepositoryWorkProvider api={api}>
        <WorkOnRepoControls sessionId="session-1" isRunning={false} sendMessage={sendMessage} />
      </RepositoryWorkProvider>,
    );
    await waitFor(() => {
      expect(api.startRepositoryWork).toHaveBeenCalledWith({
        sessionId: 'session-1',
        cloneUrl: 'https://github.com/octo-example/demo-repo.git',
        branch: 'main',
      });
    });
  });
});
