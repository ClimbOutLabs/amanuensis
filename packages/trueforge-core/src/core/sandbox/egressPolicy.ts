/**
 * Canonical outbound network policy shared by every sandbox provider (local SRT
 * proxy today, Daytona/Nightona remote sandboxes). One list, one owner: a host
 * here is reachable from a sandbox no matter which provider created it. Each
 * provider translates the list into its own enforcement mechanism — the local
 * provider hands it to the SRT domain proxy, `DaytonaSandboxProvider` hands the
 * comma-joined form to Daytona's `domainAllowList` sandbox-creation option.
 *
 * `*.example.com` matches subdomains only, not the apex — list both explicitly.
 * Hosts cover PyPI (pip installs) and GitHub (git clone / release asset) traffic
 * that skills and agent-run commands are expected to need.
 */
export const SANDBOX_ALLOWED_EGRESS_DOMAINS = [
  'pypi.org',
  '*.pypi.org',
  'pythonhosted.org',
  'files.pythonhosted.org',
  '*.pythonhosted.org',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  '*.github.com',
  'githubusercontent.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  '*.githubusercontent.com',
] as const;

/** Daytona/Nightona `domainAllowList` takes one comma-separated string; wildcards pass through as-is. */
export function sandboxEgressDomainAllowList(): string {
  return SANDBOX_ALLOWED_EGRESS_DOMAINS.join(',');
}
