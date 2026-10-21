import { createContext, useContext, type ReactNode } from 'react';

/** A repo registered with Aman, as the chat UI needs it. */
export type RepositorySummary = {
  id: string;
  name: string;
  clone_url: string;
  default_branch: string | null;
  revision: number;
};

/** One repo from the person's GitHub account, offered in the picker. */
export type GithubRepositoryOption = {
  name: string;
  full_name: string;
  clone_url: string;
  default_branch: string | null;
  size_kb: number;
  private: boolean;
};

/** One GitHub repo plus its branch names, for the picker and the branch choice. */
export type GithubRepositoryDetails = GithubRepositoryOption & {
  branches: string[];
};

/** Which repo a chat is bound to, if any. */
export type SessionRepositoryBinding = {
  session_id: string;
  repository_id: string | null;
  workspace_cwd: string | null;
};

export type RepositoryCommandPurpose = 'build' | 'test' | 'verify';

/** A command Aman found in the repo files, waiting for the person's OK. */
export type RepositoryCommandProposal = {
  id: string;
  purpose: RepositoryCommandPurpose;
  command: string;
  source_kind: string;
  source_path: string;
};

export type StartRepositoryWorkResult = {
  session_id: string;
  repository_id: string;
  workspace_cwd: string;
  branch: string;
  repository: RepositorySummary;
};

export type RepositoryWorkApi = {
  listGithubRepositories: (sessionId: string) => Promise<GithubRepositoryOption[]>;
  /** With a session id the chat's GitHub connector is used; without one only public repos answer. */
  getGithubRepository: (input: { sessionId: string | null; cloneUrl: string }) => Promise<GithubRepositoryDetails>;
  startRepositoryWork: (input: {
    sessionId: string;
    cloneUrl: string;
    branch: string;
  }) => Promise<StartRepositoryWorkResult>;
  getSessionRepository: (sessionId: string) => Promise<SessionRepositoryBinding>;
  getRepository: (repositoryId: string) => Promise<RepositorySummary>;
  listCommandProposals: (repositoryId: string) => Promise<RepositoryCommandProposal[]>;
  confirmCommandProposal: (input: {
    repositoryId: string;
    proposalId: string;
    commandId: string;
    timeoutMs: number;
  }) => Promise<void>;
  dismissCommandProposal: (input: { repositoryId: string; proposalId: string }) => Promise<void>;
  unbindSessionRepository: (sessionId: string) => Promise<void>;
};

const RepositoryWorkContext = createContext<RepositoryWorkApi | null>(null);

export function RepositoryWorkProvider({ api, children }: { api: RepositoryWorkApi; children: ReactNode }) {
  return <RepositoryWorkContext.Provider value={api}>{children}</RepositoryWorkContext.Provider>;
}

export function useOptionalRepositoryWork(): RepositoryWorkApi | null {
  return useContext(RepositoryWorkContext);
}

export function useRepositoryWork(): RepositoryWorkApi {
  const api = useContext(RepositoryWorkContext);
  if (!api) {
    throw new Error('RepositoryWorkProvider is missing.');
  }
  return api;
}
