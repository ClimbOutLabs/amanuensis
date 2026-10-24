import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useAui } from '@assistant-ui/react';
import { useTrueFoundryAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { FolderGit2, GitBranch } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuiState } from '@/assistant-ui.js';
import { chatSandboxKnownOff } from '@/atoms/draft/agentSandbox.js';
import { Button } from '@/atoms/primitives/Button.js';
import {
  useOptionalRepositoryWork,
  useRepositoryWork,
  type GithubRepositoryDetails,
  type GithubRepositoryOption,
  type RepositoryCommandProposal,
  type RepositorySummary,
  type SessionRepositoryBinding,
} from '@/components/RepositoryWorkContext.js';
import { useServerCapabilities } from '@/server/ServerContext.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

export type WorkOnRepoControlsProps = {
  sessionId: string | null;
  isRunning: boolean;
  /** True when the newest turn shows its work did not go through, so a clone it ran did not land. */
  turnFailed?: boolean;
  /** True only when the chat is known to run without the sandbox, where a clone cannot work. */
  sandboxOff: boolean;
  /** Sends a chat message in this thread; used for the clone request the person approves. */
  sendMessage: (text: string) => void;
};

type PendingStart = {
  cloneUrl: string;
  repoName: string;
  fullName: string;
  branch: string;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 900_000;
const PURPOSE_LABELS: Record<RepositoryCommandProposal['purpose'], string> = {
  build: 'Build',
  test: 'Test',
  verify: 'Check',
};

function formatSize(sizeKb: number): string {
  return sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb} KB`;
}

/** The command id a confirmation gets: the purpose, widened only when two proposals share it. */
function commandIdFor(proposal: RepositoryCommandProposal, all: RepositoryCommandProposal[]): string {
  const samePurpose = all.filter(candidate => candidate.purpose === proposal.purpose);
  if (samePurpose.length === 1) {
    return proposal.purpose;
  }
  const kindSuffix = proposal.source_kind.replaceAll('_', '-');
  const sameKind = samePurpose.filter(candidate => candidate.source_kind === proposal.source_kind);
  if (sameKind.length === 1) {
    return `${proposal.purpose}-${kindSuffix}`;
  }
  const index = sameKind.findIndex(candidate => candidate.id === proposal.id);
  return `${proposal.purpose}-${kindSuffix}-${index + 1}`;
}

/** One part of a chat message, narrowed to what the turn outcome checks read. */
type TurnPartState = {
  type: string;
  status?: { type: string };
  isError?: boolean;
  approval?: { approved?: boolean; resolution?: string };
};

type TurnMessageState = {
  role: string;
  status?: { type: string };
  content: readonly TurnPartState[];
};

/** The thread shape the turn outcome checks read, in the shape the thread state hands over. */
export type TurnThreadState = {
  thread: { messages: readonly TurnMessageState[] };
};

function lastAssistantMessage(state: TurnThreadState): TurnMessageState | undefined {
  const messages = state.thread.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') {
      return message;
    }
  }
  return undefined;
}

/**
 * True while the newest assistant message waits on the person, for example for an
 * approval: the turn has paused, not finished, so a clone it is running has not landed.
 */
export function threadTurnAwaitingAction(state: TurnThreadState): boolean {
  const message = lastAssistantMessage(state);
  if (message === undefined) {
    return false;
  }
  if (message.status?.type === 'requires-action') {
    return true;
  }
  return message.content.some(part => part.type === 'tool-call' && part.status?.type === 'requires-action');
}

/**
 * True when the newest assistant message shows its work did not go through: the
 * message ended in error, the person turned one of its calls down, an approval
 * lapsed, or its last call failed. A call that failed early but was recovered
 * within the same message does not count.
 */
export function threadTurnFailed(state: TurnThreadState): boolean {
  const message = lastAssistantMessage(state);
  if (message === undefined) {
    return false;
  }
  if (message.status?.type === 'incomplete') {
    return true;
  }
  const toolCalls = message.content.filter(part => part.type === 'tool-call');
  if (toolCalls.some(part => part.approval?.approved === false || part.approval?.resolution !== undefined)) {
    return true;
  }
  const last = toolCalls[toolCalls.length - 1];
  return last !== undefined && (last.status?.type === 'incomplete' || last.isError === true);
}

export function WorkOnRepoControls({
  sessionId,
  isRunning,
  turnFailed = false,
  sandboxOff,
  sendMessage,
}: WorkOnRepoControlsProps) {
  const api = useRepositoryWork();
  const [binding, setBinding] = useState<SessionRepositoryBinding | null>(null);
  const [repository, setRepository] = useState<RepositorySummary | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [proposals, setProposals] = useState<RepositoryCommandProposal[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [repoOptions, setRepoOptions] = useState<GithubRepositoryOption[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [urlValue, setUrlValue] = useState('');
  const [selected, setSelected] = useState<GithubRepositoryDetails | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [chosenBranch, setChosenBranch] = useState('');
  const [pendingStart, setPendingStart] = useState<PendingStart | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const sawCloneTurnRef = useRef(false);
  const previousSessionRef = useRef(sessionId);

  const refreshBinding = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    try {
      const current = await api.getSessionRepository(sessionId);
      setBinding(current);
      if (current.repository_id) {
        const [repo, nextProposals] = await Promise.all([
          api.getRepository(current.repository_id),
          api.listCommandProposals(current.repository_id),
        ]);
        setRepository(repo);
        setProposals(nextProposals);
      } else {
        setRepository(null);
        setProposals([]);
      }
    } catch {
      // Keep the last known state; the next poll or action retries.
    }
  }, [api, sessionId]);

  // Switching to a different chat resets the view. A new chat gaining its id
  // (null to an id) is the same chat, so a start waiting on its clone keeps waiting.
  useEffect(() => {
    const previous = previousSessionRef.current;
    previousSessionRef.current = sessionId;
    if (previous === null || previous === sessionId) {
      return;
    }
    setBinding(null);
    setRepository(null);
    setBranch(null);
    setProposals([]);
    setPendingStart(null);
    setStartError(null);
    setPanelOpen(false);
  }, [sessionId]);

  useEffect(() => {
    void refreshBinding();
  }, [refreshBinding]);

  // While a turn runs, the binding and the command proposals can change underneath
  // this view (the clone finishes, the repo files get read), so poll like the
  // implementation plan grant controls do.
  useEffect(() => {
    if (!isRunning) {
      return;
    }
    const intervalId = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshBinding();
      }
    }, 2_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshBinding();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(intervalId);
    };
  }, [isRunning, refreshBinding]);

  // The bind waits until the clone turn has been seen running and then finished
  // cleanly: binding earlier would point the clone turn itself at a checkout that
  // does not exist yet, and the turn would fail.
  useEffect(() => {
    if (pendingStart && isRunning) {
      sawCloneTurnRef.current = true;
    }
  }, [pendingStart, isRunning]);

  useEffect(() => {
    if (!pendingStart || !sessionId || isRunning || !sawCloneTurnRef.current || startingRef.current) {
      return;
    }
    // The clone turn ended without the clone going through, so there is no
    // checkout to connect: say so instead of binding the chat to a missing folder.
    if (turnFailed) {
      setStartError('The repo could not be cloned, so this chat is not connected to it. Try again.');
      setPendingStart(null);
      sawCloneTurnRef.current = false;
      return;
    }
    startingRef.current = true;
    const pending = pendingStart;
    void (async () => {
      try {
        const result = await api.startRepositoryWork({
          sessionId,
          cloneUrl: pending.cloneUrl,
          branch: pending.branch,
        });
        setBranch(result.branch);
        setPendingStart(null);
        await refreshBinding();
      } catch (error) {
        setStartError(getErrorMessage(error, 'The repo could not be set up. Try again.'));
        setPendingStart(null);
      } finally {
        startingRef.current = false;
        sawCloneTurnRef.current = false;
      }
    })();
  }, [api, pendingStart, sessionId, isRunning, turnFailed, refreshBinding]);

  const openPanel = useCallback(() => {
    setPanelOpen(true);
    if (sessionId && repoOptions === null) {
      void (async () => {
        try {
          setRepoOptions(await api.listGithubRepositories(sessionId));
          setListError(null);
        } catch (error) {
          setListError(getErrorMessage(error, 'Your repos could not be loaded. Try again.'));
        }
      })();
    }
  }, [api, sessionId, repoOptions]);

  const pickDetails = useCallback((details: GithubRepositoryDetails) => {
    setSelected(details);
    setChosenBranch(details.default_branch ?? details.branches[0] ?? '');
    setLookupError(null);
  }, []);

  const pickOption = useCallback(
    (option: GithubRepositoryOption) => {
      void (async () => {
        try {
          pickDetails(await api.getGithubRepository({ sessionId, cloneUrl: option.clone_url }));
        } catch (error) {
          setLookupError(getErrorMessage(error, 'That repo could not be loaded. Try again.'));
        }
      })();
    },
    [api, sessionId, pickDetails],
  );

  const lookUpUrl = useCallback(() => {
    const cloneUrl = urlValue.trim();
    if (cloneUrl.length === 0) {
      return;
    }
    void (async () => {
      try {
        pickDetails(await api.getGithubRepository({ sessionId, cloneUrl }));
      } catch (error) {
        setSelected(null);
        setLookupError(getErrorMessage(error, 'That repo could not be loaded. Check the address and try again.'));
      }
    })();
  }, [api, sessionId, urlValue, pickDetails]);

  const start = useCallback(() => {
    if (!selected || chosenBranch.length === 0) {
      return;
    }
    setStartError(null);
    sawCloneTurnRef.current = false;
    sendMessage(
      `Clone ${selected.clone_url} into a new folder named ${selected.name} in the workspace, then check out the ${chosenBranch} branch. Run this one command yourself in this chat: git clone --branch ${chosenBranch} ${selected.clone_url} ${selected.name}. Do not hand this to a sub-agent.`,
    );
    setPendingStart({
      cloneUrl: selected.clone_url,
      repoName: selected.name,
      fullName: selected.full_name,
      branch: chosenBranch,
    });
    setPanelOpen(false);
  }, [selected, chosenBranch, sendMessage]);

  const confirmProposal = useCallback(
    async (proposal: RepositoryCommandProposal) => {
      if (!binding?.repository_id) {
        return;
      }
      try {
        await api.confirmCommandProposal({
          repositoryId: binding.repository_id,
          proposalId: proposal.id,
          commandId: commandIdFor(proposal, proposals),
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        });
        setActionError(null);
        await refreshBinding();
      } catch (error) {
        setActionError(getErrorMessage(error, 'That command could not be confirmed. Try again.'));
      }
    },
    [api, binding, proposals, refreshBinding],
  );

  const confirmAll = useCallback(async () => {
    for (const proposal of proposals) {
      await confirmProposal(proposal);
    }
  }, [proposals, confirmProposal]);

  const dismissProposal = useCallback(
    async (proposal: RepositoryCommandProposal) => {
      if (!binding?.repository_id) {
        return;
      }
      try {
        await api.dismissCommandProposal({ repositoryId: binding.repository_id, proposalId: proposal.id });
        setActionError(null);
        await refreshBinding();
      } catch (error) {
        setActionError(getErrorMessage(error, 'That command could not be dismissed. Try again.'));
      }
    },
    [api, binding, refreshBinding],
  );

  const unbind = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    try {
      await api.unbindSessionRepository(sessionId);
      setBranch(null);
      setActionError(null);
      await refreshBinding();
    } catch (error) {
      setActionError(getErrorMessage(error, 'This chat could not be unlinked from the repo. Try again.'));
    }
  }, [api, sessionId, refreshBinding]);

  if (binding?.repository_id) {
    return (
      <section aria-label="Working on a repo" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-text-primary">
            <FolderGit2 aria-hidden className="h-3.5 w-3.5 text-text-secondary" />
            Working on {repository?.name ?? 'a repo'}
            {branch ? (
              <span className="flex items-center gap-1 font-normal text-text-secondary">
                <GitBranch aria-hidden className="h-3.5 w-3.5" />
                {branch}
              </span>
            ) : null}
          </p>
          <Button type="button" variant="ghost" size="small" onClick={() => void unbind()}>
            Stop working on this repo
          </Button>
        </div>
        {proposals.length > 0 ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card-bg px-3 py-2.5 shadow-sm">
            <p className="text-[0.8125rem] font-medium text-text-primary">Commands found in this repo</p>
            <p className="text-[0.8125rem] text-text-secondary">
              Aman found these commands in the repo files. Confirm the ones it may run.
            </p>
            <ul className="flex flex-col gap-2">
              {proposals.map(proposal => (
                <li key={proposal.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[0.8125rem] font-medium text-text-primary">
                    {PURPOSE_LABELS[proposal.purpose]}
                  </span>
                  <code className="text-[0.8125rem] text-text-primary">{proposal.command}</code>
                  <span className="text-[0.75rem] text-text-secondary">from {proposal.source_path}</span>
                  <span className="flex gap-1">
                    <Button type="button" variant="ghost" size="small" onClick={() => void confirmProposal(proposal)}>
                      Confirm
                    </Button>
                    <Button type="button" variant="ghost" size="small" onClick={() => void dismissProposal(proposal)}>
                      Dismiss
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
            <div>
              <Button type="button" size="small" onClick={() => void confirmAll()}>
                Confirm all
              </Button>
            </div>
          </div>
        ) : null}
        {actionError ? (
          <p role="alert" className="text-[0.8125rem] text-failure-bg">
            {actionError}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="small"
          disabled={sandboxOff}
          onClick={panelOpen ? () => setPanelOpen(false) : openPanel}
        >
          <FolderGit2 aria-hidden className="mr-1.5 h-3.5 w-3.5" />
          Work on a repo
        </Button>
        {pendingStart ? (
          <p className="text-[0.8125rem] text-text-secondary">
            Aman is cloning {pendingStart.fullName} in this chat. When the clone finishes, this chat will work on the{' '}
            {pendingStart.branch} branch.
          </p>
        ) : null}
      </div>
      {sandboxOff ? (
        <p className="text-[0.8125rem] text-text-secondary">
          Work on a repo needs the sandbox. Open Add-ons in the composer, go to Connectors, and turn on Sandbox.
        </p>
      ) : null}
      {startError ? (
        <p role="alert" className="text-[0.8125rem] text-failure-bg">
          {startError}
        </p>
      ) : null}
      {panelOpen && !sandboxOff ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card-bg px-3 py-2.5 shadow-sm">
          {sessionId ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-[0.8125rem] font-medium text-text-primary">Your GitHub repos</p>
              {listError ? (
                <p role="alert" className="text-[0.8125rem] text-failure-bg">
                  {listError}
                </p>
              ) : repoOptions === null ? (
                <p className="text-[0.8125rem] text-text-secondary">Loading your repos…</p>
              ) : repoOptions.length === 0 ? (
                <p className="text-[0.8125rem] text-text-secondary">No repos were found on your GitHub account.</p>
              ) : (
                <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                  {repoOptions.map(option => (
                    <li key={option.clone_url}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[0.8125rem] text-text-primary hover:bg-ghost-button-hover"
                        aria-pressed={selected?.clone_url === option.clone_url}
                        onClick={() => pickOption(option)}
                      >
                        <span>{option.full_name}</span>
                        <span className="text-[0.75rem] text-text-secondary">
                          {option.private ? 'Private · ' : ''}
                          {formatSize(option.size_kb)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="work-on-repo-url" className="text-[0.8125rem] font-medium text-text-primary">
              Or paste a GitHub repo address
            </label>
            <div className="flex gap-2">
              <input
                id="work-on-repo-url"
                type="url"
                value={urlValue}
                placeholder="https://github.com/owner/name"
                className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-[0.8125rem] text-text-primary"
                onChange={event => setUrlValue(event.target.value)}
              />
              <Button type="button" size="small" onClick={lookUpUrl}>
                Look up
              </Button>
            </div>
          </div>
          {lookupError ? (
            <p role="alert" className="text-[0.8125rem] text-failure-bg">
              {lookupError}
            </p>
          ) : null}
          {selected ? (
            <div className="flex flex-col gap-2">
              <p className="text-[0.8125rem] text-text-primary">
                {selected.full_name} · {formatSize(selected.size_kb)}
                {selected.private ? ' · Private' : ''}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="work-on-repo-branch" className="text-[0.8125rem] font-medium text-text-primary">
                  Branch
                </label>
                <select
                  id="work-on-repo-branch"
                  value={chosenBranch}
                  className="rounded-md border border-border bg-transparent px-2 py-1 text-[0.8125rem] text-text-primary"
                  onChange={event => setChosenBranch(event.target.value)}
                >
                  {selected.branches.map(name => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <Button type="button" size="small" disabled={isRunning || chosenBranch.length === 0} onClick={start}>
                  Start work
                </Button>
              </div>
              {isRunning ? (
                <p className="text-[0.8125rem] text-text-secondary">Wait for the current reply to finish first.</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ThreadWorkOnRepoControls() {
  const api = useOptionalRepositoryWork();
  const capabilities = useServerCapabilities();
  // Without a sandbox on this server the clone can never run, so the control is left out.
  if (api == null || capabilities?.sandbox.enabled === false) {
    return null;
  }
  return <ConnectedThreadWorkOnRepoControls />;
}

function ConnectedThreadWorkOnRepoControls() {
  const aui = useAui();
  const remoteId = useAuiState(state => state.threadListItem.remoteId);
  const draft = useTrueFoundryAgentSpec();
  const isRunning = useThreadIsRunning();
  // A turn paused on the person (an approval, for one) has not finished, so it
  // still counts as running here; a turn whose work did not go through is no clone.
  const awaitingAction = useAuiState(threadTurnAwaitingAction);
  const turnFailed = useAuiState(threadTurnFailed);
  const sendMessage = useCallback(
    (text: string) => {
      aui.composer().setText(text);
      aui.composer().send();
    },
    [aui],
  );
  return (
    <WorkOnRepoControls
      sessionId={remoteId ?? null}
      isRunning={isRunning || awaitingAction}
      turnFailed={turnFailed}
      sandboxOff={chatSandboxKnownOff(draft)}
      sendMessage={sendMessage}
    />
  );
}
