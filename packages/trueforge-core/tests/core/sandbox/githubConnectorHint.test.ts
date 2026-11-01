import { connectorUnavailableLine } from '../../../src/core/connectors/connectorAvailability';
import {
  GITHUB_ACCESS_OR_MISSING_REPO_HINT,
  GITHUB_CONNECTOR_MISSING_HINT,
  GITHUB_CONNECTOR_REJECTED_HINT,
  GITHUB_CONNECTOR_UNRESOLVED_HINT,
  getGithubConnectorHint,
  isGithubAuthFailure,
} from '../../../src/core/sandbox/githubConnectorHint';

describe('isGithubAuthFailure', () => {
  it.each([
    [
      'could not read Username',
      'git clone https://github.com/acme/widgets',
      "fatal: could not read Username for 'https://github.com': No such device or address",
    ],
    [
      'Authentication failed',
      'git fetch https://github.com/acme/widgets',
      "fatal: Authentication failed for 'https://github.com/acme/widgets/'",
    ],
  ])('is positive on a %s error shape with a github.com URL', (_name, command, output) => {
    expect(isGithubAuthFailure({ command, output })).toBe(true);
  });

  it('is negative on a non-github URL', () => {
    expect(
      isGithubAuthFailure({
        command: 'git clone https://gitlab.com/acme/widgets',
        output: "fatal: could not read Username for 'https://gitlab.com': No such device or address",
      }),
    ).toBe(false);
  });

  it('is negative on a non-auth failure', () => {
    expect(
      isGithubAuthFailure({
        command: 'git clone https://github.com/acme/widgets',
        output: "fatal: destination path 'widgets' already exists and is not an empty directory.",
      }),
    ).toBe(false);
  });

  it('is negative on a 403 or missing-repository failure, which is access-shaped, not credential-shaped', () => {
    expect(
      isGithubAuthFailure({
        command: 'git push https://github.com/acme/widgets main',
        output:
          "remote: Permission to acme/widgets.git denied\nfatal: unable to access 'https://github.com/acme/widgets/': The requested URL returned error: 403",
      }),
    ).toBe(false);
  });

  it('is negative when the command has no git subcommand of interest', () => {
    expect(
      isGithubAuthFailure({
        command: 'curl https://github.com/acme/widgets',
        output: '401 Unauthorized',
      }),
    ).toBe(false);
  });
});

describe('getGithubConnectorHint', () => {
  const command = 'git clone https://github.com/acme/widgets';
  const credentialFailureOutput = "fatal: could not read Username for 'https://github.com': No such device or address";

  it('returns the missing-connector hint when no connector is attached', () => {
    expect(getGithubConnectorHint({ command, output: credentialFailureOutput, connectorState: 'not-attached' })).toBe(
      GITHUB_CONNECTOR_MISSING_HINT,
    );
  });

  it('builds the missing-connector hint from the shared connector line, with one place to turn it on', () => {
    expect(GITHUB_CONNECTOR_MISSING_HINT).toContain(
      connectorUnavailableLine({ connector: 'GitHub', availability: 'unknown' }),
    );
    expect(GITHUB_CONNECTOR_MISSING_HINT).not.toContain('Add-ons > Connectors');
  });

  it('returns the unresolved-credential hint when the connector is attached but no credential reached the sandbox', () => {
    expect(getGithubConnectorHint({ command, output: credentialFailureOutput, connectorState: 'unresolved' })).toBe(
      GITHUB_CONNECTOR_UNRESOLVED_HINT,
    );
  });

  it('returns the rejected-credentials hint when a resolved credential was refused', () => {
    expect(getGithubConnectorHint({ command, output: credentialFailureOutput, connectorState: 'attached' })).toBe(
      GITHUB_CONNECTOR_REJECTED_HINT,
    );
  });

  it('returns the access-or-missing-repo hint on a 403, regardless of connector state', () => {
    const output =
      "remote: Permission to acme/widgets.git denied\nfatal: unable to access 'https://github.com/acme/widgets/': The requested URL returned error: 403";
    expect(getGithubConnectorHint({ command, output, connectorState: 'attached' })).toBe(
      GITHUB_ACCESS_OR_MISSING_REPO_HINT,
    );
  });

  it('returns the access-or-missing-repo hint on a missing repository', () => {
    const output = "remote: Repository not found\nfatal: repository 'https://github.com/acme/widgets/' not found";
    expect(getGithubConnectorHint({ command, output, connectorState: 'not-attached' })).toBe(
      GITHUB_ACCESS_OR_MISSING_REPO_HINT,
    );
  });

  it('returns undefined on a 5xx, timeout, or DNS failure', () => {
    const output = "fatal: unable to access 'https://github.com/acme/widgets/': The requested URL returned error: 502";
    expect(getGithubConnectorHint({ command, output, connectorState: 'not-attached' })).toBeUndefined();
  });

  it('returns undefined when the failure is not github-auth-shaped', () => {
    expect(
      getGithubConnectorHint({
        command: 'pnpm test',
        output: 'FAIL packages/trueforge-core',
        connectorState: 'not-attached',
      }),
    ).toBeUndefined();
  });
});
