import { registerMailConnector, registerMailConnectorAtBoot } from '../../../src/runtime/mailConnector';

const TENANT = 'tenant-1';
const URL = 'http://mail-email:9557/mcp';

function storeWith(upsertServer: jest.Mock) {
  return { upsertServer };
}

describe('Email connector registration', () => {
  it('registers nothing and writes nothing when the sidecar is not configured', async () => {
    const upsertServer = jest.fn();
    await expect(
      registerMailConnector({ url: undefined, mcpServerStore: storeWith(upsertServer), tenant_id: TENANT }),
    ).resolves.toBe('unconfigured');
    expect(upsertServer).not.toHaveBeenCalled();
  });

  it('registers the connector under the plain name Email at the sidecar endpoint', async () => {
    const upsertServer = jest.fn().mockResolvedValue(undefined);
    await expect(
      registerMailConnector({ url: URL, mcpServerStore: storeWith(upsertServer), tenant_id: TENANT }),
    ).resolves.toBe('registered');
    expect(upsertServer).toHaveBeenCalledWith({
      tenant_id: TENANT,
      name: 'Email',
      manifest: {
        type: 'remote',
        name: 'Email',
        url: URL,
        description: 'Reads, drafts and sends email from the mail accounts set up for this instance.',
      },
      first_party: true,
    });
  });

  it('a failed registration is logged and does not stop the boot', async () => {
    const failure = new Error('database is down');
    const upsertServer = jest.fn().mockRejectedValue(failure);
    const warn = jest.fn();
    await expect(
      registerMailConnectorAtBoot({
        url: URL,
        mcpServerStore: storeWith(upsertServer),
        tenant_id: TENANT,
        logger: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Email connector could not be registered', expect.anything());
  });
});
