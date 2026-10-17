import { z } from '@hono/zod-openapi';
import {
  BRANCH_NAME,
  REMOTE_NAME,
  buildHostAuthenticatedGitProbe,
  parseGithubRepository,
  type GitRemoteUrl,
  type HostAuthenticatedGitExec,
  type HostAuthenticatedGitPlan,
} from './hostAuthenticatedGit';

export const GitRemotePreconditionSchema = z.object({
  remotes: z
    .array(z.object({ name: z.string().min(1), url: z.string().min(1) }))
    .min(1)
    .max(32),
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

/** The remote a bare `fetch`, `pull` or `push` contacts: the branch's configured remote, else origin. */
async function defaultRemoteName(input: { run: GitProbeRunner; workspaceRoot: string | undefined }): Promise<string> {
  const branch = (await probeLines({ ...input, gitArguments: ['symbolic-ref', '--short', '-q', 'HEAD'] }))?.[0];
  if (branch === undefined || !BRANCH_NAME.test(branch)) {
    return 'origin';
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
    case 'default':
      return [await defaultRemoteName(input)];
    case 'all':
      return probeLines({ ...input, gitArguments: ['remote'] });
  }
}

function summaryOf(remotes: readonly GitRemoteUrl[]): string {
  const list = remotes.map(remote => `${remote.name} is ${remote.url}`).join('; ');
  return `Host resolved the git remote before approval: ${list}. The command is bound to it and the credential is offered to no other repository.`;
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
  const remotes: GitRemoteUrl[] = [];
  for (const name of names) {
    const raw = (
      await probeLines({
        run: input.run,
        workspaceRoot: input.workspaceRoot,
        gitArguments: ['config', '--local', '--no-includes', '--get', `remote.${name}.url`],
      })
    )?.[0];
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
