export type GitConfigEntry = readonly [key: string, value: string];

/** Config that disables the keys known to run a program or recurse into submodules. */
export function gitHardeningConfigEntries(input: { workspaceRoot: string | undefined }): GitConfigEntry[] {
  return [
    ...(input.workspaceRoot === undefined ? [] : [['safe.directory', input.workspaceRoot] satisfies GitConfigEntry]),
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', '/dev/null'],
    ['core.sshCommand', ''],
    ['diff.external', ''],
    ['diff.ignoreSubmodules', 'all'],
    ['submodule.recurse', 'false'],
    ['status.submoduleSummary', 'false'],
  ];
}

const GITHUB_HTTP_SCOPE = 'http.https://github.com/';

/**
 * Extra neutralisation for git that talks to a remote. The repository's own
 * http.* keys are refused separately; these overrides, including the
 * github.com-scoped ones that beat unscoped keys, are a second layer. http.proxy
 * is deliberately absent: an empty value would drop the proxy some providers
 * need for egress.
 */
export function gitNetworkHardeningConfigEntries(): GitConfigEntry[] {
  const httpDefaults: GitConfigEntry[] = [
    ['sslVerify', 'true'],
    ['sslCAInfo', ''],
    ['sslCAPath', ''],
    ['extraHeader', ''],
    ['curloptResolve', ''],
    ['followRedirects', 'false'],
  ];
  return [
    ['core.askPass', ''],
    ['fetch.recurseSubmodules', 'false'],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ...httpDefaults.flatMap(([name, value]): GitConfigEntry[] => [
      [`http.${name}`, value],
      [`${GITHUB_HTTP_SCOPE}.${name}`, value],
    ]),
  ];
}

/**
 * Drops system, global and inherited env-injected git config so only the
 * repository's own config is in play. A zero count also ignores any inherited
 * GIT_CONFIG_KEY_* / GIT_CONFIG_VALUE_* pairs.
 */
export const GIT_HARDENING_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '0',
  GIT_CONFIG_PARAMETERS: '',
  GIT_ATTR_NOSYSTEM: '1',
};
