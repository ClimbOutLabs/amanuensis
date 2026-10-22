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
import {
  threadTurnAwaitingAction,
  threadTurnFailed,
  WorkOnRepoControls,
  type TurnThreadState,
} from '@/containers/WorkOnRepoControls.js';

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
      'Clone https://github.com/octo-example/demo-repo.git into a new folder named demo-repo in the workspace, then check out the main branch. Run this one command yourself in this chat: git clone --branch main https://github.com/octo-example/demo-repo.git demo-repo. Do not hand this to a sub-agent.',
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

  it('does not connect when the clone turn failed, shows why, and can still start over', async () => {
    const state: FakeState = { bound: false, proposals: [] };
    const api = fakeApi(state);
    const { sendMessage, view } = renderControls(api, { sessionId: 'session-1' });

    fireEvent.click(await screen.findByRole('button', { name: /Work on a repo/ }));
    fireEvent.click(await screen.findByRole('button', { name: /octo-example\/demo-repo/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start work' }));
    expect(sendMessage).toHaveBeenCalledTimes(1);

    view.rerender(
      <RepositoryWorkProvider api={api}>
        <WorkOnRepoControls sessionId="session-1" isRunning sendMessage={sendMessage} />
      </RepositoryWorkProvider>,
    );
    view.rerender(
      <RepositoryWorkProvider api={api}>
        <WorkOnRepoControls sessionId="session-1" isRunning={false} turnFailed sendMessage={sendMessage} />
      </RepositoryWorkProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The repo could not be cloned, so this chat is not connected to it. Try again.',
    );
    expect(api.startRepositoryWork).not.toHaveBeenCalled();
    expect(state.bound).toBe(false);
    expect(screen.queryByText('Working on demo-repo')).not.toBeInTheDocument();

    // Starting over with a clone turn that goes through connects as usual.
    fireEvent.click(screen.getByRole('button', { name: /Work on a repo/ }));
    fireEvent.click(await screen.findByRole('button', { name: /octo-example\/demo-repo/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start work' }));
    view.rerender(
      <RepositoryWorkProvider api={api}>
        <WorkOnRepoControls sessionId="session-1" isRunning sendMessage={sendMessage} />
      </RepositoryWorkProvider>,
    );
    view.rerender(
      <RepositoryWorkProvider api={api}>
        <WorkOnRepoControls sessionId="session-1" isRunning={false} sendMessage={sendMessage} />
      </RepositoryWorkProvider>,
    );
    await waitFor(() => {
      expect(api.startRepositoryWork).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText('Working on demo-repo')).toBeInTheDocument();
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

describe('clone turn outcome checks', () => {
  function stateWith(messages: TurnThreadState['thread']['messages']): TurnThreadState {
    return { thread: { messages } };
  }

  it('treats a turn paused on the person as not finished', () => {
    expect(
      threadTurnAwaitingAction(stateWith([{ role: 'assistant', status: { type: 'requires-action' }, content: [] }])),
    ).toBe(true);
    expect(
      threadTurnAwaitingAction(
        stateWith([
          {
            role: 'assistant',
            status: { type: 'running' },
            content: [{ type: 'tool-call', status: { type: 'requires-action' } }],
          },
        ]),
      ),
    ).toBe(true);
    expect(
      threadTurnAwaitingAction(stateWith([{ role: 'assistant', status: { type: 'complete' }, content: [] }])),
    ).toBe(false);
    expect(threadTurnAwaitingAction(stateWith([]))).toBe(false);
  });

  it('reads a clone that did not go through from the newest assistant message', () => {
    // The message itself ended in error.
    expect(threadTurnFailed(stateWith([{ role: 'assistant', status: { type: 'incomplete' }, content: [] }]))).toBe(
      true,
    );
    // The person turned the call down.
    expect(
      threadTurnFailed(
        stateWith([
          { role: 'assistant', status: { type: 'complete' }, content: [{ type: 'tool-call', approval: {} }] },
        ]),
      ),
    ).toBe(false);
    expect(
      threadTurnFailed(
        stateWith([
          {
            role: 'assistant',
            status: { type: 'complete' },
            content: [{ type: 'tool-call', approval: { approved: false } }],
          },
        ]),
      ),
    ).toBe(true);
    // The approval lapsed without an answer.
    expect(
      threadTurnFailed(
        stateWith([
          {
            role: 'assistant',
            status: { type: 'complete' },
            content: [{ type: 'tool-call', approval: { resolution: 'expired' } }],
          },
        ]),
      ),
    ).toBe(true);
    // The last call of the turn failed.
    expect(
      threadTurnFailed(
        stateWith([
          { role: 'assistant', status: { type: 'complete' }, content: [{ type: 'tool-call', isError: true }] },
        ]),
      ),
    ).toBe(true);
    expect(
      threadTurnFailed(
        stateWith([
          {
            role: 'assistant',
            status: { type: 'complete' },
            content: [{ type: 'tool-call', status: { type: 'incomplete' } }],
          },
        ]),
      ),
    ).toBe(true);
  });

  it('does not blame a turn that recovered, or one that has not answered yet', () => {
    // An early call failed but the turn recovered and its last call went through.
    expect(
      threadTurnFailed(
        stateWith([
          {
            role: 'assistant',
            status: { type: 'complete' },
            content: [
              { type: 'tool-call', isError: true },
              { type: 'tool-call', status: { type: 'complete' } },
            ],
          },
        ]),
      ),
    ).toBe(false);
    // A call still waiting on the person has no outcome yet.
    expect(
      threadTurnFailed(
        stateWith([
          {
            role: 'assistant',
            status: { type: 'requires-action' },
            content: [{ type: 'tool-call', status: { type: 'requires-action' }, approval: {} }],
          },
        ]),
      ),
    ).toBe(false);
    // A clean turn, and a thread with no assistant message yet.
    expect(
      threadTurnFailed(
        stateWith([
          {
            role: 'assistant',
            status: { type: 'complete' },
            content: [{ type: 'tool-call', status: { type: 'complete' } }],
          },
        ]),
      ),
    ).toBe(false);
    expect(threadTurnFailed(stateWith([{ role: 'user', content: [] }]))).toBe(false);
  });
});
