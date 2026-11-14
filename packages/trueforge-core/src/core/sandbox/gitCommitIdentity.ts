import { z } from 'zod';

const NO_CONTROL_OR_ANGLE = /^[^\p{Cc}<>]*$/u;

/** The name and email written on Git commits made in the sandbox. */
export const GitCommitIdentitySchema = z.object({
  name: z.string().trim().min(1).max(100).regex(NO_CONTROL_OR_ANGLE),
  email: z
    .string()
    .trim()
    .min(3)
    .max(254)
    .regex(/^[^\s\p{Cc}<>@]+@[^\s\p{Cc}<>@]+$/u),
});

export type GitCommitIdentity = z.infer<typeof GitCommitIdentitySchema>;

/** Used when the person has not chosen a name or an email. */
export const DEFAULT_GIT_COMMIT_IDENTITY: GitCommitIdentity = { name: 'Aman', email: 'aman@localhost' };

/**
 * Git reads these before any config, so a plain `git commit` has an author. A command that sets the
 * same names in its own environment still wins, because its environment is applied after this one.
 */
export function gitCommitIdentityEnv(identity: GitCommitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

const COMMIT_IDENTITY_ENV_NAMES: ReadonlySet<string> = new Set(
  Object.keys(gitCommitIdentityEnv(DEFAULT_GIT_COMMIT_IDENTITY)),
);

/** Whether a command's environment holds anything besides the commit name every command is given. */
export function hasEnvBeyondCommitIdentity(env: Readonly<Record<string, string>> | undefined): boolean {
  return Object.keys(env ?? {}).some(name => !COMMIT_IDENTITY_ENV_NAMES.has(name));
}
