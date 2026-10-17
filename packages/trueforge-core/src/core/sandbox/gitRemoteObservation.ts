import { z } from '@hono/zod-openapi';
import {
  BRANCH_NAME,
  buildHostAuthenticatedGitProbe,
  GitRemoteSchema,
  parseGithubRepository,
  REMOTE_NAME,
  type GitRemote,
  type HostAuthenticatedGitExec,
  type HostAuthenticatedGitPlan,
} from './hostAuthenticatedGit';

export const GitRemotePreconditionSchema = z.object({
  remotes: z.array(GitRemoteSchema).min(1).max(32),
  summary: z.string().min(1),
});

/** The GitHub repositories a remote-named network git command would contact, as the host saw them before approval. */
export type GitRemotePrecondition = z.infer<typeof GitRemotePreconditionSchema>;

/** Runs a token-free probe in the sandbox; its output on success, undefined when it could not be run or failed. */
export type GitProbeRunner = (probe: HostAuthenticatedGitExec) => Promise<string | undefined>;

/** A command that names its repository by URL carries it in its own text; every other form must be observed. */
export function remoteObservationRequired(plan: HostAuthenticatedGitPlan): boolean {
  return plan.remote.kind !== 'url';
}

function lines(output: string): string[] {
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
}

async function probeLines(input: {
  run: GitProbeRunner;
  workspaceRoot: string | undefined;
  gitArguments: readonly string[];
}): Promise<string[] | undefined> {
  const output = await input.run(
    buildHostAuthenticatedGitProbe({ gitArguments: input.gitArguments, workspaceRoot: input.workspaceRoot }),
  );
  return output === undefined ? undefined : lines(output);
}

/**
 * The remote a bare `fetch`, `pull` or `push` contacts: the branch's configured remote, else origin, which is
 * also what git uses on a detached HEAD. Undefined for a branch whose remote cannot be safely looked up, so the
 * card never names a guess.
 */
async function defaultRemoteName(input: {
  run: GitProbeRunner;
  workspaceRoot: string | undefined;
}): Promise<string | undefined> {
  const branch = (await probeLines({ ...input, gitArguments: ['symbolic-ref', '--short', '-q', 'HEAD'] }))?.[0];
  if (branch === undefined) {
    return 'origin';
  }
  if (!BRANCH_NAME.test(branch)) {
    return undefined;
  }
  const configured = (
    await probeLines({
      ...input,
      gitArguments: ['config', '--local', '--no-includes', '--get', `branch.${branch}.remote`],
    })
  )?.[0];
  return configured ?? 'origin';
}

async function remoteNames(input: {
  plan: HostAuthenticatedGitPlan;
  run: GitProbeRunner;
  workspaceRoot: string | undefined;
}): Promise<string[] | undefined> {
  switch (input.plan.remote.kind) {
    case 'url':
      return [];
    case 'named':
      return [input.plan.remote.name];
    case 'default': {
      const name = await defaultRemoteName(input);
      return name === undefined ? undefined : [name];
    }
    case 'all':
      return probeLines({ ...input, gitArguments: ['remote'] });
  }
}

/**
 * Fetch uses a remote's first url and push uses every one, so only a remote with exactly one value, empty ones
 * included, has an address the card can truthfully name.
 */
function singleValue(output: string | undefined): string | undefined {
  const values = output?.replace(/\r?\n$/u, '').split(/\r?\n/u);
  return values?.length === 1 ? values[0] : undefined;
}

function summaryOf(remotes: readonly GitRemote[]): string {
  const named = remotes.map(remote => `${remote.name}, which is ${remote.url}`);
  const list = named.length > 1 ? `${named.slice(0, -1).join(', ')}, and ${named.slice(-1).join('')}` : named.join('');
  const scope = remotes.length === 1 ? 'this repository' : 'these repositories';
  return `This uses ${list}. Your GitHub sign-in is only offered to ${scope}.`;
}

/**
 * Resolves, on the host and without credentials, the GitHub repositories the command would contact. Undefined
 * when any of them is unknown, is not a plain github.com repository, or cannot be read: such a command is not
 * authenticated at all, so a repointed remote can never carry the token elsewhere.
 */
export async function observeGitRemotes(input: {
  plan: HostAuthenticatedGitPlan;
  run: GitProbeRunner;
  workspaceRoot: string | undefined;
}): Promise<GitRemotePrecondition | undefined> {
  const names = await remoteNames(input);
  if (names === undefined || names.length === 0 || names.length > 32 || !names.every(name => REMOTE_NAME.test(name))) {
    return undefined;
  }
  const remotes: GitRemote[] = [];
  for (const name of names) {
    const raw = singleValue(
      await input.run(
        buildHostAuthenticatedGitProbe({
          gitArguments: ['config', '--local', '--no-includes', '--get-all', `remote.${name}.url`],
          workspaceRoot: input.workspaceRoot,
        }),
      ),
    );
    const repository = raw === undefined ? undefined : parseGithubRepository(raw);
    if (repository === undefined) {
      return undefined;
    }
    remotes.push({ name, url: repository.canonical });
  }
  return GitRemotePreconditionSchema.parse({ remotes, summary: summaryOf(remotes) });
}

/** True when the remotes seen now are exactly those the user was shown. */
export function gitRemotesMatch(input: { approved: GitRemotePrecondition; current: GitRemotePrecondition }): boolean {
  const key = (precondition: GitRemotePrecondition): string =>
    JSON.stringify([...precondition.remotes].sort((left, right) => (left.name < right.name ? -1 : 1)));
  return key(input.approved) === key(input.current);
}
