import type {
  CreateMcpServerInput,
  DeleteMcpServerInput,
  GetMcpServerInput,
  IMcpServerStore,
  ListMcpServersInput,
  McpServerRecord,
  UpsertMcpServerInput,
} from '../db/mcpServerStore';
import type { OAuthClientRecord } from '../mcp/auth/types';
import type { McpServerManifest } from '../schemas/mcpServer';
import { isEncryptedSecret, type SecretContext } from './secretCipher';
import type { SecretVault } from './secretVault';

type Change = (input: { value: string; context: SecretContext }) => string;

function serverContext({ tenant_id, name, field }: { tenant_id: string; name: string; field: string }): SecretContext {
  return { table: 'mcp_server', primary_key: JSON.stringify([tenant_id, name]), field };
}

function clientSecretContext(id: string): SecretContext {
  return { table: 'mcp_server', primary_key: id, field: 'oauth_client.client.clientSecret' };
}

/**
 * Keeps connector header values and OAuth client secrets encrypted in the wrapped store. Callers
 * pass and get the real values. A value saved before encryption is read as it is until it is
 * encrypted in place.
 */
export class EncryptedMcpServerStore<TTransaction = never> implements IMcpServerStore<TTransaction> {
  readonly #store: IMcpServerStore<TTransaction>;
  readonly #vault: SecretVault;

  constructor({ store, vault }: { store: IMcpServerStore<TTransaction>; vault: SecretVault }) {
    this.#store = store;
    this.#vault = vault;
  }

  async listServers(input: ListMcpServersInput, transaction?: TTransaction): Promise<McpServerRecord[]> {
    return (await this.#store.listServers(input, transaction)).map(record => this.#open(record));
  }

  async getServer(input: GetMcpServerInput, transaction?: TTransaction): Promise<McpServerRecord | undefined> {
    return this.#openIfFound(await this.#store.getServer(input, transaction));
  }

  async getServerForUpdate(input: GetMcpServerInput, transaction: TTransaction): Promise<McpServerRecord | undefined> {
    return this.#openIfFound(await this.#store.getServerForUpdate(input, transaction));
  }

  async createServer(input: CreateMcpServerInput, transaction?: TTransaction): Promise<McpServerRecord> {
    return this.#open(await this.#store.createServer(this.#sealInput(input), transaction));
  }

  async upsertServer(input: UpsertMcpServerInput, transaction?: TTransaction): Promise<McpServerRecord> {
    return this.#open(await this.#store.upsertServer(this.#sealInput(input), transaction));
  }

  deleteServer(input: DeleteMcpServerInput, transaction?: TTransaction): Promise<boolean> {
    return this.#store.deleteServer(input, transaction);
  }

  async saveClient(params: { id: string; record: OAuthClientRecord }, transaction?: TTransaction): Promise<void> {
    const { clientSecret } = params.record.client;
    const record: OAuthClientRecord =
      clientSecret === null
        ? params.record
        : {
            ...params.record,
            client: {
              ...params.record.client,
              clientSecret: this.#vault.encrypt({ plaintext: clientSecret, context: clientSecretContext(params.id) }),
            },
          };
    await this.#store.saveClient({ id: params.id, record }, transaction);
  }

  async getClient(params: { id: string }, transaction?: TTransaction): Promise<OAuthClientRecord | undefined> {
    const record = await this.#store.getClient(params, transaction);
    const clientSecret = record?.client.clientSecret;
    if (
      record === undefined ||
      clientSecret === null ||
      clientSecret === undefined ||
      !isEncryptedSecret(clientSecret)
    ) {
      return record;
    }
    return {
      ...record,
      client: {
        ...record.client,
        clientSecret: this.#vault.decrypt({ value: clientSecret, context: clientSecretContext(params.id) }),
      },
    };
  }

  deleteClient(params: { id: string }, transaction?: TTransaction): Promise<void> {
    return this.#store.deleteClient(params, transaction);
  }

  #sealInput(input: CreateMcpServerInput): CreateMcpServerInput {
    return {
      ...input,
      manifest: withAuthSecrets({
        ...input,
        change: ({ value, context }) => this.#vault.encrypt({ plaintext: value, context }),
      }),
    };
  }

  #open(record: McpServerRecord): McpServerRecord {
    return {
      ...record,
      manifest: withAuthSecrets({
        ...record,
        change: ({ value, context }) => (isEncryptedSecret(value) ? this.#vault.decrypt({ value, context }) : value),
      }),
    };
  }

  #openIfFound(record: McpServerRecord | undefined): McpServerRecord | undefined {
    return record === undefined ? undefined : this.#open(record);
  }
}

function withAuthSecrets({
  tenant_id,
  name,
  manifest,
  change,
}: {
  tenant_id: string;
  name: string;
  manifest: McpServerManifest;
  change: Change;
}): McpServerManifest {
  const auth = manifest.auth;
  if (auth?.type === 'header') {
    const headers = Object.fromEntries(
      Object.entries(auth.headers).map(([header, value]) => [
        header,
        change({ value, context: serverContext({ tenant_id, name, field: `manifest.auth.headers.${header}` }) }),
      ]),
    );
    return { ...manifest, auth: { ...auth, headers } };
  }
  if (auth?.type === 'oauth_client') {
    const client_secret = change({
      value: auth.client_secret,
      context: serverContext({ tenant_id, name, field: 'manifest.auth.client_secret' }),
    });
    return { ...manifest, auth: { ...auth, client_secret } };
  }
  return manifest;
}
