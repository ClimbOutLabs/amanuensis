/**
 * Detects a GitHub git failure on an `https://github.com` command and
 * produces a host-owned remediation string for the tool result.
 *
 * GitHub credentials are available to git only through the GitHub connector
 * (see `resolveGithubGitToken`), and only for host-authenticated commands. When a clone/fetch/pull/push/ls-remote
 * against `github.com` fails in a credential- or access-shaped way, the model
 * otherwise has no signal that the connector is the missing piece and spends
 * several steps probing for keys or tokens instead.
 */

import { connectorUnavailableLine } from '../connectors/connectorAvailability';

/** The sandbox cannot tell whether GitHub is set up and only turned off, so it claims neither. */
export const GITHUB_CONNECTOR_MISSING_HINT = `GitHub credentials are available only through the GitHub connector. ${connectorUnavailableLine({ connector: 'GitHub', availability: 'unknown' })} Then retry the same command.`;

export const GITHUB_CONNECTOR_REJECTED_HINT =
  'The GitHub connector is attached but GitHub refused the credentials; the user may need to re-authorise the connector.';

/** The connector credential could not be resolved on the host; not a case of GitHub rejecting it. */
export const GITHUB_CONNECTOR_UNRESOLVED_HINT =
  'The GitHub connector is attached but no usable credential could be resolved. This is a host-side problem, not GitHub rejecting a credential; retrying the same command will not help.';

/** The host authenticates only single plain git commands, so this form ran without a credential. */
export const GITHUB_GIT_FORM_UNAUTHENTICATED_HINT =
  'The host adds GitHub credentials only to one plain git clone, fetch, pull, push or ls-remote command with a short list of flags (for example --depth, --branch, -u) and no -c, -C, env overrides, pipes or chaining. This command ran without credentials; retry it in that form.';

export const GITHUB_ACCESS_OR_MISSING_REPO_HINT =
  "GitHub reports this repository as inaccessible. The token may lack access to it, or the repository does not exist under that name; ask the user to confirm the repository URL and the connector's access.";

/** Whether the GitHub connector is attached to the session and, if so, whether a credential reached the sandbox. */
export type GithubConnectorState = 'not-attached' | 'unresolved' | 'unauthenticated-form' | 'attached';

const GITHUB_GIT_SUBCOMMAND_PATTERN = /\b(?:clone|fetch|pull|push|ls-remote)\b/i;
const GITHUB_COM_HTTPS_URL_PATTERN = /https:\/\/github\.com\//i;

// Credential-shaped failures: git never got, or had refused, a usable GitHub credential.
const GITHUB_CREDENTIAL_FAILURE_PATTERNS: readonly RegExp[] = [
  /could not read username for 'https:\/\/github\.com'/i,
  /authentication failed for 'https:\/\/github\.com\//i,
  /\b401\b/,
];

// Access-shaped failures: GitHub answered but denied access to the target repository, which a
// private repo the token cannot see and a mistyped or deleted repository both produce identically.
const GITHUB_ACCESS_FAILURE_PATTERNS: readonly RegExp[] = [/\b403\b/, /repository not found/i];

function isGithubUrlGitCommand(command: string): boolean {
  return GITHUB_GIT_SUBCOMMAND_PATTERN.test(command) && GITHUB_COM_HTTPS_URL_PATTERN.test(command);
}

/**
 * True when `command` is a git operation against an `https://github.com` URL
 * and `output` looks like a git credential failure for that command. Pure and
 * independent of whether a GitHub connector is attached.
 */
export function isGithubAuthFailure(input: { command: string; output: string }): boolean {
  return isGithubUrlGitCommand(input.command) && GITHUB_CREDENTIAL_FAILURE_PATTERNS.some(p => p.test(input.output));
}

/**
 * Returns the fixed remediation string for a failed git command, or
 * `undefined` when the failure is not GitHub-connector-shaped. Only
 * eligible for a command that actually ran (a nonzero git exit code, not a
 * sandbox infrastructure error) against a `github.com` HTTPS URL.
 */
export function getGithubConnectorHint(input: {
  command: string;
  output: string;
  connectorState: GithubConnectorState;
}): string | undefined {
  if (!isGithubUrlGitCommand(input.command)) {
    return undefined;
  }
  if (GITHUB_CREDENTIAL_FAILURE_PATTERNS.some(p => p.test(input.output))) {
    switch (input.connectorState) {
      case 'not-attached':
        return GITHUB_CONNECTOR_MISSING_HINT;
      case 'unresolved':
        return GITHUB_CONNECTOR_UNRESOLVED_HINT;
      case 'unauthenticated-form':
        return GITHUB_GIT_FORM_UNAUTHENTICATED_HINT;
      case 'attached':
        return GITHUB_CONNECTOR_REJECTED_HINT;
    }
  }
  if (GITHUB_ACCESS_FAILURE_PATTERNS.some(p => p.test(input.output))) {
    return GITHUB_ACCESS_OR_MISSING_REPO_HINT;
  }
  return undefined;
}
