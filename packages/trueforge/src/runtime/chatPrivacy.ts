/**
 * Where a chat's words go: which model providers answer it, and whether any of them is off this
 * machine. The private chat banner reads this, so it errs toward "leaves": a model is local only
 * when its address is this machine itself.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { IModelProviderStore } from '../db/modelProviderStore';
import { parseModelFqn } from './sessionResources';

/** A provider that answers the chat from somewhere other than this machine. */
export interface HostedModelProvider {
  /** Adapter type, for example `anthropic` or `custom`. */
  type: string;
  /** The provider's configured name. */
  name: string;
}

export interface ChatPrivacy {
  /** True when any model that may answer the chat runs off this machine. */
  leaves_machine: boolean;
  hosted_providers: HostedModelProvider[];
}

export type ResolveHostAddresses = (hostname: string) => Promise<string[]>;

async function defaultResolveHostAddresses(hostname: string): Promise<string[]> {
  const entries = await lookup(hostname, { all: true });
  return entries.map(entry => entry.address);
}

/** Docker's name for the machine a container runs on. */
const HOST_MACHINE_NAMES: ReadonlySet<string> = new Set(['localhost', 'host.docker.internal']);

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1') {
    return true;
  }
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}

/**
 * True only when the base URL names this machine: loopback, `localhost`, or Docker's host name.
 * Another machine on the home network is not this machine, and a name that cannot be looked up
 * counts as elsewhere.
 */
export async function urlStaysOnThisMachine({
  baseUrl,
  resolveAddresses,
}: {
  baseUrl: string;
  resolveAddresses: ResolveHostAddresses;
}): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (HOST_MACHINE_NAMES.has(hostname)) {
    return true;
  }
  if (isIP(hostname) !== 0) {
    return isLoopbackAddress(hostname);
  }
  try {
    const addresses = await resolveAddresses(hostname);
    return addresses.length > 0 && addresses.every(isLoopbackAddress);
  } catch {
    return false;
  }
}

/**
 * Where the chat's words go, given every model that may answer it. A model whose provider is not
 * configured counts as hosted under its provider's name, since nothing says it is local.
 */
export async function chatPrivacy({
  tenantId,
  modelNames,
  tokenFactoryMayAnswer,
  modelProviderStore,
  resolveAddresses = defaultResolveHostAddresses,
}: {
  tenantId: string;
  modelNames: readonly string[];
  /** True when Token Factory can answer in place of the configured model. */
  tokenFactoryMayAnswer: boolean;
  modelProviderStore: Pick<IModelProviderStore, 'getProvider'>;
  resolveAddresses?: ResolveHostAddresses | undefined;
}): Promise<ChatPrivacy> {
  const hosted = new Map<string, HostedModelProvider>();
  if (tokenFactoryMayAnswer) {
    hosted.set('tokenfactory', { type: 'tokenfactory', name: 'tokenfactory' });
  }
  for (const modelName of new Set(modelNames)) {
    const parsed = parseModelFqn(modelName);
    const providerName = parsed?.providerName ?? modelName;
    if (hosted.has(providerName)) {
      continue;
    }
    const provider =
      parsed === undefined
        ? undefined
        : await modelProviderStore.getProvider({
            tenant_id: tenantId,
            name: parsed.providerName,
            model_name: parsed.modelName,
          });
    if (provider === undefined) {
      hosted.set(providerName, { type: 'custom', name: providerName });
      continue;
    }
    if (!(await urlStaysOnThisMachine({ baseUrl: provider.manifest.base_url, resolveAddresses }))) {
      hosted.set(provider.name, { type: provider.manifest.type, name: provider.name });
    }
  }
  const hostedProviders = [...hosted.values()];
  return { leaves_machine: hostedProviders.length > 0, hosted_providers: hostedProviders };
}
