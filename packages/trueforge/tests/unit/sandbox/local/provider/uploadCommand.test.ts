import { withTrustedPath } from '@truefoundry/trueforge-core/core';
import { localSandboxUploadCommand } from '../../../../../src/sandbox/local/provider/LocalSandboxProvider';

describe('localSandboxUploadCommand', () => {
  it('creates the parent, reopens a prior 0555 file, and writes with /bin/cat on the trusted PATH', () => {
    expect(localSandboxUploadCommand('mcp-client/mcp_client.py')).toBe(
      withTrustedPath(
        "mkdir -p 'mcp-client' && { chmod u+w 'mcp-client/mcp_client.py' 2>/dev/null || true; } && /bin/cat > 'mcp-client/mcp_client.py'",
      ),
    );
  });
});
