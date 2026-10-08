import { SANDBOX_ALLOWED_EGRESS_DOMAINS, sandboxEgressDomainAllowList } from '../../../src/core/sandbox/egressPolicy';

describe('sandboxEgressDomainAllowList', () => {
  it('covers PyPI and GitHub hosts, apex and wildcard both listed', () => {
    expect(SANDBOX_ALLOWED_EGRESS_DOMAINS).toContain('pypi.org');
    expect(SANDBOX_ALLOWED_EGRESS_DOMAINS).toContain('*.pypi.org');
    expect(SANDBOX_ALLOWED_EGRESS_DOMAINS).toContain('github.com');
    expect(SANDBOX_ALLOWED_EGRESS_DOMAINS).toContain('*.github.com');
  });
});
